"""
Phase 13 — Local Heat Advisor.

Pure presentation-layer transform over Phase 8's risk_score.compute_risk_score()
output — no new data source, no FortyGuard call. Every precaution below is
keyed to a real factor from location_features plus that factor's actual
severity tier (reusing risk_score.py's own LEVELS boundaries via
level_for(), not a second threshold set that could drift out of sync with
it). The same underlying numbers always produce the same SET of
precautions regardless of which persona asks — only the framing and which
factors get surfaced change per audience.

Wording source: by default this tries Groq (generate_advisory_wording) to
reword each qualifying factor for the persona — but Groq never chooses
WHICH factors appear, their severity tier, or any number; that's all
decided above, deterministically, before Groq is ever called. If Groq is
unavailable, fails, or returns a malformed response, this falls back to
the fixed _TEMPLATES below without the caller ever seeing an error — the
deterministic wording is a real, complete feature on its own, not just a
degraded placeholder. A small in-process cache (keyed by persona + the
exact factor/value/tier list) avoids re-billing Groq every time someone
reopens this card for data that hasn't changed.

Scope note: this deliberately does NOT include a "city official" or
"emergency manager" persona. Phase 10's emergency_score.py already
generates factor-conditioned operator actions from this exact same
risk_score breakdown (wet-bulb, exceedance, persistence, AQI) — and
theirs is strictly more complete for that audience (it also folds in NWS
alerts and Phase 9's Impact/exposure data, and is priority-ordered).
Duplicating a thinner version of that here for the same audience would be
redundant, not additive — see Emergency Mode for that use case instead.
This module covers the audiences Emergency Mode was never written for:
people deciding their own day, not operators running a response.
"""

import hashlib
import json

from . import groq_client, risk_score
from .config import settings
from .logger import log_err

PERSONAS = [
    {"key": "resident", "label": "Resident"},
    {"key": "outdoor_worker", "label": "Outdoor Worker"},
    {"key": "farmer", "label": "Farmer / Agricultural"},
    {"key": "business", "label": "Business Owner"},
]

_PERSONA_LABELS = {p["key"]: p["label"] for p in PERSONAS}
_PERSONA_KEYS = set(_PERSONA_LABELS)

# Which of risk_score.py's FACTORS keys are worth surfacing to each
# persona. Not every persona needs every factor — a resident doesn't need
# raw exceedance-hours, they need a plain heat/AQI flag. Filtering here
# keeps output actionable instead of dumping Phase 8's full breakdown
# unfiltered at everyone.
_RELEVANT_FACTORS = {
    "resident": {"heat_index_c", "wet_bulb_c", "aqi", "persistence_hours"},
    "outdoor_worker": {"heat_index_c", "wet_bulb_c", "exceedance_hours", "persistence_hours"},
    "farmer": {"heat_index_c", "persistence_hours", "aqi"},
    "business": {"heat_index_c", "aqi", "persistence_hours"},
}


def _fmt(raw_value, unit) -> str:
    if unit == "°C":
        return f"{raw_value:.1f}°C"
    if unit == "h":
        return f"{raw_value:.1f}h"
    return f"{raw_value:.0f}"


# Deterministic fallback wording — used whenever Groq wording isn't tried
# (GROQ_API_KEY unset) or fails for any reason. Each takes (formatted real
# value, real tier) so the number/tier shown always comes from THIS
# city/date's actual reading — never a canned line disconnected from the
# data. A cell left out on purpose means no persona-specific fallback line
# has been written for that factor yet, not that the factor doesn't
# matter to that persona (Groq wording, when it succeeds, has no such gap
# — it covers every relevant factor every time).
_TEMPLATES = {
    "heat_index_c": {
        "resident": lambda v, t: f"Heat index is {v} ({t}). Limit outdoor time in peak hours, hydrate often, and check on elderly or medically vulnerable neighbors.",
        "outdoor_worker": lambda v, t: f"Heat index is {v} ({t}). Increase water-break frequency and shift heavy exertion to early morning or evening.",
        "farmer": lambda v, t: f"Heat index is {v} ({t}). Shift field labor to early morning/evening and increase water access for livestock.",
        "business": lambda v, t: f"Heat index is {v} ({t}). Reduce non-essential outdoor staff exposure and increase indoor cooling if customer-facing.",
    },
    "wet_bulb_c": {
        "resident": lambda v, t: f"Wet-bulb temperature is {v} ({t}) — the body's ability to cool by sweating is impaired at this level. Stay in air conditioning where possible.",
        "outdoor_worker": lambda v, t: f"Wet-bulb temperature is {v} ({t}) — sustained outdoor exertion is physiologically risky here. Reassess whether outdoor work should continue.",
    },
    "exceedance_hours": {
        "outdoor_worker": lambda v, t: f"Temperature has been above the local threshold for {v} today ({t} exceedance). Plan shift timing around this window.",
    },
    "persistence_hours": {
        "resident": lambda v, t: f"Heat has persisted continuously for {v} ({t}). Prolonged exposure is riskier than brief spikes — pace outdoor errands.",
        "outdoor_worker": lambda v, t: f"Longest continuous stretch above threshold today is {v} ({t}). Continuous heat is more dangerous than intermittent — don't rely on brief cool spells.",
        "farmer": lambda v, t: f"Heat has persisted for {v} straight ({t}) — monitor livestock for heat stress continuously, not just at the daily peak.",
        "business": lambda v, t: f"Heat has persisted for {v} ({t}) — expect reduced foot traffic/outdoor dwell time for the duration.",
    },
    "aqi": {
        "resident": lambda v, t: f"Air Quality Index is {v} ({t}). Combined with today's heat, this compounds respiratory/cardiovascular strain — consider limiting outdoor exertion.",
        "outdoor_worker": lambda v, t: f"AQI is {v} ({t}) alongside today's heat. Consider reduced outdoor exertion duration.",
        "farmer": lambda v, t: f"AQI is {v} ({t}) — heat and poor air quality compound stress on both workers and livestock.",
        "business": lambda v, t: f"AQI is {v} ({t}). If customer/staff areas are poorly ventilated, this compounds today's heat.",
    },
}

