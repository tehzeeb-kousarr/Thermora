"""
Phase 8 — Heat Risk Score.

Deterministic, explainable scoring over `location_features` (Phase 5) —
no new external dependency, no model, no black box. Every factor below is
a plain piecewise-linear curve from a real physical/regulatory reference
point to a 0-100 sub-score; the final score is a weighted sum of whichever
sub-scores actually have data, with weights re-normalized over the
available ones so a missing reading never silently drags the score down.

Factor choices, and why:
  - Heat index and wet-bulb temperature BOTH already fold temperature and
    humidity together (that's what they physically are), so raw
    mean/max temperature is deliberately NOT its own weighted factor —
    including it again would triple-count the same underlying heat
    signal. Raw temperature is still shown in the response as context.
  - Exceedance/persistence calibration: FortyGuard's docs define
    `exceedance_hours` as "hours the temperature passed the threshold"
    and `persistence_hours` as "longest continuous run above it" — both
    genuinely capped around 0-24 for a single-day query (this app's
    default heatmap window). Curves below are calibrated against that
    real range, not an arbitrary "degree-hours" scale.
  - AQI is included because Phase 5 already stores it (no new fetch
    needed) and heat + poor air quality is a well-documented compounding
    cardiovascular/respiratory stressor — a legitimate "environmental
    conditions" factor per the roadmap's own Phase 8 description.
  - Solar exposure is explicitly NOT included, honestly: location_features
    has no solar irradiance column (Phase 5 never captured it), and this
    module only computes from data that's actually stored — inventing a
    solar factor from nothing would be exactly the black-box behavior
    this phase is supposed to avoid.
"""

# Each curve: sorted (value, sub_score_0_to_100) control points. Values
# between points are linearly interpolated; below the first point clamps
# to its score, above the last clamps to its score.

HEAT_INDEX_CURVE_C = [
    (27.0, 0),    # ~80°F — NWS "Caution" floor
    (32.0, 25),   # ~90°F — NWS "Caution"
    (39.0, 55),   # ~103°F — NWS "Extreme Caution" / "Danger" boundary
    (41.0, 70),   # ~106°F — solidly in NWS "Danger"
    (52.0, 100),  # ~125°F — NWS "Extreme Danger"
]

WET_BULB_CURVE_C = [
    (21.0, 0),
    (27.0, 30),   # already taxing for sustained outdoor exertion
    (30.0, 55),
    (33.0, 80),
    (35.0, 100),  # Sherwood & Huber's physiological survivability ceiling
]

EXCEEDANCE_CURVE_HOURS = [
    (0.0, 0),
    (3.0, 25),
    (8.0, 55),
    (14.0, 80),
    (20.0, 100),
]

PERSISTENCE_CURVE_HOURS = [
    (0.0, 0),
    (2.0, 20),
    (4.0, 45),
    (8.0, 75),    # sustained multi-hour heat — meaningfully more dangerous than brief spikes
    (14.0, 100),
]

AQI_CURVE = [
    (50.0, 0),    # EPA "Good"
    (100.0, 20),  # EPA "Moderate"
    (150.0, 45),  # "Unhealthy for Sensitive Groups"
    (200.0, 70),  # "Unhealthy"
    (300.0, 100), # "Very Unhealthy" / "Hazardous"
]

FACTORS = [
    {"key": "heat_index_c", "label": "Heat Index", "unit": "°C", "weight": 0.30,
     "curve": HEAT_INDEX_CURVE_C,
     "why": "Physiological \"feels like\" temperature — the direct heat-stress signal on the body."},
    {"key": "wet_bulb_c", "label": "Wet-Bulb Temperature", "unit": "°C", "weight": 0.25,
     "curve": WET_BULB_CURVE_C,
     "why": "Above ~35°C the human body physically cannot cool itself by sweating — an absolute limit, not a comfort threshold."},
    {"key": "exceedance_hours", "label": "Exceedance", "unit": "h", "weight": 0.20,
     "curve": EXCEEDANCE_CURVE_HOURS,
     "why": "Hours today spent above the heat threshold — sustained exposure duration."},
    {"key": "persistence_hours", "label": "Persistence", "unit": "h", "weight": 0.15,
     "curve": PERSISTENCE_CURVE_HOURS,
     "why": "Longest unbroken stretch above threshold — continuous heat stresses health and infrastructure more than intermittent spikes."},
    {"key": "aqi", "label": "Air Quality Index", "unit": "", "weight": 0.10,
     "curve": AQI_CURVE,
     "why": "Poor air quality compounds cardiovascular/respiratory strain during heat exposure."},
]

