"""
Phase 9 — People Impact Score.

Combines Phase 8's Heat Risk Score (location_features: heat index,
wet-bulb, exceedance, persistence, AQI) with Phase 6's OSM exposure data
(schools/hospitals + building/residential density within the AOI) — per
the roadmap: "heat alone ≠ priority; exposure matters." Same philosophy
as risk_score.py: deterministic, itemized, no black box, no new external
dependency. This module makes no network calls itself; it only combines
numbers Phase 8 and Phase 6 already computed/cached.

Factor choices, and why:
  - Heat Risk (Phase 8's 0-100 score) carries the largest single weight
    (0.50) because it's already a compound signal (temperature, humidity
    stress, persistence, AQI) — exposure without heat isn't dangerous,
    so heat has to anchor the score.
  - Vulnerable Sites (schools + hospitals/clinics counted by Phase 6) is
    weighted above raw density (0.30 vs 0.20) because these are
    concentrated, harder-to-relocate populations — a school full of kids
    or a hospital full of patients in a heat zone is a materially
    different priority than an equivalent empty lot.
  - Population Density Proxy uses building_count ALONE, not
    building_count + residential_landuse_count. Those two used to be
    added together as if they were the same kind of number — they
    aren't: building_count is a count of individual structures (houses,
    shops, warehouses, everything OSM tags `building=*` on, since most
    US buildings are just tagged `building=yes` with no residential/
    commercial subtype to filter on), while residential_landuse_count is
    a count of zoning *polygons* (typically single digits per AOI, an
    entirely different scale). Summing them barely moved the number in
    practice but was conceptually wrong — a zone-polygon count isn't a
    building count. residential_landuse_count is still fetched and
    reported (see exposure_counts in the response) for context, just no
    longer folded into this factor's math. building_count itself is
    still an honest limitation, not a real population count — OSM's
    `building` tag doesn't reliably distinguish a house from a
    warehouse — it's a "how much is built here" proxy, nothing more.
  - Road count is deliberately NOT scored here — Phase 6 stores it for
    Phase 12.5 (Heat-Safe Routing), not as a proxy for "people exposed."
"""

# Same interpolation convention as risk_score.py: sorted (value,
# sub_score_0_to_100) control points, linear between them, clamped
# outside the range.

VULNERABLE_SITES_CURVE = [
    (0, 0),
    (2, 30),
    (5, 60),
    (10, 85),
    (20, 100),
]

# Calibrated against building_count alone (see the module docstring for
# why residential_landuse_count was dropped from this signal). Control
# points widened from an earlier (0-1000) range that saturated at 100 for
# any real downtown-scale AOI — e.g. a real Houston ~1.5km AOI came back
# with 1279 buildings and was already pinned at the old curve's ceiling,
# unable to distinguish that from a much denser 5000-building AOI. These
# points are still a judgment call, not a census-calibrated scale — the
# fixed AOI size (~2.2km box, see exposure_repository.DEFAULT_HALF_WIDTH_DEG
# — also the box heat_risk's location_features are now read for, see
# scheduler.py) is what makes "buildings per AOI" comparable at all across
# cities.
DENSITY_CURVE = [
    (0, 0),
    (200, 20),
    (600, 45),
    (1200, 70),
    (2500, 90),
    (4000, 100),
]

FACTORS_META = [
    {"key": "heat_risk", "label": "Heat Risk Score", "weight": 0.50,
     "why": "Phase 8's deterministic temperature/humidity/persistence/AQI score — the underlying hazard people are exposed to."},
    {"key": "vulnerable_sites", "label": "Vulnerable Sites Exposure", "weight": 0.30,
     "why": "Schools and hospitals/clinics inside the AOI (OSM) — concentrated, harder-to-relocate populations."},
    {"key": "population_density", "label": "Population Density Proxy", "weight": 0.20,
     "why": "Building count inside the AOI (OSM) — a coarse proxy for how built-up the area is, not a real population count (OSM doesn't reliably tag residential vs. commercial/industrial buildings)."},
]


LEVELS = [
    (0, 25, "Low", "emerald"),
    (25, 50, "Moderate", "amber"),
    (50, 75, "High", "orange"),
    (75, 101, "Critical", "red"),
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


def compute_impact_score(risk_result: dict | None, exposure: dict | None) -> dict:
    """`risk_result` is the dict already returned by
    risk_score.compute_risk_score() for this city/date. `exposure` is the
    dict already returned by exposure_repository.get_exposure() for this
    city's AOI (points + density), or None if nothing's been fetched yet.
    Both inputs are things Phase 8 and Phase 6 already produce — this
    function does no fetching of its own."""
    if not risk_result or not risk_result.get("available"):
        return {
            "available": False,
            "reason": "Heat Risk Score isn't available yet for this city/date — People Impact Score "
                      "builds directly on it (Phase 8 must have data first). "
                      + (risk_result.get("reason", "") if risk_result else ""),
        }

    if not exposure or (not exposure.get("points") and not exposure.get("density")):
        return {
            "available": False,
            "reason": "No exposure data cached yet for this location — visit the Dashboard's "
                      "Exposure card once so Phase 6 (OSM/Overpass) can populate schools, "
                      "hospitals, and density for this AOI.",
        }

    points = exposure.get("points") or []
    density = exposure.get("density") or {}
    schools = sum(1 for p in points if p.get("type") == "school")
    hospitals = sum(1 for p in points if p.get("type") == "hospital")
    vulnerable_count = schools + hospitals
    # building_count alone — see the module docstring for why
    # residential_landuse_count (a zone-polygon count, not a building
    # count) was removed from this signal. Still reported separately
    # below in exposure_counts for transparency.
    building_count = density.get("building_count") or 0

    raw_values = {
        "heat_risk": risk_result["score"],
        "vulnerable_sites": vulnerable_count,
        "population_density": building_count,
    }
    curves = {
        "vulnerable_sites": VULNERABLE_SITES_CURVE,
        "population_density": DENSITY_CURVE,
    }

    breakdown = []
    weighted_sum = 0.0
    for factor in FACTORS_META:
        raw = raw_values[factor["key"]]
        # heat_risk is already a 0-100 score (Phase 8's own output) — it
        # doesn't get re-curved, unlike the two raw OSM counts.
        sub_score = raw if factor["key"] == "heat_risk" else round(_interpolate(raw, curves[factor["key"]]), 1)
        contribution = round(sub_score * factor["weight"], 1)
        weighted_sum += contribution
        breakdown.append({
            "key": factor["key"],
            "label": factor["label"],
            "raw_value": raw,
            "sub_score": sub_score,
            "weight": factor["weight"],
            "contribution": contribution,
            "why": factor["why"],
        })

    # Unlike risk_score.py, no renormalization is needed here: all three
    # factors always have a value (0 is a legitimate reading — "no
    # schools/hospitals found" or "no heat risk data" already short-
    # circuited above — never a missing one), so weights always sum to
    # exactly 1.0.
    score = round(weighted_sum, 1)
    level, color = _level_for(score)

    return {
        "available": True,
        "score": score,
        "level": level,
        "color": color,
        "breakdown": breakdown,
        "exposure_counts": {
            "schools": schools,
            "hospitals": hospitals,
            "buildings": density.get("building_count"),
            "residential_landuse": density.get("residential_landuse_count"),
            "roads": density.get("road_count"),
        },
        "heat_risk_score": risk_result["score"],
        "heat_risk_level": risk_result["level"],
        "exposure_stale": bool(exposure.get("stale")),
        "exposure_fetched_at": exposure.get("fetched_at"),
    }