"""
Phase 6 repository — caches OSM exposure data per AOI.

Unlike heat data, exposure data (schools, hospitals, building density)
essentially never changes day to day, so this is cached for
EXPOSURE_CACHE_DAYS (default 30) rather than re-fetched on every view.
"""
from datetime import datetime, timezone
import json
from pathlib import Path

from . import osm_client
from . import geoapify_client
from .config import settings
from .db import get_pool
from .logger import log_db, log_err


# Must match frontend/src/data/cities.js's defaultBBoxForCity default
# EXACTLY — exposure is cached by rounded AOI signature, so any drift
# between what a card requests and what a background/derived call
# requests just means two cache entries for what's conceptually the same
# area. Centralized here so Phase 9 (People Impact Score), the
# Dashboard's ExposureCard, and scheduler.py's lazy heat-summary loader
# all read the identical AOI — this is now THE single AOI box definition
# for a monitored city, used for both heat and exposure requests (see
# scheduler.py's _bbox_for), not just exposure's own.
DEFAULT_HALF_WIDTH_DEG = 0.01


def default_bbox_for_city(city: dict, half_width_deg: float = DEFAULT_HALF_WIDTH_DEG) -> dict:
    return {
        "min_lat": city["lat"] - half_width_deg, "max_lat": city["lat"] + half_width_deg,
        "min_lng": city["lon"] - half_width_deg, "max_lng": city["lon"] + half_width_deg,
    }


