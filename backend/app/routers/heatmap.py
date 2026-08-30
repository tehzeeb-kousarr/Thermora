from fastapi import APIRouter, HTTPException

from .. import repository as repo
from ..fortyguard_client import bbox_to_polygon_aoi, FortyGuardValidationError, FortyGuardError
from ..logger import log_err
from ..schemas import HeatmapRequest

router = APIRouter(prefix="/api/heatmap", tags=["heatmap"])


@router.get("/history")
async def heatmap_history(city_id: str, limit: int = 10):
    """Real, database-backed 'recently viewed' list for a city — reflects
    what's actually cached in Postgres (fortyguard_activities), not a
    browser-local cache. Deleting the database empties this out too,
    because there's nowhere else for it to be coming from."""
    return {"entries": await repo.get_heatmap_history(city_id, limit=min(max(limit, 1), 50))}


def _build_payload(req: HeatmapRequest) -> dict:
    try:
        polygon_aoi = bbox_to_polygon_aoi(req.min_lat, req.min_lng, req.max_lat, req.max_lng)
    except FortyGuardValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    date_time: dict = {"start_date": req.date, "filter_type": req.filter_type}
    if req.time:
        date_time["start_time"] = req.time
    if req.end_time:
        date_time["end_time"] = req.end_time
    if req.end_date:
        date_time["end_date"] = req.end_date

    return {
        "polygon_aoi": polygon_aoi,
        "date_time": date_time,
        "granularity": req.granularity,
        "analytic_type": req.analytic_type,
        "threshold": req.threshold,
        "direction": req.direction,
    }


@router.post("")
async def create_heatmap(req: HeatmapRequest):
    """Returns IMMEDIATELY — either an already-cached result (status
    'Completed') or a signature to poll (status 'Processing'). This used
    to await the full FortyGuard submit+poll cycle inline, which held the
    HTTP connection open for however long that took (the 332-second hang,
    and the error on an hour change mid-wait, both trace back to this).
    The frontend now polls GET /status?signature=... — same pattern as
    Heat Intelligence's job endpoint."""
    payload = _build_payload(req)
    extra_payload_fields = {"purpose": req.purpose} if req.purpose else None

    try:
        result = await repo.start_heatmap(payload, force_refresh=req.force_refresh, extra_payload_fields=extra_payload_fields)
    except FortyGuardError as exc:
        log_err("Heatmap submission failed", {"error": str(exc)})
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return result


@router.get("/status")
async def heatmap_status(signature: str):
    """Polled by the frontend after POST above returns 'Processing'. Pure
    Postgres read — never touches FortyGuard directly."""
    return await repo.get_heatmap_status(signature)