"""
Valhalla public community demo server (FOSSGIS) — no API key.

https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/
Valhalla's routing engine/algorithm is genuinely different from OSRM's,
so it's kept as a separate provider specifically because it sometimes
proposes a meaningfully different path rather than just re-confirming
OSRM's own answer — see route_merge.py for how near-duplicate routes
across providers get deduped back down to one.

Valhalla encodes its returned shape as a Google polyline6 string (6
decimal-place precision, NOT the standard 5-place polyline used
elsewhere) rather than GeoJSON, so this module carries its own decoder.
"""
import httpx

from ..config import settings
from ..logger import log_req, log_res, log_err
from .common import normalize_route


def _decode_polyline6(encoded: str) -> list[tuple[float, float]]:
    """Decodes a Google-style encoded polyline at 1e-6 precision (Valhalla's
    default `shape_format`) into a list of (lat, lon) tuples."""
    coords: list[tuple[float, float]] = []
    index = 0
    lat = 0
    lon = 0
    length = len(encoded)
    while index < length:
        for is_lat in (True, False):
            shift = 0
            result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if (result & 1) else (result >> 1)
            if is_lat:
                lat += delta
            else:
                lon += delta
        coords.append((lat / 1e6, lon / 1e6))
    return coords


async def fetch_routes(origin: tuple[float, float], destination: tuple[float, float]) -> list[dict]:
    o_lat, o_lon = origin
    d_lat, d_lon = destination
    payload = {
        "locations": [
            {"lat": o_lat, "lon": o_lon},
            {"lat": d_lat, "lon": d_lon},
        ],
        "costing": "auto",
        "alternates": 2,
    }
    url = f"{settings.VALHALLA_BASE_URL}/route"
    try:
        async with httpx.AsyncClient() as client:
            log_req("POST Valhalla route", {"origin": origin, "destination": destination})
            resp = await client.post(url, json=payload, timeout=settings.ROUTING_TIMEOUT_SECONDS)
            if resp.status_code != 200:
                log_err("Valhalla non-200", {"status": resp.status_code, "body": resp.text[:300]})
                return []
            body = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log_err("Valhalla request failed", {"error": str(exc)})
        return []

    # A single /route call only ever returns the primary trip; alternates
    # (when Valhalla actually has one to offer) come back nested under
    # trip["alternates"] rather than as siblings.
    trips = [body["trip"]] if body.get("trip") else []
    for alt in body.get("alternates", []) or []:
        if alt.get("trip"):
            trips.append(alt["trip"])

    routes = []
    for trip in trips:
        legs = trip.get("legs", []) or []
        geometry: list[tuple[float, float]] = []
        for leg in legs:
            shape = leg.get("shape")
            if shape:
                geometry.extend(_decode_polyline6(shape))
        summary = trip.get("summary", {}) or {}
        distance_m = summary.get("length", 0) * 1000  # Valhalla reports km by default
        duration_s = summary.get("time", 0)
        normalized = normalize_route("valhalla", geometry, distance_m, duration_s)
        if normalized:
            routes.append(normalized)

    log_res("Valhalla routes fetched", {"count": len(routes)})
    return routes
