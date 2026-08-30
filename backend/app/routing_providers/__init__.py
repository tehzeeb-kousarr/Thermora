"""
Phase 12.5 — Heat-Safe Routing: free routing providers.

FortyGuard has no directions/routing endpoint, so candidate route
geometry comes from third-party routing services instead. Every provider
module in this package exposes exactly one async function:

    async def fetch_routes(origin: tuple[float, float],
                            destination: tuple[float, float]) -> list[dict]

`origin`/`destination` are (lat, lon). Each returned dict is normalized to
the SAME shape regardless of provider, so route_merge.py and
route_heat_scoring.py never need to know which service actually answered:

    {
        "provider": "osrm" | "valhalla" | "ors" | "graphhopper",
        "geometry": [(lat, lon), (lat, lon), ...],  # polyline, in order
        "distance_m": float,
        "duration_s": float,
    }

Every provider module fails soft: a timeout, non-200, malformed body, or
missing API key returns [] rather than raising. route_merge.py calls all
configured providers with asyncio.gather(..., return_exceptions=True) on
top of that, so a single provider being down never breaks routing —
Thermora only needs at least ONE of the four to answer.
"""
from .osrm import fetch_routes as fetch_osrm_routes
from .osrm import fetch_travel_times as fetch_osrm_travel_times
from .valhalla import fetch_routes as fetch_valhalla_routes
from .ors import fetch_routes as fetch_ors_routes
from .graphhopper import fetch_routes as fetch_graphhopper_routes

__all__ = [
    "fetch_osrm_routes",
    "fetch_osrm_travel_times",
    "fetch_valhalla_routes",
    "fetch_ors_routes",
    "fetch_graphhopper_routes",
]