"""
Phase 9 (People Impact Score) regression tests.

Why this file exists: impact_score.compute_impact_score() is pure — no
network call, no DB call, same inputs always produce the same output. That
makes it directly testable with no mocking needed, and it's exactly the
kind of code where a silent change (someone tweaks a weight, widens a
curve, reorders a factor) should be caught by a test instead of by a user
noticing the dashboard number looks "different" days later.

THE GOLDEN CASE (TestHoustonGoldenSnapshot below) is not invented data.
It's the exact input/output pair captured from a real, live run of this
app on 2026-08-25 after the AOI-unification fix — Houston, Heat Risk
38.9 (Moderate), 2 schools + 2 hospitals, 1238 buildings — verified
against the actual running dashboard (People Impact Score = 48.5,
Vulnerable Sites sub-score 50.0, Population Density sub-score 70.6).
Reproduced here in isolation and checked against compute_impact_score()
directly, with the exact same result. If this test ever fails, either the
scoring formula changed on purpose (update the expected values AND
re-verify against a live dashboard run, don't just make the test pass),
or something broke.

Everything else here tests structural properties of the curves/weights
themselves (their own defined control points, their own defined weights)
— not fabricated city data standing in for something real.
"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import impact_score  # noqa: E402
from app.impact_score import (  # noqa: E402
    compute_impact_score,
    _interpolate,
    VULNERABLE_SITES_CURVE,
    DENSITY_CURVE,
    FACTORS_META,
    LEVELS,
)


# ---------------------------------------------------------------------------
# Golden snapshot — real data, captured from a live verified dashboard run.
# ---------------------------------------------------------------------------

class TestHoustonGoldenSnapshot:
    """Houston, 2026-08-25, post AOI-unification-fix. Screenshot-verified
    against the live dashboard before being locked in here."""

    RISK_RESULT = {"available": True, "score": 38.9, "level": "Moderate"}
    EXPOSURE = {
        "points": [
            {"type": "school"}, {"type": "school"},
            {"type": "hospital"}, {"type": "hospital"},
        ],
        "density": {
            "building_count": 1238,
            "residential_landuse_count": 5,
            "road_count": 40,
        },
        "fetched_at": "2026-08-25T00:00:00+00:00",
    }

    def test_matches_live_dashboard_reading(self):
        result = compute_impact_score(self.RISK_RESULT, self.EXPOSURE)
        assert result["available"] is True
        # The number a user actually saw on screen.
        assert result["score"] == 48.5
        assert result["level"] == "Moderate"

    def test_breakdown_matches_dashboard_itemization(self):
        result = compute_impact_score(self.RISK_RESULT, self.EXPOSURE)
        by_key = {row["key"]: row for row in result["breakdown"]}

        assert by_key["heat_risk"]["sub_score"] == 38.9
        assert by_key["vulnerable_sites"]["sub_score"] == 50.0
        assert by_key["population_density"]["sub_score"] == 70.6

    def test_exposure_counts_match_what_was_fetched(self):
        result = compute_impact_score(self.RISK_RESULT, self.EXPOSURE)
        assert result["exposure_counts"]["schools"] == 2
        assert result["exposure_counts"]["hospitals"] == 2
        assert result["exposure_counts"]["buildings"] == 1238


# ---------------------------------------------------------------------------
# Structural checks on the curves/weights actually defined in the module —
# these read the real VULNERABLE_SITES_CURVE / DENSITY_CURVE / FACTORS_META
# straight from impact_score.py, not a copy pasted into the test.
# ---------------------------------------------------------------------------

class TestWeightsInvariant:
    def test_factor_weights_sum_to_one(self):
        """This is the main thing that catches a silent regression: if
        someone changes one weight (e.g. bumps heat_risk from 0.50 to
        0.60) without adjusting the others to compensate, this fails
        immediately instead of the dashboard quietly producing scores
        that don't add up to what the itemized breakdown implies."""
        total = sum(factor["weight"] for factor in FACTORS_META)
        assert math.isclose(total, 1.0, abs_tol=1e-9)

    def test_every_factor_has_a_positive_weight(self):
        for factor in FACTORS_META:
            assert factor["weight"] > 0, f"{factor['key']} has non-positive weight"


