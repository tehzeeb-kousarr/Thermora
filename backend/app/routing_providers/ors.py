"""
OpenRouteService (ORS) — free tier, 2,000 requests/day, requires a key.

https://openrouteservice.org/dev/#/api-docs/v2/directions — chosen as one
of the four providers specifically for its `avoid_polygons` option, which
this MVP doesn't use yet but which is the natural next step for a
"actively route AROUND a known extreme-heat zone" feature (as opposed to
just scoring/ranking routes someone else already generated). Also
supports multiple travel profiles (driving-car, foot-walking,
cycling-regular) if Thermora ever needs anything other than driving.
"""
import httpx

from ..config import settings
from ..logger import log_req, log_res, log_err
from .common import normalize_route


def is_configured() -> bool:
    return bool(settings.ORS_API_KEY)


async def fetch_routes(origin: tuple[float, float], destination: tuple[float, float]) -> list[dict]:
    if not is_configured():
        return []

    o_lat, o_lon = origin
    d_lat, d_lon = destination
    url = f"{settings.ORS_BASE_URL}/v2/directions/driving-car/geojson"
    headers = {"Authorization": settings.ORS_API_KEY, "Content-Type": "application/json"}
    # ORS coordinates are [lon, lat], same GeoJSON convention as OSRM.
    payload = {
        "coordinates": [[o_lon, o_lat], [d_lon, d_lat]],
        "alternative_routes": {"target_count": 2, "share_factor": 0.6, "weight_factor": 1.4},
    }
    try:
        async with httpx.AsyncClient() as client:
            log_req("POST ORS directions", {"origin": origin, "destination": destination})
            resp = await client.post(url, json=payload, headers=headers, timeout=settings.ROUTING_TIMEOUT_SECONDS)
            if resp.status_code != 200:
                log_err("ORS non-200", {"status": resp.status_code, "body": resp.text[:300]})
                return []
            body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log_err("ORS request failed", {"error": str(exc)})
        return []

    routes = []
    for feature in body.get("features", []):
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        geometry = [(lat, lon) for lon, lat in coords]
        summary = (feature.get("properties") or {}).get("summary") or {}
        normalized = normalize_route("ors", geometry, summary.get("distance"), summary.get("duration"))
        if normalized:
            routes.append(normalized)

    log_res("ORS routes fetched", {"count": len(routes)})
    return routes
