"""
Open-Meteo Historical Weather (Archive) API client — free, no API key
required: https://open-meteo.com/en/docs/historical-weather-api

Used only as an *optional* enrichment for Compare Cities: given a city's
coordinates and a single stored calendar day (typically a hottest/coolest
day already found in historical_heat_data), fetch that day's weather
context (rainfall, sky condition, temperature range, "feels like",
wind, hours of precipitation) so the comparison can say *something*
about why a day ran hot or cool, not just that it did.

Deliberately fails soft — any network error, timeout, non-200, or
malformed payload returns None rather than raising. historical_heat_data
(seeded via FortyGuard) stays the source of truth for temperature/
exceedance/persistence; Open-Meteo is only ever an add-on caption, so a
slow or unreachable Open-Meteo must never break the comparison feature
itself, it should just mean that one line doesn't render.
"""
import asyncio

import httpx

from .logger import log_req, log_res, log_err

BASE_URL = "https://archive-api.open-meteo.com/v1/archive"
# UV index isn't part of the historical Archive/reanalysis dataset at
# all (ERA5 doesn't model it) — it only exists on the live Forecast API,
# GFS-based. The Historical Forecast API mirrors that same Forecast API
# format/variables but archived, with coverage from ~2022 onward, which
# covers every date this app's seeded historical_heat_data can contain.
# Queried separately (and optionally) from the main archive call above
# since it's a different backing dataset that can be unavailable for a
# given date without that meaning anything else failed.
UV_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast"
TIMEOUT_SECONDS = 6.0

# Open-Meteo's WMO weather codes, collapsed to a short human phrase —
# see "WMO Weather interpretation codes" at https://open-meteo.com/en/docs
_WEATHER_CODE_PHRASES = {
    0: "clear skies", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    56: "freezing drizzle", 57: "heavy freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    66: "freezing rain", 67: "heavy freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light rain showers", 81: "rain showers", 82: "heavy rain showers",
    85: "light snow showers", 86: "heavy snow showers",
    95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms with hail",
}


def _phrase_for_code(code) -> str | None:
    if code is None:
        return None
    return _WEATHER_CODE_PHRASES.get(int(code), "mixed conditions")


def _c_to_f(c):
    return round(c * 9 / 5 + 32, 1) if c is not None else None


def _first(values):
    return values[0] if values and values[0] is not None else None


# Simple, transparent thresholds used to turn the raw daily aggregates
# below into a short list of human tags ("windy", "humid", "cloudy",
# "clear") — a quick-scan complement to the numeric fields, in the same
# spirit as a consumer forecast widget's condition blurb.
_WINDY_MPH = 15
_HUMID_PCT = 70
_CLOUDY_PCT = 60
_CLEAR_PCT = 25


def _derive_tags(wind_mph, gusts_mph, humidity_pct, cloud_pct, precip_mm):
    tags = []
    if (wind_mph is not None and wind_mph >= _WINDY_MPH) or (gusts_mph is not None and gusts_mph >= _WINDY_MPH + 5):
        tags.append("windy")
    if humidity_pct is not None and humidity_pct >= _HUMID_PCT:
        tags.append("humid")
    if cloud_pct is not None:
        if cloud_pct >= _CLOUDY_PCT:
            tags.append("cloudy")
        elif cloud_pct <= _CLEAR_PCT and not (precip_mm and precip_mm > 0):
            tags.append("clear")
    return tags


async def _fetch_archive(lat: float, lon: float, date_str: str) -> dict | None:
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": date_str,
        "end_date": date_str,
        "daily": (
            "precipitation_sum,precipitation_hours,weathercode,"
            "temperature_2m_max,temperature_2m_min,"
            "apparent_temperature_max,windspeed_10m_max,"
            "windgusts_10m_max,winddirection_10m_dominant,"
            "relative_humidity_2m_max,dew_point_2m_mean,"
            "cloud_cover_mean,sunshine_duration"
        ),
        "temperature_unit": "fahrenheit",
        "windspeed_unit": "mph",
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient() as client:
            log_req("GET Open-Meteo archive", {"date": date_str, "lat": lat, "lon": lon})
            for attempt in range(2):
                try:
                    resp = await client.get(BASE_URL, params=params, timeout=TIMEOUT_SECONDS)
                    if resp.status_code != 200:
                        log_err("Open-Meteo archive non-200", {"status": resp.status_code, "date": date_str, "attempt": attempt})
                        if attempt == 0:
                            await asyncio.sleep(0.4)
                            continue
                        return None
                    return resp.json()
                except httpx.TimeoutException:
                    if attempt == 0:
                        await asyncio.sleep(0.4)
                        continue
                    raise
    except (httpx.HTTPError, ValueError) as exc:
        log_err("Open-Meteo archive failed", {"date": date_str, "error": str(exc)})
        return None


