"""
Phase 12.5d — Address search, nearby-POI shortcuts (hospital / school /
pharmacy / fire station), and reverse geocoding for Heat-Safe Routing.

Everything here is free, no-API-key, and reuses clients the app already
has: forward/reverse geocoding via Nominatim (nominatim_client.py, same
service city_boundary_repository.py uses for the boundary polygon), POI
lookup via Overpass (osm_client.py, same service exposure_repository.py
already queries). No new provider was added for any of this.

All three endpoints are scoped to one monitored city's cached boundary
(city_boundary_repository.py) — the same polygon routers/routing.py
enforces origin/destination against — so an address typed here, or a
POI picked here, can never turn out to be outside the boundary once the
trip is actually requested.
"""
from fastapi import APIRouter, HTTPException, Query

from .. import city_boundary_repository, osm_client, poi_repository
from ..geo_utils import bbox_of_geojson, haversine_km, point_in_polygon
from ..locations import get_city
from ..logger import log_err
from ..nominatim_client import BoundaryLookupError, geocode_search, reverse_geocode
from ..routing_providers import fetch_osrm_travel_times

router = APIRouter(prefix="/api/cities", tags=["places"])

POI_CATEGORIES = ("hospital", "school", "pharmacy", "fire_station", "police", "cooling_center")

# Walking is only a realistic alternative to driving up to a couple of km —
# beyond that showing a "walk" estimate is more misleading than useful, so
# it's only attached to nearby POIs. 4.8 km/h ≈ a brisk-but-normal adult
# walking pace, same figure city walkability studies commonly use.
WALK_SPEED_KMH = 4.8
WALK_ESTIMATE_MAX_KM = 3.0


async def _get_city_or_404(city_id: str) -> dict:
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")
    return city


async def _get_boundary_geojson_or_503(city: dict) -> dict:
    try:
        boundary = await city_boundary_repository.get_boundary(city)
    except BoundaryLookupError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load {city['name']}'s boundary right now ({exc}). Please try again shortly.",
        ) from exc
    return boundary["geojson"]


@router.get("/{city_id}/geocode")
async def geocode(city_id: str, q: str = Query(..., min_length=2, description="Free-text address or place name")):
    """Type-ahead address search for the origin/destination fields —
    results are already filtered to inside the city's boundary, so
    anything the picker shows is guaranteed usable as a Heat-Safe
    Routing endpoint."""
    city = await _get_city_or_404(city_id)
    boundary_geojson = await _get_boundary_geojson_or_503(city)
    try:
        results = await geocode_search(q, boundary_geojson)
    except BoundaryLookupError as exc:
        log_err("Geocode search failed", {"city": city_id, "query": q, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"Address search failed: {exc}") from exc
    return {"city_id": city_id, "query": q, "results": results}


@router.get("/{city_id}/pois")
async def pois(
    city_id: str,
    category: str = Query(..., description=f"One of {POI_CATEGORIES}"),
    near_lat: float | None = None,
    near_lon: float | None = None,
    limit: int = 8,
):
    """Nearest hospitals/schools/pharmacies/fire stations inside the
    city's boundary — the "shortcuts" that let someone pick a
    destination CATEGORY instead of typing an exact address. Sorted
    ascending by actual OSRM drive time from (near_lat, near_lon) when
    given (the trip's origin, typically), else from the city's own
    center — falls back to straight-line distance for any point OSRM
    couldn't score. Each result also carries drive_minutes/drive_km and,
    for close-by points, a rough walk_minutes estimate, so the picker can
    show "how long to get there" instead of just a name."""
    if category not in POI_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"category must be one of {POI_CATEGORIES}")
    city = await _get_city_or_404(city_id)
    boundary_geojson = await _get_boundary_geojson_or_503(city)
    min_lon, min_lat, max_lon, max_lat = bbox_of_geojson(boundary_geojson)

    try:
        points = await poi_repository.get_pois(city_id, category, min_lat, min_lon, max_lat, max_lon)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - Overpass network/parse failure, no cached fallback available
        log_err("POI lookup failed", {"city": city_id, "category": category, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"POI lookup failed: {exc}") from exc

    # Overpass's bbox is a box; the real city outline isn't — drop any
    # POI whose point fell in a bbox corner outside the actual boundary,
    # same reasoning as geocode_search's second filter pass above.
    points = [p for p in points if point_in_polygon(p["lat"], p["lon"], boundary_geojson)]

    origin_lat = near_lat if near_lat is not None else city["lat"]
    origin_lon = near_lon if near_lon is not None else city["lon"]

    # Straight-line distance first (cheap, always available) — this is
    # what determines which candidates are even worth sending to OSRM,
    # and it's the fallback sort/display value if the OSRM call below
    # fails or a particular leg comes back unreachable.
    for p in points:
        p["straight_line_km"] = round(haversine_km(origin_lat, origin_lon, p["lat"], p["lon"]), 2)
        p["drive_minutes"] = None
        p["drive_km"] = None
        p["walk_minutes"] = (
            round((p["straight_line_km"] / WALK_SPEED_KMH) * 60, 1)
            if p["straight_line_km"] <= WALK_ESTIMATE_MAX_KM
            else None
        )
    points.sort(key=lambda p: p["straight_line_km"])

    # Only worth asking OSRM for real drive times on the candidates that
    # could plausibly end up in the top `limit` — capped a bit above
    # `limit` itself since drive time can reorder relative to straight-
    # line distance (a closer-as-the-crow-flies POI can be the slower
    # drive), but not by much in practice.
    osrm_candidates = points[: max(limit * 2, limit + 4)]
    try:
        travel_times = await fetch_osrm_travel_times(
            (origin_lat, origin_lon), [(p["lat"], p["lon"]) for p in osrm_candidates]
        )
    except Exception as exc:  # noqa: BLE001 - drive-time ranking is a nice-to-have, never worth failing the POI list over
        log_err("OSRM travel-time lookup failed for POI ranking", {"city": city_id, "category": category, "error": str(exc)})
        travel_times = [None] * len(osrm_candidates)

    for p, leg in zip(osrm_candidates, travel_times):
        if leg is not None:
            p["drive_minutes"] = round(leg["duration_s"] / 60, 1)
            p["drive_km"] = round(leg["distance_m"] / 1000, 2)

    # Ascending by actual drive time when we have it; POIs OSRM couldn't
    # reach (or wasn't even asked about, past the osrm_candidates cutoff)
    # fall back to straight-line distance and sort after every point that
    # DOES have a real drive time, rather than mixing two different units
    # of "closeness" in one sort key.
    points.sort(key=lambda p: (p.get("drive_minutes") is None, p.get("drive_minutes", p["straight_line_km"])))

    return {"city_id": city_id, "category": category, "results": points[:limit]}


@router.get("/{city_id}/reverse")
async def reverse(city_id: str, lat: float, lon: float):
    """Best-effort human-readable label for a raw point — used to label
    a "my location" pin and to build a readable share-location message.
    Never fails the request over a missing label (see
    nominatim_client.reverse_geocode's own docstring); `label` is simply
    None when Nominatim couldn't be reached."""
    await _get_city_or_404(city_id)  # validates city_id even though the label lookup itself is city-agnostic
    label = await reverse_geocode(lat, lon)
    return {"lat": lat, "lon": lon, "label": label}