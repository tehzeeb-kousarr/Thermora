from datetime import date as date_cls
import json

from fastapi import APIRouter, HTTPException

from .. import risk_score
from ..db import get_pool
from ..locations import get_city, local_today
from ..location_features import get_combined_features

router = APIRouter(prefix="/api/cities", tags=["risk-score"])

_LABEL_TO_ANALYTIC_TYPE = {"Exceedance": "exceedance", "Persistence": "persistence"}


async def _diagnose_missing_factor(pool, city_id: str, feature_date: date_cls, analytic_type: str) -> str | None:
    """A factor missing from location_features looks the same whether it
    was never requested, or WAS requested and completed but FortyGuard
    handed back zero usable tiles for that exact window (get_heatmap
    correctly skips writing location_features for an empty result — see
    its own docstring — but that leaves no way to tell the two cases
    apart from location_features alone). Uses the 'risk_factor_background'
    purpose tag (see liveDataStore.js's primeRiskScoreFactor) to find the
    specific riskBoost request for this factor, if one was ever made, and
    checks what it actually got back."""
    row = await pool.fetchrow(
        """
        SELECT h.activity_id, h.map_data
        FROM fortyguard_activities fa
        JOIN heatmaps h ON h.activity_id = fa.activity_id
        WHERE fa.endpoint_type = 'heatmap'
          AND fa.status = 'Completed'
          AND fa.request_payload->>'purpose' = 'risk_factor_background'
          AND fa.request_payload->>'analytic_type' = $1
          AND fa.request_payload->'date_time'->>'start_date' = $2
        ORDER BY fa.submitted_at DESC LIMIT 1
        """,
        analytic_type, feature_date.isoformat(),
    )
    if not row:
        return None  # genuinely never attempted — the generic reason already covers this

    map_data = row["map_data"]
    if isinstance(map_data, str):
        map_data = json.loads(map_data)
    if not (map_data or {}).get("features"):
        return (f"A {analytic_type} request for this exact date DID complete, but FortyGuard "
                f"returned zero usable tiles for it — most likely today's date if the day isn't "
                f"over yet (a full-day metric can't be computed from a partial day), otherwise a "
                f"transient gap. Not a bug in this app; try again later or pick an earlier date.")

    # It completed AND had real tiles — so record_heatmap_result should
    # have written this factor into location_features's DAY row. This
    # used to just return None here with a comment admitting "wasn't
    # written to location_features for some other reason" — which meant
    # the one case that's actually a bug in THIS app (as opposed to a
    # FortyGuard-side gap) produced literally zero explanation. Check
    # whether that write actually landed, and say so plainly if it didn't
    # — this is the one outcome here that isn't expected/normal behavior.
    column = "exceedance_hours" if analytic_type == "exceedance" else "persistence_hours"
    feature_row = await pool.fetchrow(
        f"SELECT {column} FROM location_features WHERE city_id = $1 AND feature_date = $2 AND feature_hour = 'DAY'",
        city_id, feature_date,
    )
    if feature_row is None or feature_row[column] is None:
        return (f"A {analytic_type} request for this exact date completed with real data "
                f"(activity {row['activity_id']}), but it never got saved into this city's "
                f"derived features. This is unexpected — please report it. Since this can be a "
                f"silent failure inside record_heatmap_result (it swallows exceptions and only "
                f"logs 'Failed to populate location_features from heatmap result' when one is "
                f"actually raised), the backend log for activity {row['activity_id']} may show "
                f"nothing at all — that's still evidence something upstream of the exception "
                f"handler didn't produce a value it should have.")
    return None  # a value IS recorded — compute_risk_score's caller should already be seeing it


@router.get("/{city_id}/risk-score")
async def get_risk_score(city_id: str, date: str | None = None):
    """Pure computation over data already in Postgres (Phase 5's
    location_features) — no FortyGuard call, no external dependency.
    Defaults to today; pass ?date=YYYY-MM-DD for any other day that's
    already had a heatmap/env-params fetch recorded.

    location_features now has one row per (city, date, hour) instead of
    one per (city, date) — see db.py's schema comment and
    location_features.py's module docstring for why (an hour-scoped heat
    index used to sit in the same row as a day-scoped exceedance count
    with nothing recording which hour the heat index was even for). This
    endpoint combines the two kinds of row back into one feature set:
    the day-scoped 'DAY' row (exceedance_hours, persistence_hours) plus
    whichever hour-scoped row is most recently updated for this date
    (mean/max/min temp, heat index, wet bulb, humidity, AQI) — since this
    route is only ever called with a date, not a specific hour, "most
    recent" is the closest honest match to "what the user was just
    looking at"."""
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    if date:
        try:
            feature_date = date_cls.fromisoformat(date)
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
    else:
        # City-local "today", not the server's — see locations.py's
        # city_local_now/local_today for why: this city's location_features
        # rows are keyed to ITS OWN local calendar day (that's what
        # scheduler.py now writes them under too), not whatever day it
        # happens to be on the server's clock.
        feature_date = local_today(city)

    pool = get_pool()
    features, used_hour = await get_combined_features(city_id, feature_date)

    result = risk_score.compute_risk_score(features)
    if used_hour:
        result["temperature_reading_hour"] = used_hour

    if result.get("available") and result.get("missing_factors"):
        notes = {}
        for label in result["missing_factors"]:
            analytic_type = _LABEL_TO_ANALYTIC_TYPE.get(label)
            if not analytic_type:
                continue
            note = await _diagnose_missing_factor(pool, city_id, feature_date, analytic_type)
            if note:
                notes[label] = note
        if notes:
            result["missing_factor_notes"] = notes

    return result