async def _fetch_uv_index(lat: float, lon: float, date_str: str) -> float | None:
    """UV index isn't in the archive dataset (see UV_URL comment above) —
    queried separately from the Historical Forecast API. Soft-fails to
    None for dates outside that archive's ~2022+ coverage or any other
    hiccup; the rest of the weather context still renders without it."""
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": date_str,
        "end_date": date_str,
        "daily": "uv_index_max",
        "timezone": "auto",
    }
    try:
        async with httpx.AsyncClient() as client:
            log_req("GET Open-Meteo historical-forecast (UV)", {"date": date_str, "lat": lat, "lon": lon})
            resp = await client.get(UV_URL, params=params, timeout=TIMEOUT_SECONDS)
            if resp.status_code != 200:
                return None
            data = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    uv = _first((data.get("daily") or {}).get("uv_index_max"))
    return round(uv, 1) if uv is not None else None


async def fetch_daily_weather(lat: float, lon: float, date_str: str) -> dict | None:
    """One exact calendar day's weather context for (lat, lon): rain
    total + sky condition, max/min temperature, a "feels like" (apparent
    temperature) max, peak wind speed/gusts/direction, dew point,
    humidity, cloud cover, sunshine hours, hours of measurable
    precipitation, and (when the Historical Forecast API has it) a UV
    index — everything here comes from Open-Meteo, free and keyless.
    Also derives a short list of human tags (windy/humid/cloudy/clear)
    from those numbers so the UI has something to badge with beyond a
    bare WMO code phrase. Returns None on any failure — see module
    docstring."""
    data, uv_index_max = await asyncio.gather(
        _fetch_archive(lat, lon, date_str),
        _fetch_uv_index(lat, lon, date_str),
    )
    if data is None:
        return None

    daily = data.get("daily") or {}
    precip = daily.get("precipitation_sum") or []
    codes = daily.get("weathercode") or []
    if not precip or precip[0] is None:
        return None

    wind_max_mph = _first(daily.get("windspeed_10m_max"))
    wind_gusts_max_mph = _first(daily.get("windgusts_10m_max"))
    wind_direction_deg = _first(daily.get("winddirection_10m_dominant"))
    humidity_max_pct = _first(daily.get("relative_humidity_2m_max"))
    dew_point_f = _first(daily.get("dew_point_2m_mean"))
    cloud_cover_pct = _first(daily.get("cloud_cover_mean"))
    sunshine_seconds = _first(daily.get("sunshine_duration"))

    log_res("Open-Meteo archive", {"date": date_str, "precipitation_mm": precip[0]})
    return {
        "precipitation_mm": round(float(precip[0]), 1),
        "condition": _phrase_for_code(codes[0] if codes else None),
        "precipitation_hours": _first(daily.get("precipitation_hours")),
        "temp_max_f": _first(daily.get("temperature_2m_max")),
        "temp_min_f": _first(daily.get("temperature_2m_min")),
        "feels_like_max_f": _first(daily.get("apparent_temperature_max")),
        "wind_max_mph": wind_max_mph,
        "wind_gusts_max_mph": wind_gusts_max_mph,
        "wind_direction_deg": wind_direction_deg,
        "humidity_max_pct": round(humidity_max_pct) if humidity_max_pct is not None else None,
        "dew_point_f": round(dew_point_f) if dew_point_f is not None else None,
        "cloud_cover_pct": round(cloud_cover_pct) if cloud_cover_pct is not None else None,
        "sunshine_hours": round(sunshine_seconds / 3600, 1) if sunshine_seconds is not None else None,
        "uv_index_max": uv_index_max,
        "tags": _derive_tags(wind_max_mph, wind_gusts_max_mph, humidity_max_pct, cloud_cover_pct, precip[0]),
    }


# Fetching N cities' weather naively (N parallel calls to fetch_daily_weather,
# each of which is itself 2 upstream requests — archive + UV) means N*2
# simultaneous requests to Open-Meteo. At N=6 that's 12 at once, launched
# from a single burst (every selected city, same instant) — enough to trip
# Open-Meteo's keyless-usage rate limiting, so some cities silently come
# back as "unavailable" while others succeed. A semaphore here caps how
# many CITIES are in flight at once (each still fires its 2 sub-requests),
# keeping worst-case concurrent upstream requests bounded regardless of
# how many cities the comparison has selected.
_MAX_CONCURRENT_CITIES = 3


async def fetch_daily_weather_many(
    cities: list[dict], date_str: str
) -> dict[str, dict | None]:
    """`cities` is a list of {"id", "lat", "lon"} dicts. Returns
    {city_id: fetch_daily_weather(...) result} — None entries mean that
    city's weather context wasn't available, same soft-fail contract as
    the single-city function."""
    semaphore = asyncio.Semaphore(_MAX_CONCURRENT_CITIES)

    async def _one(city: dict):
        async with semaphore:
            result = await fetch_daily_weather(city["lat"], city["lon"], date_str)
            return city["id"], result

    pairs = await asyncio.gather(*(_one(c) for c in cities))
    return dict(pairs)