class TestCurvesAreMonotonic:
    """A scoring curve that isn't monotonically non-decreasing would mean
    'more schools/hospitals' or 'more buildings' could lower the score —
    that's never the intent, so any curve edit that breaks this should
    fail loudly."""

    def _assert_monotonic(self, curve):
        for (x0, y0), (x1, y1) in zip(curve, curve[1:]):
            assert x1 > x0, f"curve x-values must be strictly increasing: {x0} -> {x1}"
            assert y1 >= y0, f"curve must be non-decreasing: ({x0},{y0}) -> ({x1},{y1})"

    def test_vulnerable_sites_curve_is_monotonic(self):
        self._assert_monotonic(VULNERABLE_SITES_CURVE)

    def test_density_curve_is_monotonic(self):
        self._assert_monotonic(DENSITY_CURVE)

    def test_curves_stay_within_0_100(self):
        for curve in (VULNERABLE_SITES_CURVE, DENSITY_CURVE):
            for _, y in curve:
                assert 0 <= y <= 100


class TestInterpolationAtControlPoints:
    """_interpolate() should return exactly each curve's own defined
    y-value at each of that curve's own defined x-value — these numbers
    come directly from the curve definitions, not invented."""

    def test_vulnerable_sites_control_points(self):
        for x, y in VULNERABLE_SITES_CURVE:
            assert _interpolate(x, VULNERABLE_SITES_CURVE) == y

    def test_density_control_points(self):
        for x, y in DENSITY_CURVE:
            assert _interpolate(x, DENSITY_CURVE) == y

    def test_clamps_below_first_point(self):
        x0, y0 = VULNERABLE_SITES_CURVE[0]
        assert _interpolate(x0 - 100, VULNERABLE_SITES_CURVE) == y0

    def test_clamps_above_last_point(self):
        x_last, y_last = VULNERABLE_SITES_CURVE[-1]
        assert _interpolate(x_last + 1000, VULNERABLE_SITES_CURVE) == y_last


class TestLevelBands:
    def test_level_bands_cover_0_to_100_with_no_gaps(self):
        sorted_levels = sorted(LEVELS, key=lambda row: row[0])
        assert sorted_levels[0][0] == 0
        for (lo0, hi0, *_), (lo1, hi1, *_) in zip(sorted_levels, sorted_levels[1:]):
            assert hi0 == lo1, f"gap/overlap between bands ending {hi0} and starting {lo1}"
        assert sorted_levels[-1][1] > 100


# ---------------------------------------------------------------------------
# Documented "not available" behavior — the actual short-circuit paths
# already written in compute_impact_score(), exercised directly.
# ---------------------------------------------------------------------------

class TestAvailabilityGuards:
    def test_unavailable_when_risk_score_missing(self):
        result = compute_impact_score(None, {"points": [], "density": {"building_count": 5}})
        assert result["available"] is False
        assert "Heat Risk Score" in result["reason"]

    def test_unavailable_when_risk_score_not_available(self):
        risk_result = {"available": False, "reason": "no location_features yet"}
        result = compute_impact_score(risk_result, {"points": [], "density": {"building_count": 5}})
        assert result["available"] is False

    def test_unavailable_when_exposure_is_none(self):
        risk_result = {"available": True, "score": 50.0, "level": "Moderate"}
        result = compute_impact_score(risk_result, None)
        assert result["available"] is False
        assert "exposure" in result["reason"].lower()

    def test_unavailable_when_exposure_has_no_points_and_no_density(self):
        risk_result = {"available": True, "score": 50.0, "level": "Moderate"}
        result = compute_impact_score(risk_result, {"points": [], "density": {}})
        assert result["available"] is False

    def test_genuinely_zero_exposure_is_still_available(self):
        """An AOI that was actually scanned and genuinely has zero
        schools/hospitals/buildings is a real (if unusual) reading, not
        a 'missing data' case — density present with real zero values
        should compute normally, not short-circuit."""
        risk_result = {"available": True, "score": 50.0, "level": "Moderate"}
        exposure = {
            "points": [],
            "density": {"building_count": 0, "residential_landuse_count": 0, "road_count": 0},
            "fetched_at": "2026-08-25T00:00:00+00:00",
        }
        result = compute_impact_score(risk_result, exposure)
        assert result["available"] is True
        assert result["exposure_counts"]["schools"] == 0
        assert result["exposure_counts"]["buildings"] == 0


class TestHeatRiskPassesThroughUncurved:
    """heat_risk is documented as NOT re-curved — its sub_score must equal
    the raw Phase 8 score exactly. This guards against someone
    accidentally routing it through a curve like the other two factors."""

    def test_heat_risk_subscore_equals_raw_risk_score(self):
        for score in (0.0, 12.3, 38.9, 74.0, 100.0):
            risk_result = {"available": True, "score": score, "level": "x"}
            exposure = {"points": [], "density": {"building_count": 100}}
            result = compute_impact_score(risk_result, exposure)
            heat_row = next(r for r in result["breakdown"] if r["key"] == "heat_risk")
            assert heat_row["sub_score"] == score