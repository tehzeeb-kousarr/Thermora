"""
Geoapify Places API client — the authenticated alternative to Overpass for
Phase 6 exposure data (schools, hospitals/healthcare, residential density).

This was referenced by exposure_repository.py (`from . import
geoapify_client`, `geoapify_client.is_configured()`,
`geoapify_client.fetch_points_and_density(...)`) but the module itself
didn't exist yet — that import alone was enough to crash the app at
startup with ModuleNotFoundError. This file provides that missing module.

Deliberately matches osm_client.fetch_exposure's return shape exactly —
{"points": [...], "density": {...}} with the same point/density dict
keys — so exposure_repository can treat either provider interchangeably
and callers never need to know which one actually answered.

Geoapify's Places API (https://apidocs.geoapify.com/docs/places/) has no
query language to get wrong (unlike Overpass QL) and a real free tier
(3,000 req/day at the time of writing) — good for routing around whatever
is blocking Overpass's public mirrors specifically, without the ambiguity
of "is this a query bug or a network block."
"""
import httpx

from .config import settings
from .logger import log_req, log_res, log_err

# Geoapify categories: https://apidocs.geoapify.com/docs/places/#categories
EDUCATION_CATEGORIES = "education.school,education.university,education.college,childcare.kindergarten"
HEALTHCARE_CATEGORIES = "healthcare.hospital,healthcare.clinic_or_praxis"
BUILDING_CATEGORY = "building"
RESIDENTIAL_CATEGORY = "building.residential"

# Geoapify caps a single Places response at 500 features — fine for the
# points query (schools/hospitals are sparse), but density counts (all
# buildings in an AOI) can genuinely exceed that in a dense downtown box.
# We treat the count as a floor in that case rather than pretending it's
# exact — see _count_category's docstring.
MAX_RESULTS = 500


def is_configured() -> bool:
    return bool(settings.GEOAPIFY_API_KEY)


def _rect_filter(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> str:
    # Geoapify's rect filter is lon1,lat1,lon2,lat2 (west,south,east,north) —
    # opposite corner order from Overpass's bbox, easy to mix up.
    return f"rect:{min_lng},{min_lat},{max_lng},{max_lat}"


async def _places_request(client: httpx.AsyncClient, categories: str, rect: str, limit: int) -> dict:
    params = {
        "categories": categories,
        "filter": rect,
        "limit": limit,
        "apiKey": settings.GEOAPIFY_API_KEY,
    }
    log_req("GET Geoapify Places", {"categories": categories})
    resp = await client.get(settings.GEOAPIFY_BASE_URL, params=params, timeout=settings.GEOAPIFY_TIMEOUT_SECONDS)
    if resp.status_code != 200:
        raise RuntimeError(f"Geoapify returned {resp.status_code}: {resp.text[:300]}")
    body = resp.json()
    log_res("Geoapify Places responded", {"feature_count": len(body.get("features", []))})
    return body


def _point_type_for_categories(categories: list[str]) -> str | None:
    for c in categories:
        if c.startswith("education.") or c.startswith("childcare."):
            return "school"
        if c.startswith("healthcare."):
            return "hospital"
    return None


def _extract_points(body: dict) -> list[dict]:
    points: list[dict] = []
    for feature in body.get("features", []):
        props = feature.get("properties", {})
        point_type = _point_type_for_categories(props.get("categories", []))
        if point_type is None:
            continue
        lon, lat = None, None
        geom = feature.get("geometry", {})
        coords = geom.get("coordinates")
        if geom.get("type") == "Point" and coords:
            lon, lat = coords[0], coords[1]
        else:
            lon, lat = props.get("lon"), props.get("lat")
        if lat is None or lon is None:
            continue
        points.append({
            "type": point_type,
            "name": props.get("name") or point_type.title(),
            "lat": lat,
            "lon": lon,
            "source": "geoapify",
        })
    return points


async def _count_category(client: httpx.AsyncClient, category: str, rect: str) -> int:
    """Returns a feature count for one category. Geoapify's Places API has
    no dedicated "count only" mode like Overpass's `out count;` — this
    fetches up to MAX_RESULTS and counts what came back. If the AOI
    genuinely contains more than MAX_RESULTS features of this category
    (dense downtown building counts, most likely), this undercounts; that's
    an accepted tradeoff for a free-tier authenticated API with no query
    language, not a silent bug — density counts here are a "at least this
    many" signal, same spirit as osm_client's own count being a snapshot
    rather than a guarantee of completeness."""
    body = await _places_request(client, category, rect, MAX_RESULTS)
    return len(body.get("features", []))


async def fetch_points_and_density(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> dict:
    """Returns {"points": [...], "density": {...}} — same shape as
    osm_client.fetch_exposure, minus road_count (Geoapify's Places API has
    no linear road-geometry category; exposure_repository fills that in
    from Overpass as best-effort enrichment when this provider is used)."""
    if not is_configured():
        raise RuntimeError("Geoapify not configured (GEOAPIFY_API_KEY unset)")

    rect = _rect_filter(min_lat, min_lng, max_lat, max_lng)
    categories = f"{EDUCATION_CATEGORIES},{HEALTHCARE_CATEGORIES}"

    async with httpx.AsyncClient() as client:
        points_body = await _places_request(client, categories, rect, MAX_RESULTS)
        points = _extract_points(points_body)

        try:
            building_count = await _count_category(client, BUILDING_CATEGORY, rect)
        except Exception as exc:  # noqa: BLE001
            log_err("Geoapify building count failed", {"error": str(exc)})
            building_count = 0

        try:
            residential_count = await _count_category(client, RESIDENTIAL_CATEGORY, rect)
        except Exception as exc:  # noqa: BLE001
            log_err("Geoapify residential count failed", {"error": str(exc)})
            residential_count = 0

    return {
        "points": points,
        "density": {
            "building_count": building_count,
            "residential_landuse_count": residential_count,
            # Filled in by exposure_repository via osm_client.fetch_road_count
            # as best-effort enrichment — Geoapify Places has no road category.
            "road_count": 0,
        },
    }
