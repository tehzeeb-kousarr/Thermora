from datetime import date as date_cls

from fastapi import APIRouter, HTTPException

from .. import advisor
from ..locations import get_city, local_today
from ..location_features import get_combined_features

router = APIRouter(tags=["advisor"])


@router.get("/api/cities/{city_id}/advisor")
async def get_advisor(city_id: str, persona: str = "resident", date: str | None = None):
    """Phase 13 — Local Heat Advisor. Same city-local-date resolution and
    same location_features read as GET /{city_id}/risk-score (see that
    route's docstring for why "most recently updated hour row" is the
    right combination here) — this endpoint adds no new fetch, it just
    reframes that same data per persona via advisor.generate_advisory()."""
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    if persona not in {p["key"] for p in advisor.PERSONAS}:
        raise HTTPException(status_code=400, detail=f"Unknown persona '{persona}'")

    if date:
        try:
            feature_date = date_cls.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    else:
        feature_date = local_today(city)

    features, used_hour = await get_combined_features(city_id, feature_date)
    result = await advisor.generate_advisory(features, persona)
    if used_hour:
        result["temperature_reading_hour"] = used_hour
    return result


@router.get("/api/advisor/personas")
async def list_personas():
    """Static list — lets the frontend build the persona selector without
    hardcoding persona keys/labels in two places. Not city-scoped (hence
    living outside /api/cities/{city_id}), since the persona set itself
    doesn't vary by city."""
    return {"personas": advisor.PERSONAS}