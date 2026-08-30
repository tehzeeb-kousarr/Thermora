"""
Caches a FULL /api/routes response (candidates + heat scores + labels)
keyed by a coarse fingerprint of (city, origin, destination, departure
hour). Distinct from repository.get_heatmap's own per-point cache: that
one already saves a repeat FortyGuard call for the SAME point/hour, but a
whole route request still has to re-hit every provider, re-merge, and
re-walk every sample point even when it's an identical or nearby-enough
query. This table skips all of that for a cache hit — a repeat or nearby
request returns instantly.

Coordinates are snapped to ROUTE_QUERY_CACHE_GRID_DEG before hashing, so
"basically the same trip" (a few hundred meters off — a different door on
the same block, a GPS jitter) collapses onto the same cache entry rather
than each pixel-different request missing. This is deliberately coarser
matching than an exact-coordinate cache; a route to the block next door
is, for routing/heat-exposure purposes, the same trip.
"""
import hashlib
import json
from datetime import datetime, timezone

from .config import settings
from .db import get_pool
from .logger import log_db, log_err


def _grid_round(value: float, grid: float) -> float:
    return round(value / grid) * grid


def build_cache_key(city_id: str, origin: tuple[float, float], destination: tuple[float, float],
                     departure_hour_bucket: str, heat_weight: float | None = None) -> str:
    grid = settings.ROUTE_QUERY_CACHE_GRID_DEG
    o_lat, o_lon = _grid_round(origin[0], grid), _grid_round(origin[1], grid)
    d_lat, d_lon = _grid_round(destination[0], grid), _grid_round(destination[1], grid)
    # heat_weight rounded to 1 decimal — a routing/UI slider moved by a
    # trivial amount shouldn't miss an otherwise-identical cache entry.
    weight_key = round(heat_weight, 1) if heat_weight is not None else "default"
    raw = f"{city_id}:{o_lat}:{o_lon}:{d_lat}:{d_lon}:{departure_hour_bucket}:{weight_key}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _is_fresh(created_at: datetime) -> bool:
    age_minutes = (datetime.now(timezone.utc) - created_at).total_seconds() / 60
    return age_minutes < settings.ROUTE_QUERY_CACHE_MINUTES


async def get_cached(cache_key: str) -> dict | None:
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT result, created_at FROM route_query_cache WHERE cache_key = $1",
        cache_key,
    )
    if not row or not _is_fresh(row["created_at"]):
        return None
    log_db("Route query cache hit", {"cache_key": cache_key[:12]})
    return json.loads(row["result"])


async def store(cache_key: str, city_id: str, origin: tuple[float, float], destination: tuple[float, float],
                 departure_hour_bucket: str, result: dict) -> None:
    """Best-effort — a write failure here must never fail the actual
    routing response the user is already looking at; it just means the
    NEXT similar request re-does the work instead of hitting cache."""
    try:
        pool = get_pool()
        await pool.execute(
            """
            INSERT INTO route_query_cache
                (cache_key, city_id, origin_lat, origin_lon, destination_lat, destination_lon,
                 departure_hour_bucket, result, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
            ON CONFLICT (cache_key) DO UPDATE SET result = $8, created_at = now()
            """,
            cache_key, city_id, origin[0], origin[1], destination[0], destination[1],
            departure_hour_bucket, json.dumps(result),
        )
    except Exception as exc:  # noqa: BLE001 - caching is an optimization, never a hard dependency
        log_err("Failed to store route query cache entry", {"error": str(exc)})
