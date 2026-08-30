"""
Phase 12.5 — Heat-Safe Routing: merge candidate routes from every
configured provider into one deduplicated set.

Calls all four routing_providers modules concurrently, tolerates any of
them failing/being unconfigured, flattens their results, and collapses
routes that are effectively the same road path (even if two or three
providers all proposed it) down to one entry — see
_are_same_route/dedupe_routes below.
"""
import asyncio

from . import routing_providers as providers
from .config import settings
from .logger import log_err, log_res


async def fetch_candidate_routes(origin: tuple[float, float], destination: tuple[float, float]) -> list[dict]:
    """Returns a deduplicated list of normalized route dicts (see
    routing_providers/__init__.py for the shape) pooled from every
    provider. Never raises — a provider throwing is caught here and
    logged, same soft-fail contract each provider module already applies
    to its own network errors; this is the outer safety net in case a
    provider module has a bug that raises anyway."""
    tasks = [
        providers.fetch_osrm_routes(origin, destination),
        providers.fetch_valhalla_routes(origin, destination),
        providers.fetch_ors_routes(origin, destination),
        providers.fetch_graphhopper_routes(origin, destination),
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    pooled: list[dict] = []
    for result in results:
        if isinstance(result, Exception):
            log_err("Routing provider raised", {"error": str(result)})
            continue
        pooled.extend(result)

    deduped = dedupe_routes(pooled)
    log_res("Route candidates merged", {"raw_count": len(pooled), "deduped_count": len(deduped)})
    return deduped


def _resample(geometry: list[tuple[float, float]], n: int = 12) -> list[tuple[float, float]]:
    """Picks n evenly-index-spaced points out of a route's polyline for a
    cheap overlap comparison. Not distance-accurate (index spacing, not
    arc-length spacing) but that's fine here — this only needs to tell
    "basically the same road path" apart from "a meaningfully different
    one", not measure anything precisely."""
    if len(geometry) <= n:
        return geometry
    step = (len(geometry) - 1) / (n - 1)
    return [geometry[round(i * step)] for i in range(n)]


def _point_near(point: tuple[float, float], geometry: list[tuple[float, float]], threshold_deg: float) -> bool:
    lat, lon = point
    for g_lat, g_lon in geometry:
        if ((g_lat - lat) ** 2 + (g_lon - lon) ** 2) ** 0.5 <= threshold_deg:
            return True
    return False


def _are_same_route(a: dict, b: dict) -> bool:
    """Two routes count as duplicates when most of one route's sampled
    points each land close to SOME point on the other route's path.
    Comparing resampled points against the whole other polyline (rather
    than pairing up same-index points) is what makes this robust to the
    two providers having produced a different NUMBER of shape points for
    the same physical road path, which is completely normal."""
    threshold = settings.ROUTE_DEDUPE_DISTANCE_DEG
    required = settings.ROUTE_DEDUPE_OVERLAP_FRACTION
    sample_a = _resample(a["geometry"])
    sample_b = _resample(b["geometry"])
    if not sample_a or not sample_b:
        return False
    matches = sum(1 for p in sample_a if _point_near(p, sample_b, threshold))
    overlap_fraction = matches / len(sample_a)
    return overlap_fraction >= required


def dedupe_routes(routes: list[dict], max_routes: int = 5) -> list[dict]:
    """Keeps the first-seen route out of each duplicate cluster (provider
    order above is deterministic, so this is stable run-to-run), capped
    at max_routes total so a route with many near-duplicates across
    providers doesn't crowd out genuinely different alternatives further
    down the pooled list."""
    unique: list[dict] = []
    for route in routes:
        if any(_are_same_route(route, existing) for existing in unique):
            continue
        unique.append(route)
        if len(unique) >= max_routes:
            break
    return unique
