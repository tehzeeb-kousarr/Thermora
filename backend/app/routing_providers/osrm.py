"""
OSRM (Open Source Routing Machine) public demo server — no API key.

https://project-osrm.org/docs/v5.24.0/api/#route-service — the demo
server at router.project-osrm.org is rate-limited and explicitly NOT
meant for production traffic, but is free and keyless, which is exactly
what a hackathon MVP needs. `alternatives=true` asks OSRM directly for
more than one distinct route in a single call, which is why this
provider alone can return multiple entries.
"""
import httpx

from ..config import settings
from ..logger import log_req, log_res, log_err
from .common import normalize_route


async def fetch_travel_times(origin: tuple[float, float], destinations: list[tuple[float, float]]) -> list[dict | None]:
    """One-to-many drive time/distance via OSRM's Table service — used
    by routers/places.py to rank POI shortcuts (nearest hospital/school/
    pharmacy/...) by actual drive time instead of straight-line
    distance. A single Table call replaces N separate /route calls,
    which matters here since a POI list can be 8-10 points.

    Returns a list the SAME LENGTH and ORDER as `destinations`; each
    entry is either {"duration_s": float, "distance_m": float} or None
    (that one destination's leg came back unreachable/null — e.g. no
    road network match). Fails soft: any transport/parse problem with
    the whole request returns a list of Nones rather than raising, so a
    places.py caller can always fall back to straight-line distance.
    """
    if not destinations:
        return []
    o_lat, o_lon = origin
    # OSRM's coordinate path is lon,lat;lon,lat everywhere, table service
    # included — origin goes first (index 0), destinations follow in order.
    coords = f"{o_lon},{o_lat};" + ";".join(f"{lon},{lat}" for lat, lon in destinations)
    n = len(destinations)
    dest_indices = ";".join(str(i + 1) for i in range(n))
    url = f"{settings.OSRM_BASE_URL}/table/v1/driving/{coords}"
    params = {"sources": "0", "destinations": dest_indices, "annotations": "duration,distance"}
    try:
        async with httpx.AsyncClient() as client:
            log_req("GET OSRM table", {"origin": origin, "destination_count": n})
            resp = await client.get(url, params=params, timeout=settings.ROUTING_TIMEOUT_SECONDS)
            if resp.status_code != 200:
                log_err("OSRM table non-200", {"status": resp.status_code, "body": resp.text[:300]})
                return [None] * n
            body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log_err("OSRM table request failed", {"error": str(exc)})
        return [None] * n

    if body.get("code") != "Ok":
        log_err("OSRM table returned non-Ok code", {"code": body.get("code")})
        return [None] * n

    durations = (body.get("durations") or [[]])[0]
    distances = (body.get("distances") or [[]])[0]
    if len(durations) != n:
        log_err("OSRM table row length mismatch", {"expected": n, "got": len(durations)})
        return [None] * n

    results = []
    for i in range(n):
        d_s = durations[i]
        m = distances[i] if i < len(distances) else None
        if d_s is None or m is None:
            results.append(None)
        else:
            results.append({"duration_s": float(d_s), "distance_m": float(m)})

    log_res("OSRM table travel times fetched", {"count": sum(1 for r in results if r)})
    return results


async def fetch_routes(origin: tuple[float, float], destination: tuple[float, float]) -> list[dict]:
    o_lat, o_lon = origin
    d_lat, d_lon = destination
    # OSRM's URL path is lon,lat;lon,lat — the opposite order from the
    # (lat, lon) tuples this whole feature otherwise uses everywhere else,
    # easy to get backwards.
    url = f"{settings.OSRM_BASE_URL}/route/v1/driving/{o_lon},{o_lat};{d_lon},{d_lat}"
    params = {"alternatives": "true", "overview": "full", "geometries": "geojson"}
    try:
        async with httpx.AsyncClient() as client:
            log_req("GET OSRM route", {"origin": origin, "destination": destination})
            resp = await client.get(url, params=params, timeout=settings.ROUTING_TIMEOUT_SECONDS)
            if resp.status_code != 200:
                log_err("OSRM non-200", {"status": resp.status_code, "body": resp.text[:300]})
                return []
            body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log_err("OSRM request failed", {"error": str(exc)})
        return []

    if body.get("code") != "Ok":
        log_err("OSRM returned non-Ok code", {"code": body.get("code")})
        return []

    routes = []
    for route in body.get("routes", []):
        coords = (route.get("geometry") or {}).get("coordinates") or []
        # GeoJSON coordinates are [lon, lat] — flip to the (lat, lon)
        # convention used everywhere else in this feature.
        geometry = [(lat, lon) for lon, lat in coords]
        normalized = normalize_route("osrm", geometry, route.get("distance"), route.get("duration"))
        if normalized:
            routes.append(normalized)

    log_res("OSRM routes fetched", {"count": len(routes)})
    return routes