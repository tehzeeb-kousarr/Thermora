"""
Phase 11 — Heat Story.

Reads Phase 5's location_features for a city/date and produces a
structured observed/coverage bundle. This module is READ-ONLY against
Postgres — opening Heat Story never triggers a FortyGuard request (see
routers/heat_story.py's GET /{city_id}, which is the only thing this
module backs). Missing observed hours and forecast hours are only ever
fetched after an explicit, consent-gated frontend action that calls
repository.start_heatmap() directly — this module does not submit
anything to FortyGuard itself.

No new tables. Reuses exactly what Phase 5/6 already built:
  - location_features  (Phase 5)  — the only source for "observed" data
  - exposure_repository (Phase 6) — the "why it matters" exposure counts
"""
from datetime import date as date_cls, datetime, timedelta

from . import exposure_repository
from .config import settings
from .db import get_pool
from .location_features import DAY_SENTINEL
from .locations import city_local_now, local_today
from .logger import log_err

# The window Heat Story tracks per day, in each city's OWN local time
# (see locations.py's `timezone` field) — NOT raw UTC hour. Every US
# monitored city is 5-8 hours behind UTC, so anchoring this to UTC meant
# expected_hours() returned an empty list outright for a large chunk of
# each real evening (whenever the current UTC hour fell before
# START_HOUR, `end < START_HOUR` below), which is exactly what "0 of 0
# expected hours" looked like in production. A day boundary and an
# hour-of-day both only mean something relative to wall-clock time
# somewhere specific — for a city dashboard, that's the city, not UTC.
#
# Full calendar day (00:00-23:00) — was previously 6-20 (a daytime-only
# window). Widening this to the full day doesn't touch
# FORECAST_HORIZON_HOURS below at all; that's computed independently off
# city_local_now(), not off START_HOUR/END_HOUR.
START_HOUR = 1
END_HOUR = 23

# FortyGuard's forecast product is only valid up to 12 hours ahead of "now"
# — requesting further out than that isn't a real forecast. The frontend
# (HeatStoryView.jsx's forecastCandidates) already caps its own proposed
# hours to this same window; this is the server-side backstop so the
# fetch-forecast endpoint can't be made to submit a stale/meaningless
# request regardless of what a client sends.
FORECAST_HORIZON_HOURS = 12


def _hour_str(hour: int) -> str:
    return f"{hour:02d}:00"


def is_within_forecast_horizon(city: dict, feature_date: date_cls, hour: str) -> bool:
    """Whether `hour` on `feature_date` is a genuine forecast candidate for
    this city right now: the CURRENT in-progress local hour, or strictly
    after it, and no more than FORECAST_HORIZON_HOURS ahead (FortyGuard's
    own limit).

    The current hour is included on purpose, even though it's technically
    "now" rather than purely future: expected_hours() above stops at the
    LAST FULLY COMPLETED hour, since an observed reading for the current
    hour isn't available until it elapses. Without this, the current hour
    fell into a gap — too soon to be "observed", but excluded here for
    being "the present, not the future" — so it showed neither an
    observed reading nor a forecast option at all. Comparing by calendar
    hour (not exact datetime) is what actually makes this work: `target`
    is always HH:00:00, so once "now" is past that hour's own :00 mark, a
    naive `now < target` is already false for the current hour regardless
    — the fix has to check hour-of-day equality, not just chronological
    ordering."""
    now = city_local_now(city)
    target = datetime.combine(
        feature_date, datetime.strptime(hour, "%H:%M").time(), tzinfo=now.tzinfo
    )
    is_current_hour = target.date() == now.date() and target.hour == now.hour
    return is_current_hour or (now < target <= now + timedelta(hours=FORECAST_HORIZON_HOURS))


def is_completed_hour(city: dict, feature_date: date_cls, hour: str) -> bool:
    """Whether `hour` on `feature_date` has already fully elapsed for this
    city — i.e. is safe to treat as a genuine OBSERVATION rather than
    "now" (still in progress) or the future. The mirror-image question to
    is_within_forecast_horizon above: that asks "is this a valid forecast
    target", this asks "is this a valid observed-data target" — and the
    current in-progress hour is excluded from BOTH, since it's neither a
    completed observation nor genuinely in the future yet. Used by the
    agent's fetch_live_conditions tool to refuse a current/future hour
    outright rather than silently fetching a prediction and persisting it
    into location_features as if it were real observed data (see
    agent.py's own comment on why that would be a real bug)."""
    now = city_local_now(city)
    target = datetime.combine(
        feature_date, datetime.strptime(hour, "%H:%M").time(), tzinfo=now.tzinfo
    )
    return target < now.replace(minute=0, second=0, microsecond=0)


