from datetime import date as date_cls

from fastapi import APIRouter, HTTPException

from .. import risk_score, impact_score
from .. import exposure_repository as exposure_repo
from ..locations import get_city, local_today
from ..location_features import get_combined_features
from ..logger import log_err

router = APIRouter(prefix="/api/cities", tags=["impact-score"])


@router.get("/{city_id}/impact-score")
async def get_impact_score(city_id: str, date: str | None = None):
    """Phase 9 — combines Phase 8's Heat Risk Score with Phase 6's OSM
    exposure data for the same monitored city. Reads location_features
    (Phase 5) exactly the way routers/risk.py does, and reads exposure
    the same cache-first way exposure_repository.get_exposure() always
    does (Postgres cache hit if the Dashboard's Exposure card already
    populated this city's AOI; a real Overpass/Geoapify call only
    happens on a genuine miss). No FortyGuard call happens here directly."""
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    if date:
        try:
            feature_date = date_cls.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    else:
        # City-local "today" — see routers/risk.py's identical fix and
        # locations.py's city_local_now/local_today for why.
        feature_date = local_today(city)

    features, used_hour = await get_combined_features(city_id, feature_date)
    risk_result = risk_score.compute_risk_score(features)
    if used_hour:
        risk_result["temperature_reading_hour"] = used_hour

    bbox = exposure_repo.default_bbox_for_city(city)
    try:
        exposure = await exposure_repo.get_exposure(
            bbox["min_lat"], bbox["min_lng"], bbox["max_lat"], bbox["max_lng"], force_refresh=False
        )
    except Exception as exc:  # noqa: BLE001 - a transient OSM failure shouldn't 500 this endpoint
        log_err("Impact score: exposure fetch failed", {"city": city_id, "error": str(exc)})
        exposure = None

    result = impact_score.compute_impact_score(risk_result, exposure)
    result["risk_score_detail"] = risk_result if risk_result.get("available") else None
    return result