def aoi_signature(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> str:
    """Rounded so trivially-different bboxes (e.g. floating point noise)
    still hit the same cached row instead of missing every time."""
    r = lambda v: round(v, 5)
    return f"{r(min_lat)},{r(min_lng)},{r(max_lat)},{r(max_lng)}"


def _is_fresh(fetched_at: datetime) -> bool:
    age_days = (datetime.now(timezone.utc) - fetched_at).total_seconds() / 86400
    return age_days < settings.EXPOSURE_CACHE_DAYS


async def _load_cached(signature: str) -> dict | None:
    pool = get_pool()
    density_row = await pool.fetchrow(
        "SELECT * FROM exposure_density WHERE aoi_signature = $1", signature
    )
    if density_row is None or not _is_fresh(density_row["fetched_at"]):
        return None

    point_rows = await pool.fetch(
        "SELECT type, name, lat, lon, source FROM exposure_points WHERE aoi_signature = $1",
        signature,
    )
    return {
        "points": [dict(r) for r in point_rows],
        "density": {
            "building_count": density_row["building_count"],
            "residential_landuse_count": density_row["residential_landuse_count"],
            "road_count": density_row["road_count"],
        },
        "fetched_at": density_row["fetched_at"].isoformat(),
    }


async def _store(signature: str, points: list[dict], density: dict) -> None:
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Re-fetching an AOI replaces its rows rather than accumulating
            # duplicates from every past fetch of the same area.
            await conn.execute("DELETE FROM exposure_points WHERE aoi_signature = $1", signature)
            for p in points:
                await conn.execute(
                    """
                    INSERT INTO exposure_points (aoi_signature, type, name, lat, lon, source)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    """,
                    signature, p["type"], p.get("name"), p["lat"], p["lon"], p.get("source", "osm"),
                )
            await conn.execute(
                """
                INSERT INTO exposure_density (aoi_signature, building_count, residential_landuse_count, road_count, fetched_at)
                VALUES ($1, $2, $3, $4, now())
                ON CONFLICT (aoi_signature) DO UPDATE SET
                    building_count = EXCLUDED.building_count,
                    residential_landuse_count = EXCLUDED.residential_landuse_count,
                    road_count = EXCLUDED.road_count,
                    fetched_at = now()
                """,
                signature, density["building_count"], density["residential_landuse_count"], density["road_count"],
            )
    log_db(f"Stored exposure data for AOI {signature}", {"points": len(points), "density": density})


async def get_exposure(min_lat: float, min_lng: float, max_lat: float, max_lng: float,
                        force_refresh: bool = False) -> dict:
    signature = aoi_signature(min_lat, min_lng, max_lat, max_lng)

    if not force_refresh:
        cached = await _load_cached(signature)
        if cached is not None:
            log_db(f"Exposure cache hit for AOI {signature}")
            return cached

    result: dict | None = None
    provider_used: str | None = None
    errors: list[str] = []

    # Prefer Geoapify when configured — a normal authenticated REST API,
    # not a shared public service with a query language to get wrong.
    # Overpass is the fallback (or the only option, if no Geoapify key is
    # set — this keeps the original Phase 6 behavior fully intact).
    if geoapify_client.is_configured():
        try:
            result = await geoapify_client.fetch_points_and_density(min_lat, min_lng, max_lat, max_lng)
            provider_used = "geoapify"
        except Exception as exc:  # noqa: BLE001
            log_err("Geoapify exposure fetch failed — falling back to Overpass", {"error": str(exc)})
            errors.append(f"geoapify: {exc}")

    if result is None:
        try:
            result = await osm_client.fetch_exposure(min_lat, min_lng, max_lat, max_lng)
            provider_used = "overpass"
        except Exception as exc:  # noqa: BLE001
            errors.append(f"overpass: {exc}")
            log_err("OSM exposure fetch failed", {"error": "; ".join(errors)})
            # Fall back to a stale cached copy rather than nothing, if one exists.
            stale = await _load_cached_ignoring_freshness(signature)
            if stale is not None:
                return {**stale, "stale": True}
            # Nothing in Postgres either (e.g. first-ever request for this AOI
            # and every provider happened to be down) — try the seed file as
            # an honest last resort. Only returns something if the seed file
            # actually exists and has a real, previously-fetched entry for
            # this exact AOI; otherwise this is a no-op and the error below
            # still propagates as before.
            seed_entry = _load_seed_file().get(signature)
            if seed_entry is not None:
                log_db(f"Exposure seed-file fallback used for AOI {signature}")
                return {**seed_entry, "stale": True, "source": "seed_file"}
            raise RuntimeError("; ".join(errors)) from exc

    # Best-effort road-count enrichment. Only Overpass covers linear road
    # geometry, so if Geoapify supplied points/density, road_count is still
    # 0 at this point — try to fill it in, but never let a slow/unreachable
    # Overpass here undo the points/density that already succeeded.
    if result["density"].get("road_count", 0) == 0 and provider_used != "overpass":
        try:
            result["density"]["road_count"] = await osm_client.fetch_road_count(min_lat, min_lng, max_lat, max_lng)
        except Exception as exc:  # noqa: BLE001
            log_err("Road-count enrichment failed — continuing without it", {"error": str(exc)})

    await _store(signature, result["points"], result["density"])
    return {**result, "fetched_at": datetime.now(timezone.utc).isoformat(), "provider": provider_used}


async def _load_cached_ignoring_freshness(signature: str) -> dict | None:
    pool = get_pool()
    density_row = await pool.fetchrow(
        "SELECT * FROM exposure_density WHERE aoi_signature = $1", signature
    )
    if density_row is None:
        return None
    point_rows = await pool.fetch(
        "SELECT type, name, lat, lon, source FROM exposure_points WHERE aoi_signature = $1", signature
    )
    return {
        "points": [dict(r) for r in point_rows],
        "density": {
            "building_count": density_row["building_count"],
            "residential_landuse_count": density_row["residential_landuse_count"],
            "road_count": density_row["road_count"],
        },
        "fetched_at": density_row["fetched_at"].isoformat(),
    }


def _load_seed_file() -> dict:
    """Last-resort fallback for the fixed set of monitored cities, used
    only when BOTH a live Overpass fetch AND the Postgres cache (even a
    stale one) have nothing. Deliberately NOT shipped with fabricated
    data — this file starts absent/empty and is populated by actually
    running `backend/scripts/prefetch_exposure_seed.py` (a real Overpass
    fetch, saved to disk) whenever the mirrors happen to be reachable.
    Absent file or absent entry just means this fallback has nothing to
    offer, same as before this existed."""
    try:
        with open(_SEED_PATH, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


_SEED_PATH = Path(__file__).parent / "data" / "exposure_seed.json"