# "Low" is deliberately excluded — a fine day shouldn't get padded with
# filler advice just to have something to show.
_TIERS_SHOWN = {"Moderate", "High", "Severe"}

# Process-lifetime cache, NOT a Postgres table like heat_stories — this
# wording is short (a handful of sentences), cheap to regenerate, and
# doesn't need to survive a server restart the way a saved day's Heat
# Story narrative does. Keyed by a hash of exactly what was sent to Groq
# (persona + each factor's label/value/tier), so any real change to the
# underlying reading naturally produces a new key rather than serving
# stale wording. Uncapped for now — advisor wording requests are a small,
# low-cardinality space (persona × a handful of factor/tier combos), not
# an unbounded one like per-city-per-date Heat Story narratives.
_wording_cache: dict[str, list[str]] = {}


def _wording_cache_key(persona: str, factors: list[dict]) -> str:
    payload = json.dumps(
        {"persona": persona, "prompt_version": groq_client.ADVISOR_PROMPT_VERSION,
         "factors": [{"label": f["label"], "value": f["value"], "tier": f["tier"]} for f in factors]},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:24]


async def _get_wording(persona: str, factors: list[dict]) -> list[str] | None:
    """Returns Groq-worded precautions, or None if Groq wording isn't
    available/failed — callers fall back to _TEMPLATES on None, never on
    an exception (this function itself never raises)."""
    if not settings.GROQ_API_KEY or not factors:
        return None
    cache_key = _wording_cache_key(persona, factors)
    if cache_key in _wording_cache:
        return _wording_cache[cache_key]
    try:
        wording = await groq_client.generate_advisory_wording(_PERSONA_LABELS[persona], factors)
    except groq_client.GroqError as exc:
        log_err("Local Advisor Groq wording failed — falling back to deterministic templates",
                 {"persona": persona, "error": str(exc)})
        return None
    _wording_cache[cache_key] = wording
    return wording


async def generate_advisory(features: dict | None, persona: str, use_llm_wording: bool = True) -> dict:
    """`features` is the same location_features row risk_score.py already
    consumes. Returns Phase 8's score/level untouched plus a persona-
    filtered precaution list derived from it — Groq-worded when available,
    deterministically-worded otherwise (see module docstring).

    `use_llm_wording=False` skips the Groq wording call entirely and goes
    straight to the deterministic _TEMPLATES path — used by agent.py's
    get_local_advisory tool specifically, NOT by the real GET
    /api/cities/{id}/advisor route a person opening the Dashboard's Local
    Advisor card actually hits (that keeps the default, unchanged
    behavior). The agent's own final-answer turn already re-narrates
    whatever this returns in its own natural-language summary — paying
    for a SECOND Groq call here, on top of the agent's own tool-selection
    and final-answer turns, to wordsmith text the agent immediately
    re-writes anyway was real, avoidable token spend against the exact
    same shared per-minute budget the agent's own turns were already
    competing for, and a genuine contributor to the rate-limit failures
    users were hitting on ordinary single-city questions."""
    if persona not in _PERSONA_KEYS:
        return {"available": False, "reason": f"Unknown persona '{persona}'."}

    score_result = risk_score.compute_risk_score(features)
    if not score_result.get("available"):
        return {"available": False, "reason": score_result.get("reason"), "persona": persona}

    relevant = _RELEVANT_FACTORS[persona]
    qualifying = []  # [{item, tier, color, formatted_value}], before any wording is attached
    for item in score_result["breakdown"]:
        key = item["key"]
        if key not in relevant:
            continue
        tier, color = risk_score.level_for(item["sub_score"])
        if tier not in _TIERS_SHOWN:
            continue
        qualifying.append({"item": item, "key": key, "tier": tier, "color": color,
                            "value": _fmt(item["raw_value"], item["unit"])})

    wording_source = "template"
    llm_wording = await _get_wording(
        persona,
        [{"label": q["item"]["label"], "value": q["value"], "tier": q["tier"]} for q in qualifying],
    ) if use_llm_wording else None

    precautions = []
    for i, q in enumerate(qualifying):
        if llm_wording is not None:
            text = llm_wording[i]
            wording_source = "llm"
        else:
            template = _TEMPLATES.get(q["key"], {}).get(persona)
            if not template:
                continue  # no deterministic fallback line written for this factor yet — skip rather than guess
            text = template(q["value"], q["tier"])
        precautions.append({
            "factor": q["item"]["label"],
            "tier": q["tier"],
            "color": q["color"],
            "text": text,
        })

    return {
        "available": True,
        "persona": persona,
        "overall_score": score_result["score"],
        "overall_level": score_result["level"],
        "overall_color": score_result["color"],
        "precautions": precautions,
        "wording_source": wording_source,
        "context": score_result["context"],
        "feature_date": score_result["feature_date"],
        "no_precautions_reason": (
            "No factors relevant to this persona are currently above the advisory threshold."
            if not precautions else None
        ),
    }