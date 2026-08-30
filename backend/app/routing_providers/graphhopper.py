"""
GraphHopper Directions API — free tier, 500 requests/day, requires a key.

https://docs.graphhopper.com/#tag/Routing-API — `points_encoded=false`
asks for plain GeoJSON-style coordinate arrays instead of GraphHopper's
own encoded-polyline format, keeping this module symmetric with
osrm.py/ors.py rather than needing a third distinct decoder alongside
valhalla.py's. `algorithm=alternative_route` is what actually asks
GraphHopper for more than one distinct path back.
"""
import httpx

from ..config import settings
from ..logger import log_req, log_res, log_err
from .common import normalize_route


def is_configured() -> bool:
    return bool(settings.GRAPHHOPPER_API_KEY)


async def fetch_routes(origin: tuple[float, float], destination: tuple[float, float]) -> list[dict]:
    if not is_configured():
        return []

    o_lat, o_lon = origin
    d_lat, d_lon = destination
    url = f"{settings.GRAPHHOPPER_BASE_URL}/route"
    params = {
        "point": [f"{o_lat},{o_lon}", f"{d_lat},{d_lon}"],
        "profile": "car",
        "algorithm": "alternative_route",
        "alternative_route.max_paths": 3,
        "points_encoded": "false",
        "key": settings.GRAPHHOPPER_API_KEY,
    }
    try:
        async with httpx.AsyncClient() as client:
            log_req("GET GraphHopper route", {"origin": origin, "destination": destination})
            # httpx repeats a list-valued query param as multiple `point=`
            # entries, which is exactly the repeated-param format
            # GraphHopper's API expects for two points.
            resp = await client.get(url, params=params, timeout=settings.ROUTING_TIMEOUT_SECONDS)
            if resp.status_code != 200:
                log_err("GraphHopper non-200", {"status": resp.status_code, "body": resp.text[:300]})
                return []
            body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log_err("GraphHopper request failed", {"error": str(exc)})
        return []

    routes = []
    for path in body.get("paths", []):
        coords = (path.get("points") or {}).get("coordinates") or []
        geometry = [(lat, lon) for lon, lat in coords]
        # GraphHopper reports distance in meters and time in MILLIseconds
        # (not seconds like every other provider here) — easy to miss.
        distance_m = path.get("distance")
        duration_s = (path.get("time") or 0) / 1000
        normalized = normalize_route("graphhopper", geometry, distance_m, duration_s)
        if normalized:
            routes.append(normalized)

    log_res("GraphHopper routes fetched", {"count": len(routes)})
    return routes
