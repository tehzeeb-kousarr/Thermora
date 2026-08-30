"""
Phase 6 — OSM Integration.

One clean client that queries OpenStreetMap (via the Overpass API) for
what's actually exposed inside an AOI: schools, hospitals/healthcare, and
a coarse residential/building/road density proxy. Deliberately "no
reasoning yet, just structured retrieval" — the roadmap is explicit that
scoring (People Impact Score, Phase 9) is a separate, later layer that
reads this data, not something this module does itself.

Overpass is a free, unauthenticated, but easily-overloaded public service —
this module treats 429/504 as transient (same spirit as fortyguard_client's
backoff, simpler since there's no submit/poll lifecycle here, just one
POST per query).
"""
import asyncio
import random
from typing import Any

import httpx

from .config import settings
from .logger import log_req, log_res, log_err

# Amenity tags that answer "who is exposed" in the way Thermora cares about:
# people concentrated somewhere vulnerable to heat (schools) or somewhere
# that becomes critical during a heat emergency (hospitals/clinics).
EDUCATION_AMENITIES = ["school", "kindergarten", "university", "college"]
HEALTHCARE_AMENITIES = ["hospital", "clinic", "doctors"]
# Phase 12.5d — Heat-Safe Routing's destination shortcuts (pharmacy,
# fire station) reuse this same client/pattern rather than a third OSM
# integration; these two categories aren't exposure-scoring inputs like
# the two above, just POI lookups for the routing UI.
PHARMACY_AMENITIES = ["pharmacy"]
FIRE_STATION_AMENITIES = ["fire_station"]
POLICE_AMENITIES = ["police"]
# "Cooling center" isn't a single standard OSM tag — libraries and
# community centres are the two amenity types most US cities actually
# designate/publicize as public cooling centers during a heat event, so
# this category is a best-effort proxy, not an official cooling-center
# registry. Labeled clearly as such in the frontend picker, not implied
# to be authoritative.
COOLING_CENTER_AMENITIES = ["library", "community_centre"]
_AMENITY_TYPE_MAP = {
    "school": "school", "kindergarten": "school", "university": "school", "college": "school",
    "hospital": "hospital", "clinic": "hospital", "doctors": "hospital",
    "pharmacy": "pharmacy", "fire_station": "fire_station",
    "police": "police", "library": "cooling_center", "community_centre": "cooling_center",
}

# Heat-Safe Routing destination-shortcut categories -> the OSM amenity
# values that answer each one. Kept separate from EDUCATION_AMENITIES/
# HEALTHCARE_AMENITIES above (which drive Phase 6 exposure scoring) so a
# future change to one never accidentally changes the other.
POI_CATEGORY_AMENITIES = {
    "hospital": HEALTHCARE_AMENITIES,
    "school": EDUCATION_AMENITIES,
    "pharmacy": PHARMACY_AMENITIES,
    "fire_station": FIRE_STATION_AMENITIES,
    "police": POLICE_AMENITIES,
    "cooling_center": COOLING_CENTER_AMENITIES,
}


