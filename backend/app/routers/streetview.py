from fastapi import APIRouter, HTTPException

from .. import repository as repo
from ..fortyguard_client import FortyGuardError
from ..logger import log_err
from ..schemas import StreetviewRequest

router = APIRouter(prefix="/api/streetview", tags=["streetview"])


@router.post("")
async def create_streetview(req: StreetviewRequest):
    payload = {
        "latitude": req.latitude,
        "longitude": req.longitude,
        "vertical_angle": req.vertical_angle,
        "horizontal_angle": req.horizontal_angle,
        "back_view": req.back_view,
    }

    try:
        result = await repo.get_streetview(payload, force_refresh=req.force_refresh)
    except FortyGuardError as exc:
        log_err("Streetview request failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return result