LEVELS = [
    (0, 25, "Low", "emerald"),
    (25, 50, "Moderate", "amber"),
    (50, 75, "High", "orange"),
    (75, 101, "Severe", "red"),
]


def _interpolate(value: float, curve: list[tuple[float, float]]) -> float:
    if value <= curve[0][0]:
        return curve[0][1]
    if value >= curve[-1][0]:
        return curve[-1][1]
    for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
        if x0 <= value <= x1:
            if x1 == x0:
                return y0
            t = (value - x0) / (x1 - x0)
            return y0 + t * (y1 - y0)
    return curve[-1][1]  # unreachable given the bounds checks above


def _level_for(score: float) -> tuple[str, str]:
    for lo, hi, label, color in LEVELS:
        if lo <= score < hi:
            return label, color
    return LEVELS[-1][2], LEVELS[-1][3]


def level_for(score: float) -> tuple[str, str]:
    """Public wrapper around _level_for — used by advisor.py (Phase 13) so
    a factor's severity tier there always matches the tier it would show
    at in this module's own breakdown, instead of a second threshold set
    that could quietly drift out of sync with LEVELS above."""
    return _level_for(score)


def compute_risk_score(features: dict | None) -> dict:
    """`features` is a location_features row (or None if nothing's been
    recorded yet for this city+date). Returns a score plus a fully
    itemized breakdown — every number in the final score is traceable
    back to a specific factor here, nothing is hidden inside a model."""
    if not features:
        return {
            "available": False,
            "reason": "No location_features recorded yet for this city/date — "
                      "generate a heatmap and/or environmental parameters for it first.",
        }

    breakdown = []
    missing = []
    weighted_sum = 0.0
    weight_total = 0.0

    for factor in FACTORS:
        raw = features.get(factor["key"])
        if raw is None:
            missing.append(factor["label"])
            continue
        sub_score = round(_interpolate(float(raw), factor["curve"]), 1)
        weighted_sum += sub_score * factor["weight"]
        weight_total += factor["weight"]
        breakdown.append({
            "key": factor["key"],
            "label": factor["label"],
            "raw_value": raw,
            "unit": factor["unit"],
            "sub_score": sub_score,
            "weight": factor["weight"],
            "contribution": round(sub_score * factor["weight"], 1),  # pre-renormalization, shown as-is
            "why": factor["why"],
        })

    if weight_total == 0:
        return {
            "available": False,
            "reason": "location_features exists for this city/date but none of the scored fields "
                      "(heat index, wet-bulb, exceedance, persistence, AQI) have a value yet.",
        }

    # Re-normalize: if e.g. AQI is missing, its 0.10 weight doesn't just
    # vanish (which would silently understate the score) — it's
    # redistributed proportionally across the factors that DO have data.
    score = round(weighted_sum / weight_total, 1)
    level, color = _level_for(score)

    context = {
        "mean_temp_c": features.get("mean_temp_c"),
        "max_temp_c": features.get("max_temp_c"),
        "min_temp_c": features.get("min_temp_c"),
        "humidity_pct": features.get("humidity_pct"),
    }

    return {
        "available": True,
        "score": score,
        "level": level,
        "color": color,
        "breakdown": breakdown,
        "missing_factors": missing,
        "renormalized": weight_total < 1.0,
        "context": {k: v for k, v in context.items() if v is not None},
        "feature_date": str(features.get("feature_date")) if features.get("feature_date") else None,
        "updated_at": features.get("updated_at").isoformat() if features.get("updated_at") else None,
    }