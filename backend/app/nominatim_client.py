"""
City boundary lookup — OpenStreetMap Nominatim (free, no API key).

This is deliberately a SEPARATE client from osm_client.py's Overpass
queries: Overpass CAN return an administrative boundary relation, but
turning its raw member ways into a closed polygon ring yourself is a real
chunk of geometry-assembly code. Nominatim's /search already does that
assembly server-side and hands back a ready-to-use GeoJSON Polygon/
MultiPolygon via polygon_geojson=1 — the right tool for "give me this
city's outline", where Overpass remains the right tool for "give me
points/counts inside a box" (osm_client.py's actual job).

Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
requires a descriptive User-Agent and caps at ~1 request/second for the
public instance — fine here since city boundaries are fetched once per
city and cached for BOUNDARY_CACHE_DAYS (see city_boundary_repository.py),
never on a hot path.
"""
import httpx

from .config import settings
from .geo_utils import bbox_of_geojson, point_in_polygon
from .logger import log_req, log_res, log_err


class BoundaryLookupError(Exception):
    """Raised when Nominatim can't be reached or returns no usable
    polygon — callers (city_boundary_repository) decide what to do with
    that (e.g. fall back to a stale cached boundary if one exists)."""


async def fetch_city_boundary(city: dict) -> dict:
    """Returns a GeoJSON Polygon or MultiPolygon (Nominatim's own
    `geojson` field, used as-is) for the given monitored city. `city` is
    one of locations.MONITORED_CITIES — its `name`/`state` are used as
    the search query, and `lat`/`lon` bias the match toward the right
    result when a city name isn't unique worldwide (e.g. more than one
    "Houston")."""
    url = f"{settings.NOMINATIM_BASE_URL}/search"
    params = {
        "city": city["name"].split("–")[0].split("-")[0].strip(),  # "Dallas–Fort Worth" -> "Dallas" for the query itself
        "state": city.get("state", ""),
        "country": "USA",
        "format": "jsonv2",
        "polygon_geojson": 1,
        "limit": 1,
        "addressdetails": 0,
    }
    headers = {
        # Required by Nominatim's usage policy — an empty/generic
        # User-Agent gets silently throttled or blocked.
        "User-Agent": settings.NOMINATIM_USER_AGENT,
        "Accept": "application/json",
    }
    log_req(f"GET {url}", params)
    try:
        async with httpx.AsyncClient(timeout=settings.NOMINATIM_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, params=params, headers=headers)
    except httpx.RequestError as exc:
        log_err("Nominatim request failed", {"city": city["id"], "error": str(exc)})
        raise BoundaryLookupError(f"Network error contacting Nominatim: {exc}") from exc

    if resp.status_code != 200:
        log_err("Nominatim returned non-200", {"city": city["id"], "status_code": resp.status_code})
        raise BoundaryLookupError(f"Nominatim returned {resp.status_code}")

    results = resp.json()
    if not results:
        log_err("Nominatim returned zero results", {"city": city["id"], "params": params})
        raise BoundaryLookupError(f"Nominatim found no boundary for {city['name']}, {city.get('state')}")

    geojson = results[0].get("geojson")
    if not geojson or geojson.get("type") not in ("Polygon", "MultiPolygon"):
        log_err("Nominatim result had no usable polygon", {"city": city["id"], "geojson_type": (geojson or {}).get("type")})
        raise BoundaryLookupError(f"Nominatim's match for {city['name']} has no polygon geometry (got a point/way, not an area)")

    log_res("Nominatim boundary fetched", {"city": city["id"], "type": geojson["type"]})
    return geojson


async def geocode_search(query: str, boundary_geojson: dict, limit: int = 5) -> list[dict]:
    """Phase 12.5d — forward-geocodes free text (an address, a place
    name, a landmark) into candidate points, so a trip's origin/
    destination can be typed instead of clicked on the map. Biased to
    the requesting city two ways: Nominatim's own viewbox+bounded=1 (so
    "Main St" without a city name still resolves to the right city
    first), THEN filtered again against the real boundary polygon —
    a bounding box has corners a real city outline doesn't, and this is
    the same boundary Heat-Safe Routing enforces routes against, so a
    searched address can never be "found" here but rejected once the
    trip is actually requested. Returns [] on a genuine zero-match
    search (not a failure); raises BoundaryLookupError only when
    Nominatim itself couldn't be reached at all."""
    min_lon, min_lat, max_lon, max_lat = bbox_of_geojson(boundary_geojson)
    url = f"{settings.NOMINATIM_BASE_URL}/search"
    params = {
        "q": query,
        "format": "jsonv2",
        # Nominatim's viewbox order is left,top,right,bottom = min_lon,max_lat,max_lon,min_lat.
        "viewbox": f"{min_lon},{max_lat},{max_lon},{min_lat}",
        "bounded": 1,
        # Over-fetch since the real-polygon filter below drops some of
        # these (viewbox is a box; the city outline isn't).
        "limit": max(limit * 3, 10),
        "addressdetails": 0,
    }
    headers = {"User-Agent": settings.NOMINATIM_USER_AGENT, "Accept": "application/json"}
    log_req(f"GET {url}", params)
    try:
        async with httpx.AsyncClient(timeout=settings.NOMINATIM_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, params=params, headers=headers)
    except httpx.RequestError as exc:
        log_err("Nominatim geocode request failed", {"query": query, "error": str(exc)})
        raise BoundaryLookupError(f"Network error contacting Nominatim: {exc}") from exc

    if resp.status_code != 200:
        log_err("Nominatim geocode returned non-200", {"query": query, "status_code": resp.status_code})
        raise BoundaryLookupError(f"Nominatim returned {resp.status_code}")

    matches: list[dict] = []
    for r in resp.json():
        try:
            lat, lon = float(r["lat"]), float(r["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        if not point_in_polygon(lat, lon, boundary_geojson):
            continue
        matches.append({"label": r.get("display_name", query), "lat": lat, "lon": lon})
        if len(matches) >= limit:
            break

    log_res("Nominatim geocode search", {"query": query, "matched": len(matches)})
    return matches


async def reverse_geocode(lat: float, lon: float) -> str | None:
    """Best-effort human-readable label for a raw point — used to label
    a "my location" pin and to build a readable share-location message.
    Deliberately swallows failures and returns None instead of raising:
    a missing label should never block sharing or using a raw coordinate
    that is otherwise perfectly usable on its own."""
    url = f"{settings.NOMINATIM_BASE_URL}/reverse"
    params = {"lat": lat, "lon": lon, "format": "jsonv2"}
    headers = {"User-Agent": settings.NOMINATIM_USER_AGENT, "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=settings.NOMINATIM_TIMEOUT_SECONDS) as client:
            resp = await client.get(url, params=params, headers=headers)
        if resp.status_code != 200:
            return None
        return resp.json().get("display_name")
    except httpx.RequestError as exc:
        log_err("Nominatim reverse geocode failed", {"lat": lat, "lon": lon, "error": str(exc)})
        return None
