import asyncio
from datetime import date as date_cls

from fastapi import APIRouter, HTTPException

from .. import alerts_repository, emergency_score, impact_score, risk_score
from .. import exposure_repository as exposure_repo
from ..locations import MONITORED_CITIES, get_city, local_today
from ..location_features import get_combined_features
from ..logger import log_err

router = APIRouter(prefix="/api/cities", tags=["emergency"])

# Which OSM point types VulnerableAssets shows — must match exactly what
# impact_score.py itself counts into exposure_counts.schools/hospitals
# (osm_client.py's AMENITY_TYPE_MAP already normalizes school/kindergarten/
# university/college -> "school" and hospital/clinic/doctors -> "hospital"),
# so the list ever shown always matches the counts shown next to it.
_VULNERABLE_SITE_TYPES = {"school", "hospital"}


async def _gather_emergency_status(city: dict, feature_date: date_cls) -> dict:
    """The actual gather-three-things-and-score logic, factored out so
    both the single-city endpoint and the all-cities endpoint below run
    the exact same read path — no duplicated (and potentially drifting)
    copy of it."""
    city_id = city["id"]

    # --- Risk Score (Phase 8) — identical read path to routers/risk.py ---
    features, used_hour = await get_combined_features(city_id, feature_date)
    risk_result = risk_score.compute_risk_score(features)
    if used_hour and risk_result.get("available"):
        risk_result["temperature_reading_hour"] = used_hour

    # --- Impact Score (Phase 9) — identical read path to routers/impact.py ---
    bbox = exposure_repo.default_bbox_for_city(city)
    try:
        exposure = await exposure_repo.get_exposure(
            bbox["min_lat"], bbox["min_lng"], bbox["max_lat"], bbox["max_lng"], force_refresh=False
        )
    except Exception as exc:  # noqa: BLE001 - a transient OSM failure shouldn't 500 this endpoint
        log_err("Emergency status: exposure fetch failed", {"city": city_id, "error": str(exc)})
        exposure = None
    impact_result = impact_score.compute_impact_score(risk_result, exposure)

    # --- Official alerts (Phase 7) — identical read path to routers/alerts.py ---
    try:
        alerts_bundle = await alerts_repository.get_alerts(city, force_refresh=False)
        alerts = alerts_bundle.get("alerts", [])
    except Exception as exc:  # noqa: BLE001 - a transient NWS failure shouldn't 500 this endpoint
        log_err("Emergency status: alerts fetch failed", {"city": city_id, "error": str(exc)})
        alerts = []

    result = emergency_score.compute_emergency_status(risk_result, impact_result, alerts)
    # Full detail objects included too, same convention as routers/impact.py
    # attaching risk_score_detail — the frontend can show the summary
    # (status/reasons/actions) without a second round trip, and drill
    # into the full breakdown if it wants to.
    result["risk_score_detail"] = risk_result if risk_result.get("available") else None
    result["impact_score_detail"] = impact_result if impact_result.get("available") else None
    result["alerts"] = alerts
    # Real schools/hospitals from Phase 6's exposure_repository.get_exposure
    # `points` list — same source and same type-filter impact_score.py's
    # own exposure_counts.schools/hospitals already use, so the two can
    # never disagree. This was previously never attached, so
    # EmergencyModeView's VulnerableAssets section always received
    # undefined and silently never rendered, even when real schools/
    # hospitals had already been found for this AOI.
    exposure_points = (exposure or {}).get("points", [])
    result["vulnerable_sites"] = [
        p for p in exposure_points if p.get("type") in _VULNERABLE_SITE_TYPES
    ]
    return result


@router.get("/{city_id}/emergency-status")
async def get_emergency_status(city_id: str, date: str | None = None):
    """Phase 10 — deterministic Emergency Mode trigger. Gathers the same
    three things Phases 7-9 already produce, the same way their own
    routers do (routers/impact.py's risk+exposure flow, plus
    routers/alerts.py's alerts flow), then hands them to
    emergency_score.compute_emergency_status() for the actual rules
    check. No FortyGuard/OSM/NWS call happens directly in this router —
    on a cache miss, the underlying repositories make the same calls
    they always do for their own endpoints."""
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

    return await _gather_emergency_status(city, feature_date)


# Status→sort-rank, worst first — mirrors emergency_score.STATUS_META's
# own severity ordering rather than inventing a second scale.
_STATUS_RANK = {"EMERGENCY": 0, "WATCH": 1, "NORMAL": 2}


@router.get("/emergency-status-all")
async def get_emergency_status_all():
    """Backs thermoraApi.js's fetchAllCitiesEmergencyStatus — every
    MONITORED_CITY's current status, computed via the exact same
    _gather_emergency_status() helper as the single-city endpoint above
    (same cache-first repository reads, nothing new), run concurrently
    since this fans out to every monitored city at once. Always "today"
    per city, deliberately — there's no single meaningful "applied date"
    across every monitored city at once the way there is for one city's
    own view.

    One city's failure (a transient DB hiccup, a bad city entry) is
    logged and that city is simply omitted from the ranking, instead of
    failing the whole endpoint and blanking every other city's status
    along with it.
    """

    async def _one(city: dict) -> dict | None:
        try:
            # Each city's OWN local "today", not one shared date for all
            # of them — this docstring already said "per city,
            # deliberately", but the code computed a single date_cls.today()
            # ONCE outside this loop and reused it for every city
            # regardless of timezone, which is exactly the bug the comment
            # claims not to have: Miami (America/New_York) and Phoenix
            # (America/Phoenix) can legitimately be on different calendar
            # dates from each other at the same real-world instant, let
            # alone from the server's own clock.
            result = await _gather_emergency_status(city, local_today(city))
        except Exception as exc:  # noqa: BLE001 - one city's failure shouldn't blank the rest
            log_err("emergency-status-all: city failed", {"city": city["id"], "error": str(exc)})
            return None
        return {
            "city_id": city["id"],
            "city_name": city["name"],
            "status": result["status"],
            "status_label": result["status_label"],
            "headline": (result["reasons"][0]["detail"] if result["reasons"] else None),
            "risk_score": result["risk_score"],
            "impact_score": result["impact_score"],
        }

    gathered = await asyncio.gather(*(_one(c) for c in MONITORED_CITIES))
    cities = [c for c in gathered if c is not None]
    cities.sort(key=lambda c: (_STATUS_RANK.get(c["status"], 9), -(c["risk_score"] or 0)))
    return {"cities": cities}