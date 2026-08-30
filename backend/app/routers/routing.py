"""
Phase 12.5 — Heat-Safe Routing.

POST /api/routes: A -> B -> candidate routes from free routing providers
-> each route's points scored against FortyGuard's forecast machinery ->
"Fastest" / "Coolest" / "Balanced" labeled options. See route_merge.py
and route_heat_scoring.py for the actual pipeline; this router adds two
more things on top of that pipeline (Phase 12.5b/c):

  1. Boundary enforcement — origin/destination must fall inside the
     requested city's cached admin-boundary polygon (city_boundary_
     repository.py), and any candidate route that mostly leaves that
     boundary is dropped before scoring. Keeps every route request
     genuinely scoped to one city, and rejects an out-of-bounds
     destination with a clear error instead of silently routing across
     an entire country.
  2. Whole-response caching (route_query_cache.py) — a repeat or
     nearby-enough request (same city, grid-snapped origin/destination,
     same departure hour) is served straight out of Postgres, skipping
     every provider call and every FortyGuard lookup.
"""
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from .. import city_boundary_repository, route_heat_scoring, route_merge, route_query_cache
from ..config import settings
from ..geo_utils import fraction_inside_boundary, point_in_polygon
from ..locations import get_city
from ..logger import log_err, log_res
from ..nominatim_client import BoundaryLookupError
from ..schemas import RouteRequest

router = APIRouter(prefix="/api/routes", tags=["routing"])


def _parse_departure_time(raw: str | None) -> datetime:
    if not raw:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail="departure_time must be a valid ISO 8601 datetime, e.g. 2026-08-29T14:30:00-05:00",
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _filter_routes_within_boundary(routes: list[dict], boundary_geojson: dict) -> tuple[list[dict], bool]:
    """Drops any candidate route whose sampled points are mostly outside
    the city boundary (see ROUTE_BOUNDARY_MIN_INSIDE_FRACTION). If that
    would remove EVERY candidate — genuinely possible for an A/B pair
    near the city's edge where every real road briefly leaves the strict
    admin line — falls back to keeping all of them rather than returning
    zero routes for a request that otherwise had valid, in-boundary
    origin/destination points. Returns (routes, any_route_partially_outside)."""
    scored = []
    for route in routes:
        # Reuse route_heat_scoring's own point sampler so "how much of
        # this route is inside the boundary" is judged against the same
        # points travel-time-sampling would use — not a separate,
        # differently-spaced sample that could disagree with it.
        sample_points = [(p["lat"], p["lon"]) for p in route_heat_scoring.sample_route_points(route)]
        inside_fraction = fraction_inside_boundary(sample_points, boundary_geojson)
        route["boundary_inside_fraction"] = round(inside_fraction, 2)
        scored.append(route)

    kept = [r for r in scored if r["boundary_inside_fraction"] >= settings.ROUTE_BOUNDARY_MIN_INSIDE_FRACTION]
    if kept:
        return kept, False

    log_err(
        "Every candidate route fell mostly outside the city boundary — keeping all candidates unfiltered",
        {"count": len(scored)},
    )
    return scored, True


@router.post("")
async def get_routes(req: RouteRequest):
    city = get_city(req.city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{req.city_id}'")

    origin = (req.origin_lat, req.origin_lon)
    destination = (req.destination_lat, req.destination_lon)
    departure_dt = _parse_departure_time(req.departure_time)

    # --- Boundary enforcement (Phase 12.5b) ---------------------------
    try:
        boundary = await city_boundary_repository.get_boundary(city)
    except BoundaryLookupError as exc:
        # No boundary at all (first-ever request for this city AND
        # Nominatim unreachable right now) — fail closed rather than
        # silently skip enforcement, since "route anywhere on Earth" is
        # a worse failure mode than a clear "try again shortly" error.
        log_err("Boundary lookup failed with no cached fallback", {"city": req.city_id, "error": str(exc)})
        raise HTTPException(
            status_code=503,
            detail=f"Could not load {city['name']}'s boundary right now ({exc}). Please try again shortly.",
        ) from exc

    boundary_geojson = boundary["geojson"]
    if not point_in_polygon(origin[0], origin[1], boundary_geojson):
        raise HTTPException(
            status_code=400,
            detail=f"Origin point falls outside {city['name']}'s boundary. "
                   f"Heat-Safe Routing is scoped to one city at a time.",
        )
    if not point_in_polygon(destination[0], destination[1], boundary_geojson):
        raise HTTPException(
            status_code=400,
            detail=f"Destination falls outside {city['name']}'s boundary. "
                   f"Heat-Safe Routing is scoped to one city at a time.",
        )

    # --- Whole-response cache (Phase 12.5c) ----------------------------
    departure_hour_bucket = departure_dt.strftime("%Y-%m-%dT%H")
    cache_key = route_query_cache.build_cache_key(req.city_id, origin, destination, departure_hour_bucket, req.heat_weight)
    cached_result = await route_query_cache.get_cached(cache_key)
    if cached_result is not None:
        log_res("Route query cache hit — skipping providers/scoring entirely", {"city": req.city_id})
        return {**cached_result, "cached": True}

    # --- Candidate routes + heat scoring (existing Phase 12.5 pipeline) ---
    try:
        candidates = await route_merge.fetch_candidate_routes(origin, destination)
    except Exception as exc:  # noqa: BLE001
        log_err("Route candidate fetch failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=f"Routing providers failed: {exc}") from exc

    if not candidates:
        raise HTTPException(
            status_code=502,
            detail="No routing provider returned a usable route. Check network access and provider API keys.",
        )

    candidates, boundary_fallback = _filter_routes_within_boundary(candidates, boundary_geojson)

    try:
        scored = await asyncio.gather(
            *(route_heat_scoring.score_route(route, departure_dt) for route in candidates)
        )
    except Exception as exc:  # noqa: BLE001
        log_err("Route heat scoring failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=f"Heat scoring failed: {exc}") from exc

    labeled = route_heat_scoring.label_routes(list(scored), req.heat_weight)

    result = {
        "origin": {"lat": origin[0], "lon": origin[1]},
        "destination": {"lat": destination[0], "lon": destination[1]},
        "city_id": req.city_id,
        "departure_time": departure_dt.isoformat(),
        "forecast_horizon_hours": settings.ROUTE_FORECAST_HORIZON_HOURS,
        "boundary_partially_bypassed": boundary_fallback,
        "routes": labeled,
    }

    await route_query_cache.store(cache_key, req.city_id, origin, destination, departure_hour_bucket, result)

    return {**result, "cached": False}
