from datetime import date

from fastapi import APIRouter, HTTPException, Query

from .. import historical_repository as repo
from .. import open_meteo_client
from ..locations import MONITORED_CITIES

router = APIRouter(prefix="/api/historical", tags=["historical"])

VALID_ANALYTIC_TYPES = {"tcm", "exceedance", "persistence"}
KNOWN_CITY_IDS = {c["id"] for c in MONITORED_CITIES}


def _parse_city_ids(city_ids: str) -> list[str]:
    ids = [c.strip() for c in city_ids.split(",") if c.strip()]
    if not ids:
        raise HTTPException(status_code=400, detail="city_ids must include at least one city")
    unknown = [c for c in ids if c not in KNOWN_CITY_IDS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown city id(s): {unknown}")
    return ids


@router.get("/available-months")
async def available_months():
    return {"months": await repo.get_available_months()}


@router.get("/available-dates")
async def available_dates(
    month: str | None = Query(None, description="Optional YYYY-MM filter, e.g. 2026-07"),
):
    return {"dates": await repo.get_available_dates(month)}


@router.get("/latest")
async def latest(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
):
    ids = _parse_city_ids(city_ids)
    return await repo.get_latest_snapshot(ids)


@router.get("/comparison")
async def comparison(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
    analytic_type: str = Query("tcm", description="tcm | exceedance | persistence"),
    months: int = Query(12, ge=1, le=36, description="Used when months_list is not given"),
    months_list: str | None = Query(
        None,
        description="Comma-separated YYYY-MM values, e.g. 2026-03,2026-06,2026-07 — "
                    "overrides `months` when given, letting arbitrary/non-consecutive "
                    "months be compared instead of only a trailing window.",
    ),
):
    if analytic_type not in VALID_ANALYTIC_TYPES:
        raise HTTPException(status_code=400, detail=f"analytic_type must be one of {sorted(VALID_ANALYTIC_TYPES)}")

    ids = _parse_city_ids(city_ids)

    parsed_months_list = None
    if months_list:
        parsed_months_list = [m.strip() for m in months_list.split(",") if m.strip()]

    return await repo.get_monthly_comparison(
        ids, analytic_type, months_back=months, months_list=parsed_months_list
    )


@router.get("/temperature-profile")
async def temperature_profile(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
    months: int = Query(12, ge=1, le=36, description="Used when months_list is not given"),
    months_list: str | None = Query(
        None,
        description="Comma-separated YYYY-MM values — same override rule as /comparison.",
    ),
):
    """Mean/Max/Min/StdDev trend graph — replaces the old card-based
    'Latest Stored Snapshot' with a proper time series, same stored
    historical_heat_data source, tcm only."""
    ids = _parse_city_ids(city_ids)
    parsed_months_list = None
    if months_list:
        parsed_months_list = [m.strip() for m in months_list.split(",") if m.strip()]
    return await repo.get_temperature_profile_monthly(ids, months_back=months, months_list=parsed_months_list)


@router.get("/temperature-profile-by-date")
async def temperature_profile_by_date(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
    date_str: str = Query(..., alias="date", description="YYYY-MM-DD"),
):
    """Table counterpart of /temperature-profile for one exact date."""
    ids = _parse_city_ids(city_ids)
    try:
        feature_date = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    return await repo.get_temperature_profile_date(ids, feature_date)


@router.get("/by-date")
async def by_date(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
    date_str: str = Query(..., alias="date", description="YYYY-MM-DD"),
):
    ids = _parse_city_ids(city_ids)
    try:
        feature_date = date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")
    return await repo.get_date_comparison(ids, feature_date)


@router.get("/extremes")
async def extremes(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
    months: int = Query(12, ge=1, le=36, description="Used when months_list is not given"),
    months_list: str | None = Query(
        None,
        description="Comma-separated YYYY-MM values — same override rule as /comparison.",
    ),
):
    ids = _parse_city_ids(city_ids)
    parsed_months_list = None
    if months_list:
        parsed_months_list = [m.strip() for m in months_list.split(",") if m.strip()]
    return await repo.get_extremes(ids, months_back=months, months_list=parsed_months_list)


@router.get("/weather-context")
async def weather_context(
    city_id: str = Query(..., description="Single city id, e.g. houston"),
    date_str: str = Query(..., alias="date", description="YYYY-MM-DD"),
):
    """Optional enrichment, not stored data: live-fetches that one day's
    rainfall + sky condition from Open-Meteo (free, no key) for the given
    city/date — used to caption *why* a hottest/coolest day (or a chosen
    specific date) looked the way it did. Never touches FortyGuard or
    historical_heat_data; `available: false` just means Open-Meteo didn't
    have an answer right now, not that anything is broken."""
    if city_id not in KNOWN_CITY_IDS:
        raise HTTPException(status_code=400, detail=f"Unknown city id: {city_id}")
    try:
        date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")

    city = next(c for c in MONITORED_CITIES if c["id"] == city_id)
    result = await open_meteo_client.fetch_daily_weather(city["lat"], city["lon"], date_str)
    if result is None:
        return {"available": False}
    return {"available": True, **result}


@router.get("/weather-context-batch")
async def weather_context_batch(
    city_ids: str = Query(..., description="Comma-separated city ids, e.g. houston,austin,phoenix"),
    date_str: str = Query(..., alias="date", description="YYYY-MM-DD"),
):
    """Same data as /weather-context, but for every requested city in one
    HTTP round trip instead of one call per city. Firing N separate
    /weather-context requests from the browser (one per selected city)
    hits two limits at once: the browser's own per-origin concurrent-
    connection cap, and — since each city fetch is itself 2 upstream
    Open-Meteo calls (archive + UV) — Open-Meteo's keyless rate limiting
    once N gets past a handful of cities, which silently drops some
    cities' cards. This endpoint does the fan-out server-side instead,
    behind a concurrency cap (see open_meteo_client._MAX_CONCURRENT_CITIES),
    so the browser only ever makes one request no matter how many cities
    are selected."""
    ids = _parse_city_ids(city_ids)
    try:
        date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(status_code=400, detail="date must be in YYYY-MM-DD format")

    cities = [
        {"id": c["id"], "lat": c["lat"], "lon": c["lon"]}
        for c in MONITORED_CITIES if c["id"] in ids
    ]
    results = await open_meteo_client.fetch_daily_weather_many(cities, date_str)
    return {
        "results": {
            city_id: ({"available": True, **result} if result is not None else {"available": False})
            for city_id, result in results.items()
        }
    }