def _bbox_clause(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> str:
    # Overpass bbox order is (south, west, north, east) = (min_lat, min_lng, max_lat, max_lng).
    return f"{min_lat},{min_lng},{max_lat},{max_lng}"


def _points_query(bbox: str) -> str:
    amenities = "|".join(EDUCATION_AMENITIES + HEALTHCARE_AMENITIES)
    return f"""
    [out:json][timeout:{int(settings.OVERPASS_TIMEOUT_SECONDS)}];
    (
      node["amenity"~"^({amenities})$"]({bbox});
      way["amenity"~"^({amenities})$"]({bbox});
    );
    out center tags;
    """


def _amenity_query(bbox: str, amenities: list[str]) -> str:
    """Same shape as _points_query above, parametrized over an arbitrary
    amenity list so hospital/school/pharmacy/fire_station POI lookups
    (Heat-Safe Routing's destination shortcuts) all reuse one query
    builder instead of four near-identical ones."""
    joined = "|".join(amenities)
    return f"""
    [out:json][timeout:{int(settings.OVERPASS_TIMEOUT_SECONDS)}];
    (
      node["amenity"~"^({joined})$"]({bbox});
      way["amenity"~"^({joined})$"]({bbox});
    );
    out center tags;
    """


def _density_query(bbox: str) -> str:
    # Three named sets, each summarized with `out count;` instead of
    # fetching full geometry — keeps this cheap even over a dense downtown
    # AOI where full building/road geometry would be enormous.
    #
    # NOTE: this used to be `(.b; out count;); (.r; out count;); (.h; out
    # count;);` — that's not valid Overpass QL (confirmed by a real 400
    # from overpass-api.de in testing). The correct, documented idiom for
    # "output a named set's count without touching the default set" is
    # `.setname out count;` as its own statement, no parentheses.
    return f"""
    [out:json][timeout:{int(settings.OVERPASS_TIMEOUT_SECONDS)}];
    way["building"]({bbox})->.b;
    way["landuse"="residential"]({bbox})->.r;
    way["highway"]({bbox})->.h;
    .b out count;
    .r out count;
    .h out count;
    """


def _road_count_query(bbox: str) -> str:
    """Standalone, single-purpose query used for best-effort road-count
    enrichment when the main points/density fetch came from a different
    provider (Geoapify) that doesn't cover linear road geometry."""
    return f"""
    [out:json][timeout:{int(settings.OVERPASS_TIMEOUT_SECONDS)}];
    way["highway"]({bbox});
    out count;
    """


def _mirror_urls() -> list[str]:
    # Primary first, then fallback mirrors — de-duplicated, order preserved.
    urls = [settings.OVERPASS_BASE_URL, *settings.OVERPASS_FALLBACK_URLS]
    seen: set[str] = set()
    ordered: list[str] = []
    for u in urls:
        if u and u not in seen:
            seen.add(u)
            ordered.append(u)
    return ordered


async def _run_query(client: httpx.AsyncClient, query: str, label: str) -> dict:
    log_req(f"POST Overpass ({label})", {"query": query.strip()})
    headers = {
        # Required by Overpass's Apache front-ends — requests with a blank
        # or generic User-Agent are rejected with 406 Not Acceptable before
        # the query is even parsed.
        "User-Agent": settings.OVERPASS_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }
    last_error: Exception | None = None

    for base_url in _mirror_urls():
        for attempt in range(1, 4):
            try:
                resp = await client.post(
                    base_url,
                    data={"data": query},
                    headers=headers,
                    timeout=settings.OVERPASS_TIMEOUT_SECONDS + 5,
                )
            except httpx.ConnectError as exc:
                # DNS failure / refused connection / no route to host — this
                # mirror is unreachable, not just momentarily busy. Retrying
                # the same dead host 3x with backoff just burns time; fail
                # straight to the next mirror instead.
                last_error = exc
                log_err(f"Overpass unreachable ({label}) @ {base_url} — trying next mirror", {"error": str(exc)})
                break
            except httpx.RequestError as exc:
                # Timeouts and other transient I/O errors ARE worth retrying
                # against the same host before giving up on it.
                last_error = exc
                log_err(f"Overpass network error ({label}) @ {base_url}", {"error": str(exc)})
                if attempt < 3:
                    await asyncio.sleep(1.5 * attempt)
                    continue
                break

            if resp.status_code == 200:
                body = resp.json()
                log_res(f"Overpass responded ({label}) @ {base_url}", {"element_count": len(body.get("elements", []))})
                return body

            if resp.status_code in (429, 504) and attempt < 3:
                delay = (2 ** attempt) * (0.75 + random.random() * 0.5)
                log_err(f"Overpass {resp.status_code} ({label}) @ {base_url} — retrying in {delay:.1f}s", {})
                await asyncio.sleep(delay)
                continue

            last_error = RuntimeError(f"Overpass returned {resp.status_code}: {resp.text[:300]}")
            log_err(f"Overpass request failed ({label}) @ {base_url}", {"status_code": resp.status_code})
            break  # try next mirror, if any

    raise last_error or RuntimeError(f"Overpass query failed ({label})")


def _extract_point(el: dict) -> dict | None:
    tags = el.get("tags", {})
    amenity = tags.get("amenity")
    point_type = _AMENITY_TYPE_MAP.get(amenity)
    if point_type is None:
        return None
    if el["type"] == "node":
        lat, lon = el.get("lat"), el.get("lon")
    else:
        center = el.get("center") or {}
        lat, lon = center.get("lat"), center.get("lon")
    if lat is None or lon is None:
        return None
    return {
        "type": point_type,
        "name": tags.get("name") or amenity.replace("_", " ").title(),
        "lat": lat,
        "lon": lon,
        "source": "osm",
    }


def _extract_counts(body: dict) -> dict:
    counts = [el.get("tags", {}) for el in body.get("elements", []) if el.get("type") == "count"]
    # Order matches the three named sets in _density_query: building, residential, highway.
    def total(i: int) -> int:
        try:
            return int(counts[i].get("total", 0))
        except (IndexError, ValueError, TypeError):
            return 0
    return {
        "building_count": total(0),
        "residential_landuse_count": total(1),
        "road_count": total(2),
    }


async def fetch_exposure(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> dict:
    """Returns {"points": [...], "density": {...}} for the given AOI —
    exactly the shape stored in Postgres by exposure_repository."""
    bbox = _bbox_clause(min_lat, min_lng, max_lat, max_lng)
    async with httpx.AsyncClient() as client:
        points_body, density_body = await asyncio.gather(
            _run_query(client, _points_query(bbox), "points"),
            _run_query(client, _density_query(bbox), "density"),
        )

    points = [p for el in points_body.get("elements", []) if (p := _extract_point(el)) is not None]
    density = _extract_counts(density_body)
    return {"points": points, "density": density}


async def fetch_pois(min_lat: float, min_lng: float, max_lat: float, max_lng: float, category: str) -> list[dict]:
    """Phase 12.5d — nearby POIs for Heat-Safe Routing's destination
    shortcuts (hospital/school/pharmacy/fire_station), scoped to an AOI
    bbox (routers/places.py passes the requesting city's own boundary
    bbox). Raises ValueError for an unknown category rather than
    silently returning nothing — the router turns that into a 400, not
    a confusing empty list."""
    amenities = POI_CATEGORY_AMENITIES.get(category)
    if not amenities:
        raise ValueError(f"Unknown POI category '{category}' (expected one of {list(POI_CATEGORY_AMENITIES)})")
    bbox = _bbox_clause(min_lat, min_lng, max_lat, max_lng)
    async with httpx.AsyncClient() as client:
        body = await _run_query(client, _amenity_query(bbox, amenities), f"poi-{category}")
    return [p for el in body.get("elements", []) if (p := _extract_point(el)) is not None]


async def fetch_road_count(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> int:
    """Standalone road-segment count — used as best-effort enrichment when
    the primary points/density provider was Geoapify (which doesn't cover
    linear road geometry). Deliberately isolated from fetch_exposure so a
    slow/unreachable Overpass here never blocks the points/density that
    already succeeded via the other provider."""
    bbox = _bbox_clause(min_lat, min_lng, max_lat, max_lng)
    async with httpx.AsyncClient() as client:
        body = await _run_query(client, _road_count_query(bbox), "road-count")
    counts = [el.get("tags", {}) for el in body.get("elements", []) if el.get("type") == "count"]
    try:
        return int(counts[0].get("total", 0)) if counts else 0
    except (ValueError, TypeError):
        return 0