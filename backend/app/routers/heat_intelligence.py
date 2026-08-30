import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from .. import repository as repo
from ..fortyguard_client import FortyGuardError
from ..logger import log_err
from ..schemas import HeatIntelligenceRequest

router = APIRouter(prefix="/api/heat-intelligence", tags=["heat-intelligence"])


@router.post("")
async def create_heat_intelligence(req: HeatIntelligenceRequest):
    """Starts a Heat Intelligence job and returns IMMEDIATELY with a job
    id + status — this never blocks on FortyGuard's own processing time
    (their docs say Heat Intelligence 'may take several minutes'). The
    frontend polls GET /{activity_id}/status to find out when it's done,
    which reads Postgres — never FortyGuard directly."""
    payload = {
        "latitude": req.latitude,
        "longitude": req.longitude,
        "temperature": req.temperature,
        "date": req.date,
        "analysis": req.analysis,
    }

    try:
        result = await repo.start_heat_intelligence(payload, force_refresh=req.force_refresh)
    except FortyGuardError as exc:
        log_err("Heat Intelligence submission failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return result


@router.get("/{activity_id}/status")
async def get_heat_intelligence_status(activity_id: str):
    """Polled by the frontend after POST above returns 'Processing'.
    Pure Postgres read — the actual FortyGuard polling happens in a
    background task (repository._heat_intelligence_job), independently of
    any particular HTTP request being open."""
    try:
        return await repo.get_heat_intelligence_status(activity_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Unknown activity_id '{activity_id}'")


@router.get("/{activity_id}/download")
async def download_heat_intelligence(activity_id: str):
    result = await repo.get_heat_intelligence_by_activity(activity_id)
    if not result or not os.path.exists(result["file_path"]):
        raise HTTPException(status_code=404, detail="Report not found")
    return FileResponse(result["file_path"], media_type="application/pdf",
                         filename=f"heat_intelligence_{activity_id}.pdf")