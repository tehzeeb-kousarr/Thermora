"""
Phase 12.5b — exposes each monitored city's cached boundary polygon to
the frontend, so the map can actually draw the outline Heat-Safe Routing
is enforced against (see routers/routing.py) instead of that boundary
being an invisible server-side-only rule. Read-through cache — see
city_boundary_repository.py for the actual fetch/cache logic; this
router is just the HTTP wrapper.
"""
from fastapi import APIRouter, HTTPException

from .. import city_boundary_repository
from ..locations import get_city
from ..nominatim_client import BoundaryLookupError

router = APIRouter(prefix="/api/cities", tags=["cities"])


@router.get("/{city_id}/boundary")
async def get_city_boundary(city_id: str):
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    try:
        boundary = await city_boundary_repository.get_boundary(city)
    except BoundaryLookupError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not load {city['name']}'s boundary right now ({exc}). Please try again shortly.",
        ) from exc

    return {"city_id": city_id, "geojson": boundary["geojson"], "cached": boundary["cached"]}