# city_local_now / local_today now live in locations.py (imported at the
# top of this file) — see that module for why: this used to be defined
# only here, and every OTHER module that needed "today" for a city
# (scheduler.py, routers/risk.py, routers/impact.py, routers/emergency.py)
# independently called bare date.today() instead, which could name a
# different calendar day than this file's (correct) city-local one.


def expected_hours(city: dict, feature_date: date_cls) -> list[str]:
    """Which hours Heat Story considers "in scope" for this date, in the
    CITY's local calendar day and local hour — not the server's/UTC's.
    For today (the city's local today), stops at the LAST FULLY COMPLETED
    local hour, not the current one still in progress: FortyGuard's
    "observed" reading for a given hour is that hour's satellite pass,
    which isn't actually available until the hour itself has elapsed — at
    local 14:37, 14:00 has no observation yet and 13:00 is the newest hour
    that could possibly have one. Treating 14:00 as "expected, currently
    missing" at 14:37 was wrong; it hadn't happened yet, and would show a
    real hour as a data gap for the ~59 minutes before it could ever be
    filled. For a past local date, the full day is all
    "expected", since every hour of a past day has already elapsed."""
    end = END_HOUR
    if feature_date == local_today(city):
        end = min(END_HOUR, city_local_now(city).hour - 1)
    if end < START_HOUR:
        return []
    return [_hour_str(h) for h in range(START_HOUR, end + 1)]


async def get_observed_hours(city: dict, feature_date: date_cls) -> list[dict]:
    """One entry per expected hour (see expected_hours above). Section 11's
    rule: an hour "exists" if temperature data exists — heat index/wet-bulb/
    humidity/AQI may independently be missing without the whole hour being
    treated as missing (those come from a separate env-params fetch, not
    the tcm heatmap fetch that produces temperature)."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT feature_hour, mean_temp_c, max_temp_c, min_temp_c,
               heat_index_c, wet_bulb_c, humidity_pct, aqi
        FROM location_features
        WHERE city_id = $1 AND feature_date = $2 AND feature_hour <> $3
        """,
        city["id"], feature_date, DAY_SENTINEL,
    )
    by_hour = {r["feature_hour"]: dict(r) for r in rows}

    out = []
    for hour in expected_hours(city, feature_date):
        row = by_hour.get(hour)
        temp = row.get("mean_temp_c") if row else None
        out.append({
            "hour": hour,
            "exists": temp is not None,
            "temperature": temp,
            "max_temperature": row.get("max_temp_c") if row else None,
            "min_temperature": row.get("min_temp_c") if row else None,
            "heat_index": row.get("heat_index_c") if row else None,
            "wet_bulb": row.get("wet_bulb_c") if row else None,
            "humidity": row.get("humidity_pct") if row else None,
            "aqi": row.get("aqi") if row else None,
        })
    return out


async def compute_coverage(city: dict, feature_date: date_cls) -> dict:
    """Section 13's coverage endpoint shape — an honest picture of how
    complete today's (or any date's) observed record actually is, split
    into the one field that defines "the hour exists" (temperature) and
    the optional environmental fields that may or may not ride along
    with it."""
    observed = await get_observed_hours(city, feature_date)
    expected = len(observed)
    available = [o for o in observed if o["exists"]]
    missing = [o["hour"] for o in observed if not o["exists"]]

    def optional_count(key: str) -> int:
        return sum(1 for o in available if o.get(key) is not None)

    return {
        "date": feature_date.isoformat(),
        "temperature": {
            "expected_hours": expected,
            "available_hours": len(available),
            "missing_hours": missing,
            "coverage_percent": round(len(available) / expected * 100, 1) if expected else 0.0,
        },
        "optional_features": {
            "heat_index": {"available_hours": optional_count("heat_index")},
            "humidity": {"available_hours": optional_count("humidity")},
            "wet_bulb": {"available_hours": optional_count("wet_bulb")},
            "aqi": {"available_hours": optional_count("aqi")},
        },
    }


