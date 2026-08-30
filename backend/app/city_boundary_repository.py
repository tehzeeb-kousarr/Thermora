"""
Caches each monitored city's administrative boundary polygon (fetched via
nominatim_client.py) in Postgres. Boundaries essentially never change —
this is cached far longer than heat data (BOUNDARY_CACHE_DAYS, default
90) and, unlike exposure_repository's per-AOI cache, there's exactly one
row per city_id since a monitored city has exactly one boundary.

This is what routers/routing.py checks candidate routes/endpoints
against, and what routers/city_boundary.py exposes to the frontend so the
map can actually draw the outline the user asked for.
"""
import json
from datetime import datetime, timezone

from .config import settings
from .db import get_pool
from .logger import log_db, log_err
from .nominatim_client import fetch_city_boundary, BoundaryLookupError


def _is_fresh(fetched_at: datetime) -> bool:
    age_days = (datetime.now(timezone.utc) - fetched_at).total_seconds() / 86400
    return age_days < settings.BOUNDARY_CACHE_DAYS


async def _load_cached(city_id: str) -> dict | None:
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT boundary_geojson, fetched_at FROM city_boundaries WHERE city_id = $1",
        city_id,
    )
    if not row:
        return None
    return {"geojson": json.loads(row["boundary_geojson"]), "fetched_at": row["fetched_at"]}


async def _store(city_id: str, geojson: dict) -> None:
    pool = get_pool()
    await pool.execute(
        """
        INSERT INTO city_boundaries (city_id, boundary_geojson, fetched_at)
        VALUES ($1, $2, now())
        ON CONFLICT (city_id) DO UPDATE SET boundary_geojson = $2, fetched_at = now()
        """,
        city_id, json.dumps(geojson),
    )


async def get_boundary(city: dict, force_refresh: bool = False) -> dict:
    """Returns {"geojson": <Polygon|MultiPolygon>, "cached": bool}.

    On a fresh Nominatim failure with NO cached copy at all, raises
    BoundaryLookupError — callers (routing.py) treat that as "boundary
    enforcement unavailable for this city right now" rather than
    fabricating a boundary. On a fresh failure WITH a stale cached copy
    already on file, the stale copy is returned instead of failing
    outright — a boundary that's a few months old is still far more
    useful than none, and city boundaries don't move."""
    cached = await _load_cached(city["id"])
    if cached and not force_refresh and _is_fresh(cached["fetched_at"]):
        return {"geojson": cached["geojson"], "cached": True}

    try:
        geojson = await fetch_city_boundary(city)
    except BoundaryLookupError as exc:
        if cached:
            log_err(
                f"Boundary refresh failed for {city['id']} — serving stale cached copy",
                {"error": str(exc), "cached_age_days": (datetime.now(timezone.utc) - cached["fetched_at"]).days},
            )
            return {"geojson": cached["geojson"], "cached": True}
        raise

    await _store(city["id"], geojson)
    log_db("City boundary cached", {"city": city["id"]})
    return {"geojson": geojson, "cached": False}
