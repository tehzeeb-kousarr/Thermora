"""
On-demand city summary loader.

Used to be a background scheduler that eagerly pre-warmed EVERY monitored
city's temperature/env/alerts summary on a fixed timer, regardless of
whether anyone was actually looking at them — burning FortyGuard requests
for cities nobody had opened.

Now: refresh_city_summary() is called lazily, ONE city at a time, only
when routers/cities.py's /latest endpoint sees a missing-or-stale
live_cache entry for that specific city. Nothing is fetched until a user
actually selects that location.

The old always-on loop (start/stop, looping over MONITORED_CITIES forever)
is kept below, OFF by default (ENABLE_SCHEDULER=false), only for a
deployment that explicitly wants the old eager-refresh-everything behavior.
"""
import asyncio

from . import repository as repo
from . import live_cache
from . import alerts_repository
from . import exposure_repository
from .config import settings
from .locations import MONITORED_CITIES, city_local_now, local_today
from .logger import log, log_err

_task: asyncio.Task | None = None


# Heat (temperature summary/location_features) and Exposure (Phase 6,
# OSM/Overpass) used to be fetched for two DIFFERENT-sized boxes around
# the same city center: heat used config.py's SUMMARY_HALF_WIDTH_DEG
# (0.006°, ~1.3km), exposure used its own DEFAULT_HALF_WIDTH_DEG (0.01°,
# ~2.2km). Both fed Phase 9's People Impact Score, which meant it was
# quietly combining a heat reading for a smaller area with an exposure
# count for a larger one — two different AOIs presented as if they
# described the same place. Numbers still looked reasonable because both
# boxes share a center, but this matters once Phase 10 (Emergency Mode)
# starts comparing Impact Score against a threshold: geographic
# consistency is what makes "everything above X gets flagged" meaningful.
#
# Fix: there is now exactly one AOI-box function, defined once in
# exposure_repository.py, and both heat and exposure requests below call
# it. This also means every heat/exposure/impact-score call for a given
# city hits the exact same AOI signature — one cache entry instead of
# two, so unifying the box doesn't add any extra fetch latency.
# config.py's SUMMARY_HALF_WIDTH_DEG is no longer read anywhere; it's
# safe to delete (kept only as an unused setting if you'd rather not
# touch config.py in this pass).
_bbox_for = exposure_repository.default_bbox_for_city
_exposure_bbox_for = _bbox_for