async def get_exposure_summary(city: dict) -> dict | None:
    """Feeds Heat Story's "why it matters" section. Reads whatever's
    already cached for Phase 6/9's unified AOI (see
    exposure_repository.default_bbox_for_city) — never forces a fresh
    Overpass/Geoapify call on Heat Story's behalf; a transient failure
    here just means the narrative has no exposure context, not a broken
    page."""
    bbox = exposure_repository.default_bbox_for_city(city)
    try:
        exposure = await exposure_repository.get_exposure(
            bbox["min_lat"], bbox["min_lng"], bbox["max_lat"], bbox["max_lng"], force_refresh=False,
        )
    except Exception as exc:  # noqa: BLE001 - exposure being unavailable must not break Heat Story
        log_err("Heat Story: exposure read failed", {"city": city["id"], "error": str(exc)})
        return None
    if not exposure:
        return None
    points = exposure.get("points") or []
    density = exposure.get("density") or {}
    return {
        "schools": sum(1 for p in points if p.get("type") == "school"),
        "hospitals": sum(1 for p in points if p.get("type") == "hospital"),
        "buildings": density.get("building_count"),
    }


def tcm_payload_for_hour(city: dict, feature_date: date_cls, hour: str) -> dict:
    """Same AOI (Phase 6/9's unified box, see scheduler.py's own comment
    on why there's exactly one AOI function) and the same tcm payload
    shape as scheduler.py's _heatmap_payload — a single hour's
    temperature for this city. Kept in that exact shape so a Heat Story
    fetch and a normal scheduler/Dashboard tcm fetch for the identical
    city/date/hour are genuinely the same cached request, not two
    different ones with two different signatures.

    Used for BOTH "fetch missing observed hour" (persist=True, the
    default) and "fetch forecast hour" (persist=False) — the only
    difference between the two is which `persist` value the caller passes
    to repository.start_heatmap, not the payload itself. Whether a given
    hour is "missing" or "forecast" is a caller-side distinction (past/now
    vs future relative to when it's requested); this function just builds
    the request for one hour."""
    bbox = exposure_repository.default_bbox_for_city(city)
    return {
        "polygon_aoi": {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature", "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[
                    [bbox["min_lng"], bbox["min_lat"]], [bbox["max_lng"], bbox["min_lat"]],
                    [bbox["max_lng"], bbox["max_lat"]], [bbox["min_lng"], bbox["max_lat"]],
                    [bbox["min_lng"], bbox["min_lat"]],
                ]]},
            }],
        },
        "date_time": {"start_date": feature_date.isoformat(), "filter_type": 1, "start_time": hour},
        "granularity": settings.SUMMARY_GRANULARITY,
        "analytic_type": "tcm",
        "threshold": 30,
        "direction": "above",
    }


async def record_forecast_hours(city_id: str, feature_date: date_cls, hours: list[dict]) -> None:
    """Logs a forecast fetch the user explicitly requested into its OWN
    table (heat_story_forecasts) — see that table's DDL comment in db.py
    for why this is never location_features. `hours` is
    [{"hour": "16:00", "temperature": 36.2}, ...] straight from what the
    frontend already read off the completed forecast job(s); entries with
    no temperature (a job that came back without real data) are skipped
    rather than logging a meaningless null row. Never raises — a forecast
    the user can already see on screen shouldn't disappear from the UI
    just because logging it failed; log_err and move on."""
    rows = [h for h in hours if h.get("temperature") is not None]
    if not rows:
        return
    pool = get_pool()
    try:
        await pool.executemany(
            """
            INSERT INTO heat_story_forecasts (city_id, feature_date, feature_hour, temperature_c)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (city_id, feature_date, feature_hour)
            DO UPDATE SET temperature_c = EXCLUDED.temperature_c, fetched_at = now()
            """,
            [(city_id, feature_date, h["hour"], h["temperature"]) for h in rows],
        )
    except Exception as exc:  # noqa: BLE001 - logging a forecast must never break showing it
        log_err("Heat Story: failed to record forecast hours", {"city": city_id, "error": str(exc)})


async def get_recorded_forecast_hours(city_id: str, feature_date: date_cls) -> list[dict]:
    """Reads back whatever record_forecast_hours above has ever logged for
    this city/date — the read half of that write-only function. Without
    this, a forecast the user already fetched only ever lived in
    HeatStoryView's own component state, so navigating away and back (or
    switching tabs, which unmounts it) made an already-fetched forecast
    look like it had never been requested at all, even though
    heat_story_forecasts had it the whole time. Returns
    [{"hour": "16:00", "temperature": 36.2}, ...], oldest-fetched hour
    first is NOT guaranteed — sorted by hour string instead, matching how
    HeatStoryView already orders forecast entries everywhere else."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT feature_hour, temperature_c FROM heat_story_forecasts
        WHERE city_id = $1 AND feature_date = $2
        ORDER BY feature_hour
        """,
        city_id, feature_date,
    )
    return [{"hour": r["feature_hour"], "temperature": r["temperature_c"]} for r in rows]