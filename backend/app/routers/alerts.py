from fastapi import APIRouter, HTTPException

from .. import alerts_repository as repo
from ..locations import get_city
from ..logger import log_err

router = APIRouter(prefix="/api/cities", tags=["alerts"])


@router.get("/{city_id}/alerts")
async def get_city_alerts(city_id: str, force_refresh: bool = False):
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    try:
        result = await repo.get_alerts(city, force_refresh=force_refresh)
    except Exception as exc:  # noqa: BLE001
        log_err("NWS alerts request failed", {"city_id": city_id, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"NWS request failed: {exc}") from exc

    return result