async def refresh_city_summary(city: dict) -> None:
    """Fetches this ONE city's summary live and stores it in live_cache.
    Called lazily by routers/cities.py on a cache miss/staleness for that
    specific city — never for cities nobody has asked about.

    Fetches THREE heatmap analytic types for the same AOI/day — tcm (for
    the temperature actually displayed), plus exceedance and persistence
    (display-invisible; their only purpose is feeding location_features'
    exceedance_hours/persistence_hours columns, see location_features.py).
    Without these two, Phase 8's Heat Risk Score would be missing 35% of
    its weighted factors for every monitored city, every day, since
    nothing else in normal usage ever requests those analytic types — a
    user would have to manually pick "Exceedance"/"Persistence" in the
    Heat Map sidebar's Map Controls for that data to exist at all.

    force_refresh=False on all of these — see the note below the tcm call
    — so this only actually reaches FortyGuard once per city per day per
    analytic type; every later visit that day is a genuine Postgres cache
    hit, not a repeat FortyGuard call.
    """
    bbox = _bbox_for(city)
    # City-local calendar day, NOT the server's — see locations.py's
    # city_local_now/local_today docstring for why bare date.today() here
    # was a real bug: this function is what WRITES location_features for
    # "today", and Risk/Impact/Emergency/Heat Story's own default-date
    # lookups need to agree on which calendar day that actually is for
    # THIS city, or a fetch that just completed can look entirely missing
    # to whichever of those reads it back with a different "today".
    today = local_today(city).isoformat()

    def _heatmap_payload(analytic_type: str) -> dict:
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
            "date_time": {"start_date": today, "filter_type": 3},
            "granularity": settings.SUMMARY_GRANULARITY,
            "analytic_type": analytic_type,
            "threshold": 30,
            "direction": "above",
        }

    heatmap = await repo.get_heatmap(_heatmap_payload("tcm"), force_refresh=False)

    # Exceedance/persistence are best-effort, same reasoning as
    # alerts/exposure below: a transient failure fetching either must not
    # stop the tcm heatmap/env_params that already succeeded from being
    # cached and shown. Their return values aren't used for anything here
    # — repo.get_heatmap() already writes to location_features internally
    # (Phase 5) on every genuine completion, regardless of analytic_type,
    # so simply calling it is the whole point; nothing further to do with
    # the result.
    for analytic_type in ("exceedance", "persistence"):
        try:
            await repo.get_heatmap(_heatmap_payload(analytic_type), force_refresh=False)
        except Exception as exc:  # noqa: BLE001
            log_err(f"{analytic_type} heatmap failed for {city['name']} — Risk Score will be "
                    f"missing that factor until it succeeds", {"error": str(exc)})

    mean_temp = heatmap.get("stats_data", {}).get("temperature_stats", {}).get("mean", 25)
    env_payload = {
        "latitude": city["lat"], "longitude": city["lon"], "temperature": mean_temp,
        # `start_time` MUST be this city's own local hour, matching `today`
        # (already `local_today(city)` two lines above it) — not the raw
        # UTC hour. This mismatched a local date with a UTC hour: at 9pm
        # in Houston (CDT), UTC is already past midnight, so the old
        # `datetime.now(timezone.utc).hour` asked FortyGuard for ~2am on
        # Houston's own local date, not 9pm — silently fetching
        # env-params for a time of day that isn't "now" at all, the exact
        # class of bug city_local_now/local_today (see locations.py) was
        # built to close, just missed here since this field lives
        # separately from `today` a few lines up.
        "date_time": {"start_date": today, "filter_type": 1,
                       "start_time": city_local_now(city).strftime("%H:00")},
    }
    env_params = await repo.get_env_params(env_payload, force_refresh=False)

    # Alerts/exposure are best-effort: a transient failure on either must
    # not stop the heatmap/env_params that already succeeded from being
    # cached — otherwise one bad NWS or Overpass call blocks live_cache
    # entirely and the city's /latest endpoint looks broken even though
    # most of its data was actually available.
    #
    # force_refresh=False on all three calls above/below is deliberate:
    # this function is already gated by live_cache's own TTL in
    # routers/cities.py (it only runs on a cache miss or staleness there),
    # so it has no business ALSO discarding repository.py's durable
    # Postgres cache and repeating an identical FortyGuard/NWS call. That
    # was the actual bug — force_refresh=True here meant every lazy
    # refresh re-hit FortyGuard fresh even when Postgres already had an
    # exact match (same signature = same date/time/params, so there's no
    # staleness risk in trusting that cache; a genuinely new hour or day
    # naturally produces a new signature and a real fetch happens anyway).
    try:
        alerts_result = await alerts_repository.get_alerts(city, force_refresh=False)
        alerts = alerts_result.get("alerts")
    except Exception as exc:  # noqa: BLE001
        log_err(f"Alerts refresh failed for {city['name']} — caching without alerts", {"error": str(exc)})
        alerts = None

    try:
        exposure_bbox = _exposure_bbox_for(city)
        await exposure_repository.get_exposure(
            exposure_bbox["min_lat"], exposure_bbox["min_lng"],
            exposure_bbox["max_lat"], exposure_bbox["max_lng"],
            force_refresh=False,
        )
    except Exception as exc:  # noqa: BLE001
        log_err(f"Exposure refresh failed for {city['name']} — will retry on next visit", {"error": str(exc)})

    live_cache.set_latest(city["id"], heatmap, env_params, alerts)
    log.info(f"Loaded summary for {city['name']} (on-demand)", extra={"tag": "CITY"})


# --- Optional always-on eager loop, OFF by default (ENABLE_SCHEDULER) ---

async def _run_forever() -> None:
    log.info(
        f"Eager scheduler starting — {len(MONITORED_CITIES)} cities, "
        f"every {settings.SCHEDULER_INTERVAL_MINUTES} min "
        f"(ENABLE_SCHEDULER=true — ordinary usage doesn't need this, see config.py)",
        extra={"tag": "SCHED"},
    )
    while True:
        for city in MONITORED_CITIES:
            try:
                await refresh_city_summary(city)
            except Exception as exc:  # noqa: BLE001 - one city's failure must not kill the loop
                log_err(f"Scheduler failed to refresh {city['name']}", {"error": str(exc)})
            await asyncio.sleep(settings.SCHEDULER_CITY_STAGGER_SECONDS)
        await asyncio.sleep(settings.SCHEDULER_INTERVAL_MINUTES * 60)


def start() -> None:
    global _task
    if not settings.ENABLE_SCHEDULER:
        log.info("Eager all-city scheduler disabled (default) — city summaries load on-demand instead", extra={"tag": "SCHED"})
        return
    _task = asyncio.create_task(_run_forever())


def stop() -> None:
    if _task is not None:
        _task.cancel()