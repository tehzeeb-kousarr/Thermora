from fastapi import APIRouter, HTTPException

from .. import repository as repo
from ..fortyguard_client import FortyGuardError
from ..logger import log_err
from ..schemas import EnvParamsRequest

router = APIRouter(prefix="/api/env-params", tags=["env-params"])


@router.post("")
async def create_env_params(req: EnvParamsRequest):
    date_time: dict = {"start_date": req.date, "filter_type": req.filter_type}
    if req.time:
        date_time["start_time"] = req.time
    if req.end_time:
        date_time["end_time"] = req.end_time
    if req.end_date:
        date_time["end_date"] = req.end_date

    payload = {
        "latitude": req.latitude,
        "longitude": req.longitude,
        "temperature": req.temperature,
        "date_time": date_time,
    }
    if req.analysis:
        payload["analysis"] = req.analysis

    try:
        result = await repo.get_env_params(payload, force_refresh=req.force_refresh)
    except FortyGuardError as exc:
        log_err("Env params request failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return result
