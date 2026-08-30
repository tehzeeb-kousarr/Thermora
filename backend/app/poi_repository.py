"""
Phase 12.5g — caches the raw (unsorted, city-wide) POI list for one
city+category pair in Postgres. This is what makes routers/places.py's
POI-shortcut endpoint fast on repeat use: the first "Hospital" pick for
a city pays the real Overpass round trip (which, over a whole metro
bbox, is genuinely multi-second — see osm_client.py's own retry/backoff
comments), every pick after that is a Postgres read. Distance-sorting
against the trip's origin still happens fresh on every request in
places.py — only the raw point list is cached, never the sort order.

Same read-through-cache shape as city_boundary_repository.py, deliberately
kept as a near-identical sibling rather than generalized into one shared
helper — the two cache different data with different TTLs
(POI_CACHE_DAYS vs BOUNDARY_CACHE_DAYS) and different failure semantics
below.
"""
import json
from datetime import datetime, timezone

from .config import settings
from .db import get_pool
from .logger import log_db, log_err
from . import osm_client


def _is_fresh(fetched_at: datetime) -> bool:
    age_days = (datetime.now(timezone.utc) - fetched_at).total_seconds() / 86400
    return age_days < settings.POI_CACHE_DAYS


async def _load_cached(city_id: str, category: str) -> dict | None:
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT points, fetched_at FROM poi_cache WHERE city_id = $1 AND category = $2",
        city_id, category,
    )
    if not row:
        return None
    return {"points": json.loads(row["points"]), "fetched_at": row["fetched_at"]}


async def _store(city_id: str, category: str, points: list[dict]) -> None:
    pool = get_pool()
    await pool.execute(
        """
        INSERT INTO poi_cache (city_id, category, points, fetched_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (city_id, category) DO UPDATE SET points = $3, fetched_at = now()
        """,
        city_id, category, json.dumps(points),
    )


async def get_pois(city_id: str, category: str, min_lat: float, min_lng: float,
                    max_lat: float, max_lng: float) -> list[dict]:
    """Returns the raw (unsorted) point list for this city+category,
    Postgres-cached for POI_CACHE_DAYS. On a fresh Overpass failure with
    a stale cached copy already on file, serves the stale copy rather
    than failing the whole request — a POI list a few days old is still
    far more useful than none, and hospitals/schools don't move. Only
    raises when Overpass fails AND there's no cached copy at all yet."""
    cached = await _load_cached(city_id, category)
    if cached and _is_fresh(cached["fetched_at"]):
        return cached["points"]

    try:
        points = await osm_client.fetch_pois(min_lat, min_lng, max_lat, max_lng, category)
    except Exception as exc:  # noqa: BLE001 - Overpass network/parse failure
        if cached:
            log_err(
                f"POI refresh failed for {city_id}/{category} — serving stale cached copy",
                {"error": str(exc), "cached_age_days": (datetime.now(timezone.utc) - cached["fetched_at"]).days},
            )
            return cached["points"]
        raise

    await _store(city_id, category, points)
    log_db("POI list cached", {"city": city_id, "category": category, "count": len(points)})
    return points
