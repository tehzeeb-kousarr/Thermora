from fastapi import APIRouter, HTTPException

from .. import repository as repo
from ..fortyguard_client import FortyGuardError
from ..logger import log_err
from ..schemas import SatelliteRequest

router = APIRouter(prefix="/api/satellite", tags=["satellite"])


@router.post("")
async def create_satellite(req: SatelliteRequest):
    date_time: dict = {"start_date": req.date, "filter_type": req.filter_type}
    if req.time:
        date_time["start_time"] = req.time
    if req.end_time:
        date_time["end_time"] = req.end_time

    payload = {
        "sat": {"latitude": req.latitude, "longitude": req.longitude},
        "date_time": date_time,
        "granularity": req.granularity,
    }

    try:
        result = await repo.get_satellite(payload, force_refresh=req.force_refresh)
    except FortyGuardError as exc:
        log_err("Satellite request failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return result
