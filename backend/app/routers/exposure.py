from fastapi import APIRouter, HTTPException

from .. import exposure_repository as repo
from ..fortyguard_client import FortyGuardValidationError
from ..logger import log_err
from ..schemas import ExposureRequest

router = APIRouter(prefix="/api/exposure", tags=["exposure"])


@router.post("")
async def get_exposure(req: ExposureRequest):
    if req.max_lat <= req.min_lat or req.max_lng <= req.min_lng:
        raise HTTPException(status_code=400, detail="max_lat/max_lng must be strictly greater than min_lat/min_lng")

    try:
        result = await repo.get_exposure(
            req.min_lat, req.min_lng, req.max_lat, req.max_lng, force_refresh=req.force_refresh
        )
    except Exception as exc:  # noqa: BLE001
        log_err("Exposure request failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=f"OSM/Overpass request failed: {exc}") from exc

    return result
