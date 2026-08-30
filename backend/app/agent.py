"""
Phase 15 — Thermora Agent (Heat Intelligence Agent).

The integration point, built last on purpose: everything this agent
calls (Risk Score, Impact Score, Emergency Mode, official alerts,
exposure data) already exists, is already deterministic, and is already
trustworthy on its own. This module adds NO new scoring logic — it adds
REASONING on top of scores that were already computed the same way
every dashboard card computes them.

Genuinely tool-using and multi-step, not a single prompt with data
stuffed in: the model decides which cities to investigate and calls
real backend functions to do it, exactly the same functions the REST
routes call (routers/emergency.py's _gather_emergency_status and
get_emergency_status_all — no duplicated composition logic, so the
agent can never see different numbers than the dashboard shows for the
same city/date). The model cannot invent a risk score, an alert, or an
exposure count — every number in its final answer had to come back
from a tool call first.

Flow: investigate (call tools to gather real data) -> reason (the model
sees the gathered JSON) -> rank (priority ordering across whichever
cities were investigated) -> explain (why, grounded in the specific
factors returned) -> recommend (an action per prioritized city) — the
same investigate/reason/rank/explain/recommend structure the roadmap
describes, produced as one structured final answer once the model has
stopped calling tools.
"""
import asyncio
import hashlib
import json
import math
import random
import re
import time
from datetime import date as date_cls, timedelta

import httpx

from .config import settings
from .logger import log_req, log_res, log_err
from .locations import MONITORED_CITIES, get_city, local_today, city_local_now
from . import historical_repository
from . import repository
from . import heat_story
from . import groq_client
from . import advisor
from .db import get_pool
from .location_features import get_combined_features
from .fortyguard_client import FortyGuardError
from .routers.emergency import _gather_emergency_status, get_emergency_status_all


class AgentError(Exception):
    """Raised whenever the agent genuinely couldn't produce an answer —
    missing API key, network failure, non-200 after retries, malformed
    tool-call arguments, a final answer that didn't parse as the required
    JSON shape, or the step budget running out. Callers (routers/agent.py)
    turn this into an honest 'agent unavailable' response, same
    convention as GroqError elsewhere in this codebase."""

    def __init__(self, message: str, retry_after_seconds: float | None = None):
        super().__init__(message)
        # Only ever set for a genuine rate-limit failure, from the same
        # _parse_groq_retry_hint() figure the retry loop itself already
        # trusts — never a guess. None means either this wasn't a rate
        # limit, or Groq's response didn't include a parseable wait time;
        # both cases are treated the same by callers (no countdown shown).
        self.retry_after_seconds = retry_after_seconds


MAX_AGENT_STEPS = 6  # tool-call round-trips before forcing a final answer, so a confused model can't loop forever billing tool calls

# Deterministic tool -> app-tab pointer, attached to every response as
# "see_also" — NOT written by the model. The whole point of this is to
# let the model's own "summary"/"why" stay short (a lean answer plus "see
# X for the full breakdown" costs far fewer completion tokens than the
# model trying to restate an entire itemized breakdown in prose, which
# directly helps the same TPM budget every retry/trim in this file is
# already fighting for), while still pointing at somewhere real and
# specific — and since WE choose the mapping from a tool that actually
# ran to the tab that shows its data, there's no risk of the model
# naming a tab that doesn't exist or doesn't actually have what it claims.
_TOOL_TO_MODULE = {
    "get_all_cities_status": "Dashboard (per city) — full Risk Score & Impact Score breakdown, Emergency Mode for tactical actions",
    "get_city_status": "Dashboard — Risk Score & Impact Score breakdown, Emergency Mode for full tactical actions",
    "get_multiple_cities_status": "Each city's own Dashboard — full breakdown beyond this summary, Emergency Mode for tactical actions",
    "get_hourly_breakdown": "Heat Story — hour-by-hour observed readings",
    "get_heat_story": "Heat Story — full narrated summary",
    "get_local_advisory": "Dashboard — Local Advisor section",
    "get_historical_trend": "Compare Cities — Historical Trends",
    "get_historical_date": "Compare Cities — Historical Trends (Date Compare view)",
    "fetch_live_conditions": "Heat Map — live tile view",
    "fetch_forecast_temperature": "Heat Map — forecast fetch",
}


def _build_see_also(transcript: list[dict]) -> list[str]:
    seen = set()
    hints = []
    for entry in transcript:
        hint = _TOOL_TO_MODULE.get(entry.get("tool"))
        if hint and hint not in seen:
            seen.add(hint)
            hints.append(hint)
    return hints



# --- Tools the model can actually call. Each executes a REAL backend
# function already used by a REST route — see the module docstring. ---

# Groq 400'd with "Failed to parse tool call arguments as JSON" when asked
# to compare all 6 cities — it had guessed "dallas_fort_worth" for DFW
# (the real id is "dfw"), and generating a full array of similarly-guessed
# ids for a 6-city query blew past reliable generation and truncated
# mid-JSON. None of the city_id/city_ids parameters below had an `enum`,
# so the model had nothing but prose ("a monitored city's id") to go on
# and had to invent a plausible-looking string. Constraining every one of
# them to the real, current id list removes the guessing entirely — model
# picks from a fixed set instead of generating a novel string, which is
# also just more reliable for tool-call JSON generation in general.
_CITY_ID_ENUM = [c["id"] for c in MONITORED_CITIES]

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_monitored_cities",
            "description": "Lists every monitored city (id, name, state, coordinates). Call first if unsure a place name has a matching city_id.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_all_cities_status",
            "description": "Risk Score, Impact Score, and Emergency status for EVERY monitored city, ranked worst-first. For cross-city ranking/prioritizing only (expensive: live alerts+exposure for all cities). No factor breakdown or recommended actions — use get_city_status for that.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_city_status",
            "description": "Full investigation of ONE city: Risk Score breakdown (heat index, wet-bulb, exceedance/persistence, AQI), Impact Score breakdown (schools/hospitals/building density), NWS alerts, Emergency status, and recommended actions if WATCH/EMERGENCY.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_id": {
                        "type": "string",
                        "enum": _CITY_ID_ENUM,
                        "description": "A monitored city's id. Omit to default to whichever city the person currently has open in the app; get a valid id from list_monitored_cities if genuinely unsure.",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD. Omit for this city's current local date.",
                    },
                },
                "required": [],  # omit to default to the currently-open city -- see run_agent active_city_id + _execute_tool fallback
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_multiple_cities_status",
            "description": "Compact per-city summary (status, both scores, top reason, top action — NOT the full breakdown get_city_status returns) for a named list of 2+ cities in ONE call — use instead of calling get_city_status once per city. Deliberately lean so the payload doesn't scale with city count; call get_city_status afterward for any one city's full factor-by-factor detail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_ids": {
                        "type": "array", "items": {"type": "string", "enum": _CITY_ID_ENUM},
                        "description": "2+ monitored city ids, e.g. ['houston', 'phoenix'].",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD, applied to every city. Omit for each city's current local date.",
                    },
                },
                "required": ["city_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_hourly_breakdown",
            "description": "Hour-by-hour readings (temperature, heat index, humidity, wet-bulb, AQI) for ONE city on ONE date, plus missing/forecast hours. Use for 'when did it peak', 'was afternoon worse than morning', or one specific hour's reading. A temperature-only hour (other fields null) means that field was never fetched, not unavailable — call fetch_live_conditions for that exact hour to actually get it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_id": {
                        "type": "string",
                        "enum": _CITY_ID_ENUM,
                        "description": "A monitored city's id. Omit to default to whichever city the person currently has open in the app; get a valid id from list_monitored_cities if genuinely unsure.",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD. Omit for this city's current local date.",
                    },
                },
                "required": [],  # omit to default to the currently-open city -- see run_agent active_city_id + _execute_tool fallback
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_heat_story",
            "description": "The real AI-narrated Heat Story (4 sections) for ONE city, same as Thermora's Heat Story tab. Use ONLY when explicitly asked for 'the heat story', 'a narrated summary', or similar — NOT for 'why is heat doing X' explanatory questions (answer those yourself from get_city_status's factor breakdown instead). This makes its OWN separate Groq call on top of your own reasoning turn, competing for the same tiny shared rate limit — don't call it unless the story itself was actually requested by name. Cache-first, but 'today' rarely stays cached since it re-fingerprints as new hours are observed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_id": {
                        "type": "string",
                        "enum": _CITY_ID_ENUM,
                        "description": "A monitored city's id. Omit to default to whichever city the person currently has open in the app; get a valid id from list_monitored_cities if genuinely unsure.",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD. Omit for this city's current local date.",
                    },
                },
                "required": [],  # omit to default to the currently-open city -- see run_agent active_city_id + _execute_tool fallback
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_local_advisory",
            "description": "Real, audience-specific precautions for ONE city (resident/outdoor_worker/farmer/business), derived from its Risk Score breakdown. Use for 'what should X do' questions — never improvise this yourself. Not for city-official audiences (get_city_status's recommended actions cover that).",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_id": {
                        "type": "string",
                        "enum": _CITY_ID_ENUM,
                        "description": "A monitored city's id. Omit to default to whichever city the person currently has open in the app; get a valid id from list_monitored_cities if genuinely unsure.",
                    },
                    "persona": {
                        "type": "string",
                        "enum": ["resident", "outdoor_worker", "farmer", "business"],
                        "description": "Infer from phrasing (e.g. 'construction crew' -> outdoor_worker); ask only if genuinely ambiguous.",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD. Omit for this city's current local date.",
                    },
                },
                "required": ["persona"],  # city_id omitted here too -- omit to default to the currently-open city, see run_agent/_execute_tool
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_historical_trend",
            "description": "Real stored historical temperature data (actual past FortyGuard readings, typically ~2 months) for one or more cities: monthly mean time series, plus the single hottest/coolest stored day. Use for trends, 'vs last month', 'hottest day recently'. Different data source from get_city_status/get_all_cities_status (today's live scores) — call both if a query needs both. No stored history for a city means say so plainly, not 'nothing happened'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_ids": {
                        "type": ["array", "null"], "items": {"type": "string", "enum": _CITY_ID_ENUM},
                        "description": "One or more monitored city ids. Omit for every monitored city.",
                    },
                    "months_back": {
                        "type": ["integer", "null"],
                        "description": "How many months back. Omit to use everything actually stored.",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_historical_date",
            "description": "ONE exact stored calendar date's real readings (temperature, exceedance/persistence where stored) for one or more cities — e.g. 'what was it like in Houston on July 15th'. Different from get_historical_trend (monthly averages) — use this for one named specific date. No data for that date means has_data: false, not an estimate.",
            "parameters": {
                "type": "object",
                "properties": {
                    "date": {
                        "type": "string",
                        "description": "YYYY-MM-DD. Required.",
                    },
                    "city_ids": {
                        "type": ["array", "null"], "items": {"type": "string", "enum": _CITY_ID_ENUM},
                        "description": "One or more monitored city ids. Omit for every monitored city.",
                    },
                },
                "required": ["date"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_live_conditions",
            "description": "Fetches ONE specific PAST or CURRENT hour's real temperature (and heat_index_c/wet_bulb_c/humidity_pct/aqi if available) — cache-first: instant if already fetched by anyone, else a real live FortyGuard call that becomes part of Thermora's permanent observed record. REJECTS future/current-in-progress hours — use fetch_forecast_temperature for those. Use when get_hourly_breakdown shows a null for the field asked about (means never fetched, not unavailable), or for a date with no stored history. Can be slow on a genuine cache miss — don't call speculatively.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_id": {
                        "type": "string",
                        "enum": _CITY_ID_ENUM,
                        "description": "A monitored city's id. Omit to default to whichever city the person currently has open in the app; get a valid id from list_monitored_cities if genuinely unsure.",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD. Omit for this city's current local date.",
                    },
                    "hour": {
                        "type": ["string", "null"],
                        "description": "24-hour HH:00, e.g. '14:00'. Omit for this city's most recently completed local hour (no date given) or midday (a past date given, no hour).",
                    },
                },
                "required": [],  # omit to default to the currently-open city -- see run_agent active_city_id + _execute_tool fallback
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_forecast_temperature",
            "description": "Genuine FORTYGUARD FORECAST for ONE specific future hour, up to 12h ahead of the city's current local time (further out is refused, not guessed). Never saved as an observed reading (separate forecasts-only record). Use ONLY for 'will it be hotter later' type questions — never for a past/current hour (use fetch_live_conditions/get_city_status), never claim beyond 12h ahead.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city_id": {
                        "type": "string",
                        "enum": _CITY_ID_ENUM,
                        "description": "A monitored city's id. Omit to default to whichever city the person currently has open in the app; get a valid id from list_monitored_cities if genuinely unsure.",
                    },
                    "date": {
                        "type": ["string", "null"],
                        "description": "YYYY-MM-DD. Omit for this city's current local date (almost always correct — forecast horizon is only 12h).",
                    },
                    "hour": {
                        "type": ["string", "null"],
                        "description": "24-hour HH:00, e.g. '18:00' — must be a genuine future hour, at most 12h ahead. Omit to default to the next upcoming hour.",
                    },
                },
                "required": [],  # omit to default to the currently-open city -- see run_agent active_city_id + _execute_tool fallback
            },
        },
    },
]


def _city_summary(city: dict) -> dict:
    return {"id": city["id"], "name": city["name"], "state": city["state"], "lat": city["lat"], "lon": city["lon"]}


def _trim_for_agent(result: dict) -> dict:
    """_gather_emergency_status's full result is built for the Dashboard/
    Emergency Mode UI — it includes vulnerable_sites (every individual
    school/hospital's name + lat/lon in the AOI, which can be a genuinely
    long list) and each score's full breakdown (label/raw_value/unit/
    weight/sub_score/contribution per factor). None of that per-site
    detail or per-factor weight/sub_score changes what the model needs to
    reason and cite specific numbers in its answer — it needs the
    CONTRIBUTIONS and the counts, not individual addresses. Sent verbatim,
    this was a meaningful share of why a single get_all_cities_status (6
    cities' worth) or even one get_city_status call could burn a large
    fraction of Groq's 8000 TPM budget in one turn. This trims ONLY the
    copy handed back to the model as a tool result — the REST endpoints
    this same _gather_emergency_status result also serves (routers/
    emergency.py's own /emergency-status route) are completely untouched,
    since they call the underlying function directly, not through here."""
    trimmed = {k: v for k, v in result.items() if k != "vulnerable_sites"}
    for detail_key in ("risk_score_detail", "impact_score_detail"):
        detail = trimmed.get(detail_key)
        if detail and detail.get("breakdown"):
            trimmed[detail_key] = {
                **{k: v for k, v in detail.items() if k != "breakdown"},
                "breakdown": [
                    {"key": f["key"], "label": f["label"], "raw_value": f["raw_value"],
                     "unit": f.get("unit"), "contribution": f["contribution"]}
                    for f in detail["breakdown"]
                ],
            }
    return trimmed


# A second, more aggressive trim used ONLY by get_multiple_cities_status.
# That tool's whole point is comparing N named cities in ONE turn, so its
# per-city payload needs to shrink as N grows — sending N copies of
# _trim_for_agent's still-fairly-rich shape (full itemized risk/impact
# breakdowns per city) is exactly the kind of per-turn token spike that
# gets a broad, bounded multi-city question rate-limited when the same
# question about ONE city would have been fine. Keeps only what's needed
# to compare cities against each other; if the model needs one specific
# city's full factor-by-factor detail after seeing this summary, it has
# step budget left to call get_city_status for just that one city.
def _trim_for_agent_lean(result: dict) -> dict:
    actions = result.get("actions") or []
    reasons = result.get("reasons") or []
    risk_detail = result.get("risk_score_detail") or {}
    breakdown = risk_detail.get("breakdown") or []
    # The one number a "why" answer actually needs even in lean mode —
    # without this, a multi-city comparison could only say a city is
    # "High risk" with no cause attached, forcing a separate
    # get_city_status call just to answer the single most obvious
    # follow-up ("why?"). One factor costs a handful of tokens; the full
    # breakdown array this is deliberately avoiding costs many times that
    # per city.
    top_factor = max(breakdown, key=lambda f: f.get("contribution", 0)) if breakdown else None
    return {
        "city_id": result.get("city_id"), "city_name": result.get("city_name"),
        "date_used": result.get("date_used"),
        "status": result.get("status"), "status_label": result.get("status_label"),
        "risk_score": result.get("risk_score"), "impact_score": result.get("impact_score"),
        "headline_reason": reasons[0]["detail"] if reasons else None,
        "top_risk_factor": ({"label": top_factor["label"], "raw_value": top_factor["raw_value"],
                              "unit": top_factor.get("unit")} if top_factor else None),
        "top_recommended_action": actions[0] if actions else None,
        "alert_count": len(result.get("alerts") or []),
    }


async def _execute_tool(name: str, arguments: dict, active_city_id: str | None = None) -> dict:
    # Every tool below resolves a missing city_id to active_city_id
    # (the city the person actually has open — see run_agent's own
    # system-prompt injection) rather than requiring the model to
    # remember to pass it explicitly every time. That system-prompt
    # instruction is still what should make the model pass the right
    # city_id in the first place, but it's just words in a prompt — a
    # model that omits city_id for a genuinely cityless "general"
    # question (or copies a tool description's own "e.g. 'houston'"
    # example out of uncertainty) used to silently fail or, worse,
    # silently answer about Houston regardless of what was actually open
    # in the app. This makes "no city_id given" behave deterministically
    # (the active tab's city) instead of depending entirely on the model
    # having followed instructions correctly.
    """Dispatches one tool call to the real backend function it wraps.
    Returns a plain dict (JSON-serialized back to the model as a tool
    result) — never raises out of here for an expected input problem
    (unknown city_id, bad date), since a model that gets a clear error
    string back can usually recover and try something else; a genuinely
    unexpected exception is left to propagate so the agent loop's own
    error handling (and its step budget) can decide what to do with it."""
    if name == "list_monitored_cities":
        return {"cities": [_city_summary(c) for c in MONITORED_CITIES]}

    if name == "get_all_cities_status":
        return await get_emergency_status_all()

    if name == "get_city_status":
        city_id = arguments.get("city_id") or active_city_id
        city = get_city(city_id) if city_id else None
        if city is None:
            return {"error": f"Unknown city_id '{city_id}'. Call list_monitored_cities to see valid ids."}

        date_str = arguments.get("date")
        if date_str:
            try:
                feature_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
        else:
            feature_date = local_today(city)

        result = await _gather_emergency_status(city, feature_date)
        result["city_id"] = city["id"]
        result["city_name"] = city["name"]
        result["date_used"] = feature_date.isoformat()
        return _trim_for_agent(result)

    if name == "get_multiple_cities_status":
        requested_ids = arguments.get("city_ids")
        if not requested_ids or len(requested_ids) < 1:
            return {"error": "get_multiple_cities_status needs at least one city_id — use get_city_status for a single city or get_all_cities_status for every monitored city."}
        cities = []
        invalid = []
        for cid in requested_ids:
            c = get_city(cid)
            (cities if c else invalid).append(c or cid)
        if invalid:
            return {"error": f"Unknown city_id(s): {invalid}. Call list_monitored_cities to see valid ids."}

        date_str = arguments.get("date")
        if date_str:
            try:
                forced_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
        else:
            forced_date = None  # per-city local date, same default as get_city_status

        # Same _gather_emergency_status() helper get_city_status uses,
        # run concurrently across the requested cities — this is the
        # actual fix for a broad-but-bounded multi-city question needing
        # many separate Groq round-trips (one get_city_status call per
        # city): one tool call, one Groq turn, gathers all of them.
        async def _one(city: dict) -> dict:
            feature_date = forced_date or local_today(city)
            result = await _gather_emergency_status(city, feature_date)
            result["city_id"] = city["id"]
            result["city_name"] = city["name"]
            result["date_used"] = feature_date.isoformat()
            return _trim_for_agent_lean(result)

        results = await asyncio.gather(*(_one(c) for c in cities), return_exceptions=True)
        cities_out = []
        for cid, r in zip(requested_ids, results):
            if isinstance(r, Exception):
                log_err("get_multiple_cities_status: one city failed", {"city_id": cid, "error": str(r)})
                cities_out.append({"city_id": cid, "error": "This city's status could not be computed — try get_city_status for it individually."})
            else:
                cities_out.append(r)
        return {"cities": cities_out}

    if name == "get_hourly_breakdown":
        city_id = arguments.get("city_id") or active_city_id
        city = get_city(city_id) if city_id else None
        if city is None:
            return {"error": f"Unknown city_id '{city_id}'. Call list_monitored_cities to see valid ids."}

        date_str = arguments.get("date")
        if date_str:
            try:
                feature_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
        else:
            feature_date = local_today(city)

        # Exact same two reads GET /api/heat-story/{city_id} makes — no
        # separate hourly-data path invented for the agent to see
        # different numbers than the Heat Story tab would show.
        observed = await heat_story.get_observed_hours(city, feature_date)
        coverage = await heat_story.compute_coverage(city, feature_date)
        return {
            "city_id": city["id"], "city_name": city["name"], "date_used": feature_date.isoformat(),
            "hourly": observed, "coverage": coverage,
        }

    if name == "get_heat_story":
        city_id = arguments.get("city_id") or active_city_id
        city = get_city(city_id) if city_id else None
        if city is None:
            return {"error": f"Unknown city_id '{city_id}'. Call list_monitored_cities to see valid ids."}

        date_str = arguments.get("date")
        if date_str:
            try:
                feature_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
        else:
            feature_date = local_today(city)

        # Cache-check + fingerprint logic duplicated from
        # routers/heat_story.py's narrate() on purpose rather than shared,
        # to avoid touching that endpoint's working code while landing
        # this tool — see that function's own docstring for the full
        # reasoning (why the fingerprint includes model/prompt_version,
        # why only a genuine success gets cached). If the fingerprint
        # formula there ever changes, mirror the change here too.
        observed = await heat_story.get_observed_hours(city, feature_date)
        exposure_summary = await heat_story.get_exposure_summary(city)
        canonical = json.dumps(
            {
                "observed": observed, "forecast": [], "exposure": exposure_summary,
                "model": settings.GROQ_MODEL, "prompt_version": groq_client.PROMPT_VERSION,
            },
            sort_keys=True, default=str,
        )
        fingerprint = hashlib.sha256(canonical.encode()).hexdigest()

        pool = get_pool()
        cached = await pool.fetchrow(
            "SELECT narrative FROM heat_stories WHERE city_id = $1 AND feature_date = $2 AND input_fingerprint = $3",
            city["id"], feature_date, fingerprint,
        )
        if cached:
            story = json.loads(cached["narrative"])
            return {"city_id": city["id"], "city_name": city["name"], "date_used": feature_date.isoformat(),
                    "story": story, "was_already_cached": True}

        try:
            story = await groq_client.generate_heat_story(
                city_label=f"{city['name']}, {city['state']}",
                feature_date=feature_date, observed=observed, forecast=[], exposure_summary=exposure_summary,
            )
        except groq_client.GroqError as exc:
            return {"error": f"Heat Story narrative unavailable right now: {exc}"}

        if story.get("available"):
            await pool.execute(
                """
                INSERT INTO heat_stories (city_id, feature_date, input_fingerprint, narrative, model)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (city_id, feature_date, input_fingerprint) DO NOTHING
                """,
                city["id"], feature_date, fingerprint, json.dumps(story), settings.GROQ_MODEL,
            )
        return {"city_id": city["id"], "city_name": city["name"], "date_used": feature_date.isoformat(),
                "story": story, "was_already_cached": False}

    if name == "get_local_advisory":
        city_id = arguments.get("city_id") or active_city_id
        city = get_city(city_id) if city_id else None
        if city is None:
            return {"error": f"Unknown city_id '{city_id}'. Call list_monitored_cities to see valid ids."}

        persona = arguments.get("persona")
        valid_personas = {p["key"] for p in advisor.PERSONAS}
        if persona not in valid_personas:
            return {"error": f"'{persona}' is not a valid persona. Valid options: {sorted(valid_personas)}."}

        date_str = arguments.get("date")
        if date_str:
            try:
                feature_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
        else:
            feature_date = local_today(city)

        # Exact same read + call the real /api/cities/{id}/advisor route
        # uses — the agent gets identical PRECAUTIONS/tiers/values a
        # person would see opening that card themselves, not a re-derived
        # guess. use_llm_wording=False skips only the Groq wordsmithing
        # step specifically (see generate_advisory's own docstring) —
        # the agent's own final-answer turn is about to re-narrate this
        # in its own words anyway, so a second Groq call here was pure
        # extra load on the same shared TPM budget the agent's own turns
        # already compete for, for output nobody ends up reading verbatim.
        features, _used_hour = await get_combined_features(city_id, feature_date)
        result = await advisor.generate_advisory(features, persona, use_llm_wording=False)
        result["city_id"] = city["id"]
        result["city_name"] = city["name"]
        return result

    if name == "get_historical_trend":
        requested_ids = arguments.get("city_ids")
        if requested_ids:
            invalid = [cid for cid in requested_ids if get_city(cid) is None]
            if invalid:
                return {"error": f"Unknown city_id(s): {invalid}. Call list_monitored_cities to see valid ids."}
            city_ids = requested_ids
        else:
            city_ids = await historical_repository.get_all_monitored_city_ids()

        months_back = arguments.get("months_back")
        available_months = await historical_repository.get_available_months()
        if not available_months:
            return {"error": "No historical data has been stored yet for any city.", "available_months": []}

        # months_back omitted -> cover every stored month, rather than
        # guessing a default range that might silently exclude data that
        # actually exists (or include months that are all empty).
        months_list = None if months_back else available_months
        trend = await historical_repository.get_monthly_comparison(
            city_ids, "tcm", months_back=months_back or 12, months_list=months_list,
        )
        extremes = await historical_repository.get_extremes(
            city_ids, months_back=months_back or 12, months_list=months_list,
        )
        return {
            "available_months_stored": available_months,
            "monthly_mean_temperature_c": trend,
            "extremes": extremes,
        }

    if name == "get_historical_date":
        date_str = arguments.get("date")
        if not date_str:
            return {"error": "A 'date' (YYYY-MM-DD) is required for get_historical_date."}
        try:
            feature_date = date_cls.fromisoformat(date_str)
        except ValueError:
            return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}

        requested_ids = arguments.get("city_ids")
        if requested_ids:
            invalid = [cid for cid in requested_ids if get_city(cid) is None]
            if invalid:
                return {"error": f"Unknown city_id(s): {invalid}. Call list_monitored_cities to see valid ids."}
            city_ids = requested_ids
        else:
            city_ids = await historical_repository.get_all_monitored_city_ids()

        return await historical_repository.get_date_comparison(city_ids, feature_date)

    if name == "fetch_live_conditions":
        city_id = arguments.get("city_id") or active_city_id
        city = get_city(city_id) if city_id else None
        if city is None:
            return {"error": f"Unknown city_id '{city_id}'. Call list_monitored_cities to see valid ids."}

        date_str = arguments.get("date")
        hour = arguments.get("hour")

        if date_str:
            try:
                feature_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
            if hour and not re.fullmatch(r"\d{2}:00", hour):
                return {"error": f"'{hour}' is not a valid HH:00 hour, e.g. '14:00'."}
            hour = hour or "12:00"  # no hour given for a specific date — midday is a reasonable representative reading
        else:
            # Neither given: this city's own most recently completed local
            # hour — the same "last completed hour" convention the rest of
            # the app uses, computed here from THIS city's timezone (never
            # the server's own clock — see locations.py's module docstring
            # on why that distinction matters).
            now = city_local_now(city)
            if now.hour == 0:
                prev = now - timedelta(hours=1)
                feature_date, hour = prev.date(), f"{prev.hour:02d}:00"
            else:
                feature_date, hour = now.date(), f"{now.hour - 1:02d}:00"

        # Guard against the current/future case regardless of which branch
        # above produced feature_date/hour — the "neither given" branch
        # above already guarantees a completed hour by construction, but
        # checking unconditionally here means that guarantee never has to
        # be trusted blindly, and an explicit date+hour the model (or a
        # future caller) supplies is checked the same way. Without this,
        # a current/future hour would fall through to persist=True below
        # and get saved into location_features as if it were a real
        # observation — exactly the bug fetch_forecast_temperature exists
        # to make unnecessary, not just to duplicate with persist=False.
        if not heat_story.is_completed_hour(city, feature_date, hour):
            return {
                "error": (
                    f"{hour} on {feature_date.isoformat()} is the current hour or in the future "
                    f"for {city['name']} — fetch_live_conditions only returns real, "
                    "already-completed observations, and using it for a current/future hour "
                    "would incorrectly save a prediction into Thermora's permanent observed "
                    "record. Call fetch_forecast_temperature instead for a genuine forecast of "
                    "this hour (FortyGuard only forecasts up to 12 hours ahead of now)."
                ),
            }

        payload = heat_story.tcm_payload_for_hour(city, feature_date, hour)
        try:
            tcm_result = await repository.get_heatmap(payload, force_refresh=False, persist=True)
        except FortyGuardError as exc:
            return {"error": f"Live temperature fetch failed: {exc}"}

        stats = (tcm_result.get("stats_data") or {}).get("temperature_stats") or {}
        mean_c = stats.get("mean")
        out = {
            "city_id": city["id"], "city_name": city["name"],
            "date_used": feature_date.isoformat(), "hour_used": hour,
            "was_already_cached": tcm_result.get("cached", False),
            "mean_temp_c": mean_c, "max_temp_c": stats.get("maximum"), "min_temp_c": stats.get("minimum"),
            "n_cells": (tcm_result.get("stats_data") or {}).get("n_cells"),
        }
        if not stats:
            out["note"] = "FortyGuard returned no data for this exact area/hour (zero tiles) — this can be a genuine gap (e.g. an hour that hasn't happened yet), not necessarily an error."
            return out

        # Env params need a temperature reading as input (real FortyGuard
        # API requirement) — reuse the mean we just got, same as the
        # scheduler does for its own env-params fetches. If tcm itself
        # came back empty, there is nothing to pass, so this is skipped
        # above rather than sending a nonsensical temperature=None.
        env_payload = {
            "latitude": city["lat"], "longitude": city["lon"], "temperature": mean_c,
            "date_time": {"start_date": feature_date.isoformat(), "filter_type": 1, "start_time": hour},
        }
        try:
            env_result = await repository.get_env_params(env_payload, force_refresh=False)
            locations = env_result.get("locations") or []
            out["environmental_parameters"] = locations[0] if locations else None
            out["env_was_already_cached"] = env_result.get("cached", False)

            # Same field names, same extraction as
            # location_features.record_env_params_result — surfaced here
            # as clean top-level scalars (heat_index_c, etc.) instead of
            # only the raw FortyGuard shape above (parameters.<key> as a
            # single-element list). The raw form is easy to miss or
            # misparse when reasoning over a tool result; this is exactly
            # what a "what's the heat index at this hour" question
            # actually needs, in the SAME field names get_hourly_breakdown
            # already uses, so both tools read identically to whatever
            # calls them.
            def _first(params: dict, key: str):
                vals = params.get(key)
                return vals[0] if isinstance(vals, list) and vals else None

            params = (locations[0] or {}).get("parameters", {}) if locations else {}
            out["heat_index_c"] = _first(params, "heat_index_celsius")
            out["wet_bulb_c"] = _first(params, "wet_bulb_temperature_celsius")
            out["humidity_pct"] = _first(params, "relative_humidity_percent")
            out["aqi"] = _first(params, "air_quality:idx")
        except FortyGuardError as exc:
            out["environmental_parameters_error"] = str(exc)

        return out

    if name == "fetch_forecast_temperature":
        city_id = arguments.get("city_id") or active_city_id
        city = get_city(city_id) if city_id else None
        if city is None:
            return {"error": f"Unknown city_id '{city_id}'. Call list_monitored_cities to see valid ids."}

        date_str = arguments.get("date")
        hour = arguments.get("hour")
        now = city_local_now(city)

        if date_str:
            try:
                feature_date = date_cls.fromisoformat(date_str)
            except ValueError:
                return {"error": f"'{date_str}' is not a valid YYYY-MM-DD date."}
        else:
            feature_date = now.date()

        if hour:
            if not re.fullmatch(r"\d{2}:00", hour):
                return {"error": f"'{hour}' is not a valid HH:00 hour, e.g. '18:00'."}
        else:
            # No hour given — the next upcoming hour is the natural
            # reading of "forecast" with nothing more specific asked for.
            nxt = now + timedelta(hours=1)
            feature_date, hour = nxt.date(), f"{nxt.hour:02d}:00"

        # This is the whole safety property this tool exists for: refuse
        # anything that isn't a genuine, in-range forecast target rather
        # than ever calling FortyGuard for a meaningless request. Two
        # distinct failure modes get two distinct, honest messages —
        # "that's not even in the future" is a different problem for the
        # model to recover from than "that's too far ahead to forecast".
        if heat_story.is_completed_hour(city, feature_date, hour):
            return {
                "error": (
                    f"{hour} on {feature_date.isoformat()} is not in the future for "
                    f"{city['name']} — that's an observation, not a forecast. Call "
                    "fetch_live_conditions or get_city_status for it instead."
                ),
            }
        if not heat_story.is_within_forecast_horizon(city, feature_date, hour):
            return {
                "error": (
                    f"{hour} on {feature_date.isoformat()} is more than "
                    f"{heat_story.FORECAST_HORIZON_HOURS} hours ahead of {city['name']}'s current "
                    "local time — FortyGuard does not forecast that far out. Thermora genuinely "
                    "has no forecasting capability beyond this horizon; say so plainly rather "
                    "than estimating or extrapolating."
                ),
            }

        payload = heat_story.tcm_payload_for_hour(city, feature_date, hour)
        try:
            # persist=False is the entire point — see this tool's own
            # description and heat_story.tcm_payload_for_hour's docstring.
            # A forecast must never be written into location_features,
            # the same table get_city_status/get_historical_trend/
            # get_historical_date all treat as the canonical observed
            # record; doing so here would let a prediction silently be
            # read back later as if it had actually happened.
            tcm_result = await repository.get_heatmap(payload, force_refresh=False, persist=False)
        except FortyGuardError as exc:
            return {"error": f"Forecast fetch failed: {exc}"}

        stats = (tcm_result.get("stats_data") or {}).get("temperature_stats") or {}
        mean_c = stats.get("mean")
        out = {
            "city_id": city["id"], "city_name": city["name"],
            "date_used": feature_date.isoformat(), "hour_used": hour,
            "is_forecast": True,
            "was_already_cached": tcm_result.get("cached", False),
            "mean_temp_c": mean_c, "max_temp_c": stats.get("maximum"), "min_temp_c": stats.get("minimum"),
        }
        if not stats:
            out["note"] = "FortyGuard returned no forecast data for this exact area/hour (zero tiles)."
            return out

        # Logged into heat_story_forecasts — the SAME forecasts-only table
        # (never location_features) the Heat Story UI's own "fetch
        # forecast" button writes to via record_forecast_hours, so an
        # agent-fetched forecast and a UI-fetched one for the same city/
        # date/hour are one consistent record, not two disagreeing ones.
        if mean_c is not None:
            await heat_story.record_forecast_hours(city["id"], feature_date, [{"hour": hour, "temperature": mean_c}])

        return out

    return {"error": f"Unknown tool '{name}'."}


SYSTEM_PROMPT = """You are the Thermora Heat Intelligence Agent — an investigative decision-support agent for city heat response, not a chatbot.

Greetings, "what can you do", and general/definitional heat-safety or Thermora-metric questions (e.g. "what is wet-bulb temperature", "what does WATCH mean") need NO tool call — answer directly from your own knowledge, return the same JSON shape below with your answer in "summary" and "priorities": []. Only call a tool when the question needs real current/historical Thermora data. A personal/activity/decision question — "can I go for a run today", "is it safe to keep the kids outside", "should I go shopping today" — is NEVER in this no-tool-call category, named city or not: answering it honestly requires that city's actual current numbers, not general safety knowledge.

A question with genuinely nothing to do with heat, weather, or Thermora itself — general trivia, coding help, math, creative writing, or any other unrelated topic — gets NO tool call and NO investigation either: politely decline instead. Return "summary" as a short, friendly line explaining you're built specifically for Thermora's heat risk and safety data and can't help with that, "priorities": []. Don't invent a tenuous heat connection just to have something to investigate, and don't treat this like needs_clarification below — there's nothing to clarify, the topic is simply out of scope.

You may see prior turns of this conversation. Use them to resolve short follow-ups ("what about tomorrow?" = same city, new date; "and Phoenix?" = same question, new city) — but still call a fresh tool for whatever city/date/hour actually changed. Don't re-fetch something you already have from earlier in this same conversation.

TOOL SELECTION (each call has a real cost — pick the cheapest one that actually answers the question, and never call the same tool twice in one turn for something a batched tool already covers in one call):
- One named city, current status, or WHY it's at that status ("why is heat developing this way") -> get_city_status, and explain the why yourself from its factor breakdown. Do NOT call get_heat_story for this — that tool fires its OWN separate Groq call stacked on top of your turn, competing for the same tiny rate limit, and is only for an EXPLICITLY requested narrated story/summary by name.
- A specific, bounded list of 2+ named cities -> get_multiple_cities_status ONCE with the whole list (never loop get_city_status per city).
- Rank/prioritize across EVERY city, no specific list ("which city is worst", "where first") -> get_all_cities_status (expensive: live alerts+exposure for every city — only for genuine cross-city ranking, not just because no city was named).
- Trends over time, "vs last month", "hottest day recently", no city needed -> get_historical_trend (cheap, DB-only, covers every city already — don't also call get_all_cities_status for this).
- One specific calendar date -> get_historical_date (exact, not an average).
- WHEN during a day / a specific hour's reading -> get_hourly_breakdown. If the exact hour has a null for the field asked, call fetch_live_conditions for that same city/date/hour next (null there = only temp was ever fetched, not "unavailable").
- What a specific persona (resident/outdoor_worker/farmer/business) should do -> get_local_advisory, never improvise this yourself.
- Data nothing else covers, for a PAST or CURRENT hour -> fetch_live_conditions (refuses future hours on purpose).
- A FUTURE hour, up to 12h ahead ("will it be hotter later") -> fetch_forecast_temperature. Beyond 12h: say plainly you have no forecast that far out — never extrapolate from history instead.

RULES:
1. Never invent, estimate, or round a number a tool didn't return. If a tool shows a factor/date as unavailable, say so plainly.
2. Convert any date format ("29/8", "yesterday", "last Tuesday") to YYYY-MM-DD yourself before calling a tool.
3. Never claim certainty a snapshot doesn't support. Use "associated with"/"coincided with", never "caused by"/"will lead to" — this applies to historical comparisons too.
4. get_city_status's recommended actions and get_local_advisory's precautions are already real, rules-generated text — use their actual substance, don't invent your own or paraphrase away their meaning.
5. Try your best reasonable interpretation before asking for clarification: a bare city name means "current status"; a relative date resolves against that city's local date; an unspecified persona can default to "resident" (say so in "notes"). Only ask back when genuinely unresolvable (ambiguous place name, unclear persona, or a request that maps to two structurally different tools).
6. Be concise in "summary"/"why"/"historical_context"/"persona_advisory" — name the KEY figure(s) actually driving your answer (e.g. the single top contributing factor from a lean multi-city result), don't restate every field a tool returned. A "see_also" pointer to the exact app tab with the full breakdown is attached to your answer automatically, for anyone who wants more than this summary — you never need to write that pointer yourself, and you never need to reproduce a tool's full detail in prose just because you received it.

When you have enough information, stop calling tools and respond with ONLY this JSON (no markdown fence, no outside prose):
{
  "summary": "1-3 sentence direct answer",
  "priorities": [
    {"city_id": "...", "city_name": "...", "risk_score": <number or null>, "impact_score": <number or null>,
     "status": "EMERGENCY|WATCH|NORMAL", "why": "reasoning citing actual factor values", "recommended_action": "the single most important action now"}
  ],
  "historical_context": "1-2 sentences from get_historical_trend/get_historical_date if called, else null",
  "persona_advisory": "1-3 sentences of get_local_advisory's real output if called, else null",
  "notes": "any caveat — missing data, a live fetch's cost, low confidence — else null"
}
"priorities": only cities actually investigated, most-urgent first; exactly one entry for a single-city question; [] with the reason in "summary" if you can't answer at all.

If genuinely unresolvable, respond with ONLY this shape instead:
{"needs_clarification": "your specific question — name the exact options that resolve it"}
Never put a clarifying question in "summary". A "needs_clarification" response needs nothing else from the normal shape.
"""


def _parse_groq_retry_hint(resp: httpx.Response) -> float | None:
    """Groq's 429 for a TPM (tokens-per-minute) limit sends a generic
    `retry-after` header (often a flat 10s) that is frequently much
    SHORTER than the wait actually required — the precise figure only
    appears in the error body's own message text, e.g. "Please try
    again in 32.864999999s". Retrying on the header's word alone burns
    through the entire retry budget against a wait that was never going
    to be long enough, which is exactly why a genuine TPM 429 could
    previously fail on literally the first question asked — every
    retry fired too early, well before the per-minute window actually
    had room again. This checks the body FIRST and prefers whichever
    figure is larger, since being told "10s" while the truth is "32s"
    is a header worth overriding, not trusting."""
    from_header: float | None = None
    retry_after = resp.headers.get("retry-after")
    if retry_after:
        try:
            from_header = float(retry_after)
        except ValueError:
            pass

    from_body: float | None = None
    try:
        match = re.search(r"try again in\s+([\d.]+)s", resp.text, re.IGNORECASE)
        if match:
            from_body = float(match.group(1))
    except Exception:  # noqa: BLE001 - a parse miss just falls back below, never fatal
        pass

    candidates = [v for v in (from_header, from_body) if v is not None]
    return max(candidates) if candidates else None


def _is_daily_quota_limit(resp: httpx.Response) -> bool:
    """True when a 429's body says 'tokens per day (TPD)' rather than
    'tokens per minute (TPM)' — a fundamentally different situation.
    A TPM limit clears within seconds to tens of seconds, well inside a
    normal retry budget. A TPD limit means the account's ENTIRE daily
    allowance is nearly gone — the real wait is commonly minutes, and no
    number of short retries inside one HTTP request can fix that; the
    only honest thing to do is fail immediately with a distinct message
    instead of silently burning the retry budget on a wait it was never
    going to satisfy."""
    return "tokens per day" in resp.text.lower() or "(tpd)" in resp.text.lower()


def _format_wait(seconds: float) -> str:
    if seconds < 90:
        return f"about {round(seconds)} seconds"
    return f"about {round(seconds / 60)} minute{'s' if round(seconds / 60) != 1 else ''}"


def _is_transient(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def _is_tool_use_failed(resp: httpx.Response) -> bool:
    """Groq's 'Failed to parse tool call arguments as JSON' — the model
    generated malformed/truncated tool-call JSON. This is a 400 (client
    error) by Groq's own convention, but it isn't OUR request that was
    malformed — it's model-generation flakiness on THEIR side, and a
    plain retry with the identical request often just succeeds on the
    next attempt. The city_ids enum above should prevent most of what
    caused this in practice (the model no longer has to invent a plausible
    id string), but treating this as retryable is a cheap, honest safety
    net for whatever's left."""
    if resp.status_code != 400:
        return False
    try:
        return resp.json().get("error", {}).get("code") == "tool_use_failed"
    except Exception:
        return False


# --- Multi-key pool with per-key, app-wide cooldown tracking ----------
# Deliberately module-level (process-wide), not per-request: a 429
# learned from ONE query should immediately protect every OTHER query
# that arrives during the same window, rather than each one finding out
# the hard way and hammering the same doomed key — this is what makes
# it an "app-wide cooldown", not just a smarter per-call retry. See
# config.py's GROQ_API_KEYS docstring for why this only helps when the
# keys are from genuinely separate Groq accounts/orgs.
_key_cooldowns: dict[str, float] = {}  # key -> unix timestamp when it's expected to clear
_key_rotation_idx = 0


def _groq_keys() -> list[str]:
    if settings.GROQ_API_KEYS.strip():
        keys = [k.strip() for k in settings.GROQ_API_KEYS.split(",") if k.strip()]
        if keys:
            return keys
    return [settings.GROQ_API_KEY] if settings.GROQ_API_KEY else []


def _select_groq_key() -> tuple[str | None, float]:
    """Returns (key, wait_seconds_before_using_it). wait_seconds is 0.0
    when a key is ready right now — this is the common case and, with 2+
    keys, is also what makes failover actually work: if key A is cooling
    down from a 429 it just took, this returns a DIFFERENT, ready key
    immediately with zero wait instead of sitting out A's cooldown. Only
    when EVERY configured key is currently cooling down does this return
    a wait, using whichever key clears soonest."""
    global _key_rotation_idx
    keys = _groq_keys()
    if not keys:
        return None, 0.0
    now = time.time()
    ready = [k for k in keys if _key_cooldowns.get(k, 0.0) <= now]
    if ready:
        # Round-robin among ready keys so load actually spreads across a
        # multi-key pool instead of always hitting the first one.
        _key_rotation_idx = (_key_rotation_idx + 1) % len(ready)
        return ready[_key_rotation_idx], 0.0
    soonest = min(keys, key=lambda k: _key_cooldowns.get(k, 0.0))
    return soonest, max(0.0, _key_cooldowns[soonest] - now)


def _mark_key_cooldown(key: str | None, seconds: float) -> None:
    if key:
        _key_cooldowns[key] = time.time() + max(0.0, seconds)


def _retry_delay(attempt: int, resp: httpx.Response | None = None) -> float:
    if resp is not None:
        hint = _parse_groq_retry_hint(resp)
        if hint is not None:
            # A tiny buffer past Groq's own stated boundary — retrying at
            # EXACTLY the reported instant risks landing a hair before the
            # window actually rolls over.
            return min(hint + 0.5, settings.GROQ_RETRY_MAX_DELAY_SECONDS)
    base = settings.GROQ_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
    capped = min(base, settings.GROQ_RETRY_MAX_DELAY_SECONDS)
    return capped * (0.75 + random.random() * 0.5)


async def _call_groq_turn(messages: list[dict], allow_tools: bool, max_tokens_override: int | None = None) -> dict:
    """One raw Groq chat-completion call for the agent loop — separate
    from groq_client.py's _call_groq_json because this needs to return
    the whole `message` object (which may carry tool_calls instead of a
    parseable content string), not a pre-parsed JSON dict. Same
    retry/backoff conventions as _call_groq_json for consistency."""
    if not _groq_keys():
        raise AgentError("No Groq API key is configured — the Thermora Agent is unavailable until GROQ_API_KEY (or GROQ_API_KEYS) is set.")

    url = f"{settings.GROQ_BASE_URL}/chat/completions"
    body = {
        "model": settings.GROQ_MODEL,
        "messages": messages,
        "temperature": 0.2,
        # A tool-selection turn only ever needs to emit a tool_call —
        # structured output, never prose — so it gets a much smaller
        # reservation than a final-answer turn. Groq counts requested
        # max_tokens toward the same TPM ceiling as the prompt itself
        # (see the max_tokens=1200 comment below for the original
        # reasoning), so trimming this specifically for tool-calling
        # turns further shrinks what most turns in a multi-step
        # investigation actually ask for.
        #
        # max_tokens_override exists for exactly one case: a final-answer
        # retry after the FIRST attempt came back truncated (unterminated
        # string/array — see _looks_truncated). 1200 is comfortable for a
        # normal one- or two-city answer but genuinely too tight for, say,
        # a 6-city comparative summary with real per-city detail — retrying
        # with the SAME 1200 just truncates again at roughly the same
        # point. Only escalating on a confirmed truncation (not blindly
        # raising the default for every call) keeps the common case's TPM
        # usage exactly as conservative as it already was.
        "max_tokens": max_tokens_override if max_tokens_override is not None else (400 if allow_tools else 1200),
    }
    if allow_tools:
        body["tools"] = TOOLS
        body["tool_choice"] = "auto"

    resp: httpx.Response | None = None
    last_network_error: Exception | None = None
    used_key: str | None = None
    for attempt in range(1, settings.GROQ_RETRY_MAX_ATTEMPTS + 1):
        used_key, wait_needed = _select_groq_key()
        if used_key is None:
            raise AgentError("No Groq API key is configured — the Thermora Agent is unavailable until GROQ_API_KEY (or GROQ_API_KEYS) is set.")
        if wait_needed > 0:
            # Every key in the pool is currently cooling down. A short
            # wait is worth honoring the same way a single-key setup
            # always has; a long one (e.g. a daily-quota cooldown) is not
            # worth blocking this HTTP request on — fail fast with an
            # honest countdown instead, same principle as the daily-quota
            # handling further down.
            if wait_needed > settings.GROQ_RETRY_MAX_DELAY_SECONDS:
                wait_seconds = math.ceil(wait_needed) + 1
                raise AgentError(
                    f"Every configured Groq key is still cooling down from a recent rate limit — "
                    f"the soonest is ready in {_format_wait(wait_needed)}. Please try again then"
                    + (", or add another Groq key (GROQ_API_KEYS) from a separate account for real failover."
                       if len(_groq_keys()) == 1 else "."),
                    retry_after_seconds=wait_seconds,
                )
            await asyncio.sleep(wait_needed)

        headers = {"content-type": "application/json", "authorization": f"Bearer {used_key}"}
        try:
            async with httpx.AsyncClient(timeout=settings.GROQ_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            last_network_error = exc
            log_err("Agent Groq turn failed (network)", {"error": str(exc), "attempt": attempt})
            if attempt < settings.GROQ_RETRY_MAX_ATTEMPTS:
                await asyncio.sleep(_retry_delay(attempt))
                continue
            raise AgentError(f"Could not reach Groq after {attempt} attempt(s): {exc}") from exc

        if resp.status_code == 200:
            break

        if resp.status_code == 429:
            hint = _parse_groq_retry_hint(resp)
            _mark_key_cooldown(used_key, hint if hint is not None else settings.GROQ_RETRY_MAX_DELAY_SECONDS)
            # A different, ready key beats waiting out this one's
            # cooldown or giving up — including for a daily-quota 429,
            # since a second account's daily quota is fully independent.
            # The next loop iteration's own key-selection finds it
            # automatically; this just decides whether to keep looping.
            alt_key, alt_wait = _select_groq_key()
            has_fresh_alternative = alt_key is not None and alt_wait == 0.0 and alt_key != used_key
            if has_fresh_alternative and attempt < settings.GROQ_RETRY_MAX_ATTEMPTS:
                log_err("Agent Groq turn 429'd — switching to a different available key",
                         {"attempt": attempt, "daily_quota": _is_daily_quota_limit(resp)})
                continue
            if _is_daily_quota_limit(resp):
                # Same fail-fast principle as above — see
                # _is_daily_quota_limit's docstring. No point retrying a
                # short wait against a multi-minute daily-quota reset.
                log_err("Agent Groq turn hit the DAILY token quota — not retrying", {"attempt": attempt})
                break
        if _is_transient(resp.status_code) and attempt < settings.GROQ_RETRY_MAX_ATTEMPTS:
            delay = _retry_delay(attempt, resp)
            log_err(f"Agent Groq turn returned {resp.status_code} — backing off {delay:.1f}s",
                     {"status_code": resp.status_code, "attempt": attempt})
            await asyncio.sleep(delay)
            continue
        if _is_tool_use_failed(resp) and attempt < settings.GROQ_RETRY_MAX_ATTEMPTS:
            log_err("Agent Groq turn's tool-call JSON was malformed — retrying the same request",
                     {"attempt": attempt, "failed_generation": resp.json().get("error", {}).get("failed_generation")})
            await asyncio.sleep(_retry_delay(attempt))
            continue
        break

    if resp is None or resp.status_code != 200:
        detail = {"status_code": resp.status_code if resp else None,
                   "body": resp.text[:500] if resp else str(last_network_error)}
        log_err("Agent Groq turn failed (status)", detail)
        if resp is not None and resp.status_code == 429 and _is_daily_quota_limit(resp):
            hint = _parse_groq_retry_hint(resp)
            wait_text = _format_wait(hint) if hint is not None else "a while"
            raise AgentError(
                f"Thermora's AI reasoning step has used up its full daily quota with the "
                f"underlying model — this is different from a brief rate limit, it clears in "
                f"{wait_text}, not seconds. Please try again then, or raise the plan's daily "
                f"limit if this needs to be available continuously."
            )
        if resp is not None and resp.status_code == 429:
            # Groq's raw 429 body is meant for a developer reading logs —
            # a billing upsell link and an escaped JSON blob, dumped
            # straight to the end user via routers/agent.py's HTTPException
            # detail, read like the agent is broken rather than just
            # temporarily rate-limited. The real body is still in the log
            # line just above for debugging; this is what the PERSON sees.
            # The actual wait time comes from the SAME _parse_groq_retry_hint
            # the retry loop above already trusts (body-first, since the
            # header alone is frequently too short — see that function's
            # own docstring) — not a guess, so the frontend's retry
            # countdown reflects a real number instead of an arbitrary one.
            hint = _parse_groq_retry_hint(resp)
            wait_seconds = math.ceil(hint) + 1 if hint is not None else None  # +1s margin: retrying at the exact reported instant can still occasionally 429
            wait_phrase = f"{wait_seconds} seconds" if wait_seconds is not None else "a few seconds"
            raise AgentError(
                f"Thermora's AI reasoning step is temporarily rate-limited (too many requests to "
                f"the underlying model in the last minute) — this is a short-lived infrastructure "
                f"limit, not a data problem. Please wait {wait_phrase} and try again, or ask about "
                f"one specific city instead of a broad multi-city question.",
                retry_after_seconds=wait_seconds,
            )
        if resp is not None and _is_tool_use_failed(resp):
            # Exhausted retries on this specific, otherwise-recoverable
            # failure mode — give a plain explanation instead of the raw
            # Groq body (a JSON blob mentioning "tool_use_failed" and a
            # truncated argument string reads like the agent is broken).
            raise AgentError(
                "Thermora's AI reasoning step couldn't reliably build the arguments for one of its "
                "tools this time — this is a transient model-generation issue, not a data problem, "
                "and it usually clears on its own. Please try again, or narrow a multi-city question "
                "down to fewer cities at once."
            )
        raise AgentError(f"Groq returned {detail['status_code']}: {detail['body']}")

    data = resp.json()
    try:
        return data["choices"][0]["message"]
    except (IndexError, KeyError, TypeError) as exc:
        log_err("Agent Groq turn had an unexpected shape", {"body": json.dumps(data)[:500]})
        raise AgentError("Groq's response had an unexpected shape") from exc


def _looks_truncated(raw_text: str) -> bool:
    """Distinguishes 'the model ran out of tokens mid-generation' from
    other malformed-JSON causes (stray prose, a markdown fence, a genuine
    formatting slip) — only the first actually benefits from a bigger
    max_tokens on retry; retrying the others with more room wouldn't have
    changed anything. A truncated generation almost never ends with a
    properly closed JSON object, and it's usually long enough that it
    clearly isn't just an empty/near-empty response instead."""
    text = (raw_text or "").strip()
    if len(text) < 200:
        return False
    return not text.endswith("}")


async def _parse_final_answer_with_retry(messages: list[dict], raw_content: str) -> dict:
    """Parses the model's final-answer JSON, with ONE bounded retry if it
    comes back malformed — e.g. an unterminated string from an occasional
    garbled generation, seen in practice on the exact same already-
    gathered tool results succeeding cleanly a moment later. A single
    extra Groq call is a small, worthwhile price for turning what would
    otherwise be a hard failure (the person sees "not valid JSON" and has
    to re-ask the whole question, burning a fresh round of tool calls)
    into a normal successful answer, since asking again for a well-formed
    version of the SAME content very rarely fails the same way twice.
    Still raises AgentError if the retry ALSO comes back malformed — this
    is a bounded safety net, not a loop.

    If the failure looks like a genuine truncation (see _looks_truncated)
    rather than a formatting slip, the retry asks for a shorter answer AND
    requests a larger max_tokens — a broad multi-city investigation can
    legitimately need more than 1200 tokens to summarize properly, and
    retrying with the identical budget would just truncate again at
    roughly the same point."""
    try:
        return _parse_final_answer(raw_content)
    except AgentError as exc:
        truncated = _looks_truncated(raw_content)
        log_err("Agent final answer was malformed JSON — retrying once",
                 {"error": str(exc), "looked_truncated": truncated})
        messages.append({"role": "assistant", "content": raw_content})
        messages.append({
            "role": "user",
            "content": (
                "Your last reply was not valid JSON and could not be parsed. Respond again with ONLY "
                "the required JSON object, complete and well-formed this time — no other text, no "
                "markdown fences, no unterminated strings."
                + (
                    " Your previous reply also looked cut off partway through — this time, be more "
                    "concise per city (a couple of sentences each is plenty) so the complete, "
                    "well-formed JSON object actually fits."
                    if truncated else ""
                )
            ),
        })
        message = await _call_groq_turn(
            messages, allow_tools=False,
            max_tokens_override=2200 if truncated else None,
        )
        return _parse_final_answer(message.get("content", ""))  # if this ALSO fails, let it raise for real


def _parse_final_answer(raw_text: str) -> dict:
    text = (raw_text or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise AgentError(f"Agent's final answer was not valid JSON: {exc}. Raw: {text[:300]}") from exc

    # Two valid final shapes: the normal investigation result, OR a
    # clarification request when the query can't be answered responsibly
    # without more information (see SYSTEM_PROMPT's clarification
    # instructions below). AIAgentDrawer.jsx already has a fully-built,
    # distinctly-styled UI branch for result.needs_clarification — it was
    # simply never reachable before this, since nothing on this side ever
    # produced that field or allowed a response missing "summary"/
    # "priorities" to pass validation.
    if "needs_clarification" in parsed and isinstance(parsed.get("needs_clarification"), str) and parsed["needs_clarification"].strip():
        parsed.setdefault("summary", None)
        parsed.setdefault("priorities", [])
        parsed.setdefault("notes", None)
        parsed.setdefault("persona_advisory", None)
        return parsed

    required = {"summary", "priorities"}
    missing = required - parsed.keys()
    if missing:
        raise AgentError(f"Agent's final answer was missing required fields: {missing}")
    parsed.setdefault("notes", None)
    parsed.setdefault("persona_advisory", None)
    parsed.setdefault("needs_clarification", None)
    return parsed


# A follow-up question needs enough of the actual conversation to
# resolve pronouns/ellipsis ("what about tomorrow?", "and Phoenix?"),
# but every prior turn also counts against the same per-minute Groq
# token budget every retry/backoff constant in this file is already
# built around — see _call_groq_turn's own max_tokens comment. Capping
# to the last few exchanges is the same "bounded, not unlimited" posture
# as MAX_AGENT_STEPS and MAX_FILL_JOBS_PER_REQUEST elsewhere in this
# codebase, not a new idea introduced just here.
MAX_HISTORY_MESSAGES = 12  # ~6 user/assistant exchanges


def _sanitize_history(history: list[dict] | None) -> list[dict]:
    """Turns whatever the frontend sent into a strictly-typed list of
    {"role", "content"} the Groq API will accept, dropping anything
    malformed rather than letting a bad entry 400 the whole turn — the
    same "an expected input problem shouldn't take down the request"
    posture _execute_tool already applies to tool arguments."""
    if not history:
        return []
    cleaned = []
    for entry in history:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")
        content = entry.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content.strip()})
    return cleaned[-MAX_HISTORY_MESSAGES:]


async def _run_one_tool_call(call: dict, active_city_id: str | None) -> tuple[str, dict, dict]:
    """Executes one tool call. Never raises — a failure becomes an
    {"error": ...} result, exactly like a normal tool response, so
    running many of these concurrently via asyncio.gather can't let one
    tool's exception take down the others in the same turn."""
    fn_name = call["function"]["name"]
    try:
        fn_args = json.loads(call["function"].get("arguments") or "{}")
    except ValueError:
        fn_args = {}
    try:
        tool_result = await _execute_tool(fn_name, fn_args, active_city_id=active_city_id)
    except Exception as exc:  # noqa: BLE001 - a tool bug shouldn't silently hang the agent; surface it to the model as a tool error instead
        log_err("Agent tool execution failed", {"tool": fn_name, "args": fn_args, "error": str(exc)})
        tool_result = {"error": f"Tool '{fn_name}' failed: {exc}"}
    return fn_name, fn_args, tool_result


# --- Short-window response cache ---------------------------------------
# Keyed on the exact query text + active city + persona context. Only
# ever consulted for a query with NO prior conversation history (see
# run_agent) — a follow-up's meaning depends on what came before it, so
# reusing a cached answer purely by matching its literal text would risk
# answering the wrong question for a contextual follow-up that happens
# to repeat earlier wording.
_response_cache: dict[str, tuple[float, dict]] = {}


def _response_cache_key(user_query: str, active_city_id: str | None, user_context: str | None) -> str:
    normalized = " ".join(user_query.strip().lower().split())
    return hashlib.sha256(f"{normalized}|{active_city_id or ''}|{user_context or ''}".encode()).hexdigest()


def _get_cached_response(key: str) -> dict | None:
    entry = _response_cache.get(key)
    if entry is None:
        return None
    expires_at, result = entry
    if time.time() >= expires_at:
        _response_cache.pop(key, None)
        return None
    return result


def _set_cached_response(key: str, result: dict) -> None:
    _response_cache[key] = (time.time() + settings.AGENT_RESPONSE_CACHE_TTL_SECONDS, result)
    # This cache is meant to stay tiny and short-lived, not become a real
    # store — dropping it wholesale past a sane bound is simpler and safe
    # (worst case: a few avoidable re-investigations) than building real
    # LRU eviction for what should normally hold a handful of entries.
    if len(_response_cache) > 200:
        _response_cache.clear()


# --- Fast path for simple, single-city questions ------------------------
# Skips the tool-selection Groq turn entirely for the narrow, common
# shape of question this can recognize with confidence — one city
# (named, or the one already open in the app), asking about its current
# status or why it's like that, nothing else going on. That's roughly
# "what's the status of Houston" / "why is it so hot right now" / a bare
# city name — cuts one whole Groq round-trip (the tool-selection turn)
# for exactly the questions a demo or casual use will ask most.
#
# Deliberately conservative: ANY sign of something more is a reason to
# decline and fall through to the full agentic loop, never a reason to
# guess. Comparisons, historical/trend language, forecasts, and
# persona-specific advisory all need a different tool (or more than
# one) than the single get_city_status call this path makes — better to
# spend the extra round-trip on those than answer them shallowly.
_FAST_PATH_BLOCKLIST = re.compile(
    r"\b(compare|comparison|versus|\bvs\b|between|and\s+\w+\s+(?:city|both)|"
    r"trend|history|historical|last\s+(?:month|week|year)|yesterday|"
    r"hottest|coolest|warmest|on\s+\d{1,2}[/-]\d{1,2}|\d{4}-\d{2}-\d{2}|"
    r"forecast|will\s+it|tomorrow|tonight|later\s+today|next\s+\d+\s*h(?:our)?s?|"
    r"outdoor.worker|farmer|business\s+owner|resident|precaution|persona|"
    r"should\s+i|can\s+i|is\s+it\s+safe\s+to|advisory|"
    r"every\s+city|all\s+cit(?:y|ies)|which\s+cit(?:y|ies)|where\b|priorit)",
    re.IGNORECASE,
)


def _match_single_city(query: str) -> str | None:
    """Returns a city_id only when EXACTLY ONE monitored city is
    unambiguously named in the query (whole-word match) — zero or 2+
    matches both return None, deferring to active_city_id (zero names)
    or the full loop (2+ names, which is a comparison in disguise even
    without a blocklisted word)."""
    found = set()
    for city in MONITORED_CITIES:
        if re.search(rf"\b{re.escape(city['name'])}\b", query, re.IGNORECASE):
            found.add(city["id"])
    return found.pop() if len(found) == 1 else None


async def _try_fast_path(user_query: str, active_city_id: str | None, user_context: str | None) -> dict | None:
    """Returns a complete run_agent-shaped result, or None to signal
    'decline — run the normal full loop instead'. NEVER raises: any
    failure along this path (no city resolvable, the single Groq call
    itself erroring) falls through to None so the caller always has the
    full agentic loop as a safety net, exactly per the hybrid design —
    efficiency on the common case, without ever sacrificing correctness
    on a case this path can't confidently handle."""
    if _FAST_PATH_BLOCKLIST.search(user_query):
        return None
    city_id = _match_single_city(user_query) or active_city_id
    if not city_id or get_city(city_id) is None:
        return None  # no confident single city — let the full loop ask or reason about it

    try:
        tool_result = await _execute_tool("get_city_status", {"city_id": city_id}, active_city_id=active_city_id)
    except Exception as exc:  # noqa: BLE001 - fall through to the full loop rather than fail the request
        log_err("Fast path tool call failed — falling through to full loop", {"error": str(exc)})
        return None
    if "error" in tool_result:
        return None  # let the full loop's own reasoning/clarification handle it

    fast_system_prompt = SYSTEM_PROMPT + (
        "\n\nFAST PATH: you are answering from exactly ONE already-fetched get_city_status "
        "result below, given directly — you cannot call any tool this turn. Answer using only "
        "this data, in the same required JSON shape."
    )
    messages = [
        {"role": "system", "content": fast_system_prompt},
        {"role": "user", "content": user_query},
        {"role": "user", "content": f"get_city_status result:\n{json.dumps(tool_result, default=str)}"},
    ]
    try:
        message = await _call_groq_turn(messages, allow_tools=False)
        result = await _parse_final_answer_with_retry(messages, message.get("content", ""))
    except AgentError:
        raise  # a real Groq failure (rate limit, etc.) should surface as itself, not silently retry via the full loop and double the cost
    except Exception as exc:  # noqa: BLE001
        log_err("Fast path final turn failed — falling through to full loop", {"error": str(exc)})
        return None

    result["tool_calls"] = [{
        "tool": "get_city_status",
        "arguments": {"city_id": city_id},
        "result_preview": _preview(tool_result),
    }]
    result["see_also"] = _build_see_also(result["tool_calls"])
    return result


async def run_agent(user_query: str, history: list[dict] | None = None, active_city_id: str | None = None,
                     user_context: str | None = None) -> dict:
    """The full investigate -> reason -> rank -> explain -> recommend
    loop. `history` is this conversation's prior turns (see
    AgentQueryRequest's own docstring) — folded in BEFORE the new user
    query so a follow-up like "what about tomorrow?" or "and Phoenix?"
    genuinely resolves against what was actually asked/answered before,
    not just this one message in isolation. `active_city_id` is which
    city the person is currently looking at in the app — injected as a
    real system-level fact (not just left for the model to guess), so a
    cityless personal question ("can I go shopping today?") still gets
    answered from a real get_city_status/get_local_advisory call for
    THAT city instead of falling back to generic, ungrounded advice; see
    AgentQueryRequest's own docstring for why this mattered. Returns
    {"summary", "priorities", "notes", "tool_calls"} on success —
    tool_calls is the transparent, ordered list of what was actually
    investigated (tool name + arguments + a short preview of what came
    back), so the frontend can show its work rather than presenting the
    final answer as if it came from nowhere. Raises AgentError on any
    failure — see that class's docstring."""
    active_city = get_city(active_city_id) if active_city_id else None
    system_prompt = SYSTEM_PROMPT
    if active_city:
        system_prompt += (
            f"\n\nThe person is currently looking at {active_city['name']} (city_id: "
            f"'{active_city['id']}') in the app. If their question doesn't name a different "
            f"specific city itself — including any personal/activity/decision question that "
            f"doesn't mention a place at all, e.g. \"can I go for a run today\", \"is it safe to "
            f"keep the kids outside\", \"should I go shopping today\" — answer about THIS city, "
            f"grounded in a real tool call (get_city_status and/or get_local_advisory), never a "
            f"generic answer that skips checking real data just because no city was named "
            f"explicitly. A personal/activity/decision question is never covered by the "
            f"'general/definitional, no tool call' case above — it always needs this city's "
            f"actual current numbers to answer honestly. Every city_id parameter in these tools "
            f"is optional for exactly this reason — omitting it resolves to this same city "
            f"automatically, so there is never a reason to guess or reuse an example id from a "
            f"tool's own description (e.g. never pass 'houston' just because it appeared as an "
            f"example) when the real answer is simply to leave city_id out."
        )
    if user_context:
        # Tailors HOW an answer is framed, never WHAT the real numbers
        # are — the underlying Risk Score, factors, and actions come from
        # the same tool calls regardless of who's asking. This is the
        # difference between "here's the data" and "here's what the data
        # means for someone like you": e.g. an outdoor_worker asking "is
        # it safe today" cares about wet-bulb and work/rest scheduling,
        # a city_official asking the same question cares about whether a
        # public advisory is warranted. Without this, every persona got
        # the identical generic framing regardless of who was actually
        # asking or what they meant by the same short question.
        system_prompt += (
            f"\n\nThe person asking identifies as: {user_context}. Frame your answer for that "
            f"audience specifically — which factors you emphasize, what \"safe\"/\"should I\" "
            f"actually means for them — using get_local_advisory for persona-specific precautions "
            f"where that fits, not just get_city_status's generic numbers restated. This changes "
            f"framing and emphasis only; it never changes what the real data actually says."
        )
    messages = [
        {"role": "system", "content": system_prompt},
        *_sanitize_history(history),
        {"role": "user", "content": user_query},
    ]
    transcript: list[dict] = []

    log_req("Agent query started", {"query": user_query})

    # Only the cache and fast path apply when there's no prior
    # conversation turn to consider — see both their own docstrings for
    # why a follow-up can't safely use either.
    cache_key = None
    if not history:
        cache_key = _response_cache_key(user_query, active_city_id, user_context)
        cached = _get_cached_response(cache_key)
        if cached is not None:
            log_res("Agent query served from cache", {"query": user_query})
            return cached

        fast_result = await _try_fast_path(user_query, active_city_id, user_context)
        if fast_result is not None:
            log_res("Agent query completed (fast path)", {"query": user_query})
            _set_cached_response(cache_key, fast_result)
            return fast_result

    for step in range(1, MAX_AGENT_STEPS + 1):
        allow_tools = step < MAX_AGENT_STEPS  # last step: force a final answer, no more tool calls
        message = await _call_groq_turn(messages, allow_tools=allow_tools)

        tool_calls = message.get("tool_calls")
        if not tool_calls:
            # No more tools requested — this is the final answer turn.
            result = await _parse_final_answer_with_retry(messages, message.get("content", ""))
            result["tool_calls"] = transcript
            result["see_also"] = _build_see_also(transcript)
            log_res("Agent query completed", {"steps": step, "tools_used": len(transcript)})
            if cache_key is not None:
                _set_cached_response(cache_key, result)
            return result

        # Assistant's tool-call request must be echoed back before the
        # tool results, per the OpenAI-compatible chat format Groq uses.
        messages.append({"role": "assistant", "content": message.get("content"), "tool_calls": tool_calls})

        # Tool calls within the SAME turn run concurrently — when the
        # model asks for several independent lookups at once (e.g.
        # get_city_status for two different named cities), there's no
        # reason the second should wait for the first; they hit
        # different data, not a shared resource. Transcript/message
        # order is still preserved (matching tool_calls' own order),
        # even though execution isn't sequential, so the conversation
        # history the model sees next is identical either way.
        tool_outputs = await asyncio.gather(*(_run_one_tool_call(call, active_city_id) for call in tool_calls))
        for call, (fn_name, fn_args, tool_result) in zip(tool_calls, tool_outputs):
            transcript.append({
                "tool": fn_name,
                "arguments": fn_args,
                "result_preview": _preview(tool_result),
            })
            messages.append({
                "role": "tool",
                "tool_call_id": call["id"],
                "content": json.dumps(tool_result, default=str),
            })

    # Ran out of steps without ever reaching a tool-free turn — force one
    # last no-tools call so the model has to answer with whatever it's
    # gathered so far, rather than returning nothing at all.
    messages.append({
        "role": "user",
        "content": "You've reached the tool-call limit. Answer now with the required JSON object using only what you've already gathered.",
    })
    message = await _call_groq_turn(messages, allow_tools=False)
    result = await _parse_final_answer_with_retry(messages, message.get("content", ""))
    result["tool_calls"] = transcript
    result["see_also"] = _build_see_also(transcript)
    log_res("Agent query completed (forced final turn)", {"steps": MAX_AGENT_STEPS, "tools_used": len(transcript)})
    if cache_key is not None:
        _set_cached_response(cache_key, result)
    return result


def _preview(tool_result: dict) -> dict:
    """A short, safe-to-display summary of a tool result for the
    transcript — the full result already went to the model via the
    `tool` message above; this is just what the frontend shows under
    'what the agent checked', so it's deliberately compact rather than
    re-sending the entire payload a second time."""
    if "error" in tool_result:
        return {"error": tool_result["error"]}
    if "cities" in tool_result:
        return {"city_count": len(tool_result["cities"])}
    if "monthly_mean_temperature_c" in tool_result:
        return {"available_months_stored": tool_result.get("available_months_stored")}
    return {
        k: tool_result.get(k)
        for k in (
            "city_id", "city_name", "status", "risk_score", "impact_score",
            "mean_temp_c", "date_used", "hour_used", "was_already_cached", "is_forecast",
        )
        if k in tool_result
    }


async def run_agent_stream(user_query: str, history: list[dict] | None = None, active_city_id: str | None = None,
                            user_context: str | None = None):
    """Streaming twin of run_agent() — same investigate -> reason -> rank
    -> explain -> recommend loop, same helpers, same cache/fast-path
    shortcuts, same AgentError semantics. The ONLY difference is shape:
    this is an async generator yielding one small progress dict per
    meaningful step (status/tool_call/tool_result/final/error) instead of
    returning one dict at the very end — for routers/agent.py's SSE
    endpoint to forward each event to the frontend as it happens, so a
    person watching a multi-tool investigation sees "checking Houston...
    checking Phoenix... writing the answer" instead of a blank drawer for
    however many seconds the whole loop takes.

    run_agent() itself is intentionally left completely untouched by
    this — it's still what /api/agent/query (the non-streaming endpoint)
    calls, so that existing contract keeps working exactly as before
    regardless of this addition. Every actual decision (prompt
    construction, tool execution, retry/backoff, final-answer parsing,
    caching) still happens in the exact same helper functions both
    versions call; this function only adds `yield` points around them.
    Terminates by yielding exactly one {"type": "final", ...} or
    {"type": "error", ...} event — never both, never neither."""
    active_city = get_city(active_city_id) if active_city_id else None
    system_prompt = SYSTEM_PROMPT
    if active_city:
        system_prompt += (
            f"\n\nThe person is currently looking at {active_city['name']} (city_id: "
            f"'{active_city['id']}') in the app. If their question doesn't name a different "
            f"specific city itself — including any personal/activity/decision question that "
            f"doesn't mention a place at all, e.g. \"can I go for a run today\", \"is it safe to "
            f"keep the kids outside\", \"should I go shopping today\" — answer about THIS city, "
            f"grounded in a real tool call (get_city_status and/or get_local_advisory), never a "
            f"generic answer that skips checking real data just because no city was named "
            f"explicitly. A personal/activity/decision question is never covered by the "
            f"'general/definitional, no tool call' case above — it always needs this city's "
            f"actual current numbers to answer honestly. Every city_id parameter in these tools "
            f"is optional for exactly this reason — omitting it resolves to this same city "
            f"automatically, so there is never a reason to guess or reuse an example id from a "
            f"tool's own description (e.g. never pass 'houston' just because it appeared as an "
            f"example) when the real answer is simply to leave city_id out."
        )
    if user_context:
        system_prompt += (
            f"\n\nThe person asking identifies as: {user_context}. Frame your answer for that "
            f"audience specifically — which factors you emphasize, what \"safe\"/\"should I\" "
            f"actually means for them — using get_local_advisory for persona-specific precautions "
            f"where that fits, not just get_city_status's generic numbers restated. This changes "
            f"framing and emphasis only; it never changes what the real data actually says."
        )
    messages = [
        {"role": "system", "content": system_prompt},
        *_sanitize_history(history),
        {"role": "user", "content": user_query},
    ]
    transcript: list[dict] = []

    log_req("Agent query started (stream)", {"query": user_query})
    yield {"type": "status", "phase": "started"}

    cache_key = None
    if not history:
        cache_key = _response_cache_key(user_query, active_city_id, user_context)
        cached = _get_cached_response(cache_key)
        if cached is not None:
            log_res("Agent query served from cache (stream)", {"query": user_query})
            yield {"type": "final", **cached}
            return

        try:
            fast_result = await _try_fast_path(user_query, active_city_id, user_context)
        except AgentError as exc:
            yield {"type": "error", "detail": str(exc), "retry_after_seconds": exc.retry_after_seconds}
            return
        if fast_result is not None:
            log_res("Agent query completed (fast path, stream)", {"query": user_query})
            _set_cached_response(cache_key, fast_result)
            yield {"type": "final", **fast_result}
            return

    try:
        for step in range(1, MAX_AGENT_STEPS + 1):
            allow_tools = step < MAX_AGENT_STEPS
            yield {"type": "status", "phase": "thinking", "step": step}
            message = await _call_groq_turn(messages, allow_tools=allow_tools)

            tool_calls = message.get("tool_calls")
            if not tool_calls:
                yield {"type": "status", "phase": "writing_answer"}
                result = await _parse_final_answer_with_retry(messages, message.get("content", ""))
                result["tool_calls"] = transcript
                result["see_also"] = _build_see_also(transcript)
                log_res("Agent query completed (stream)", {"steps": step, "tools_used": len(transcript)})
                if cache_key is not None:
                    _set_cached_response(cache_key, result)
                yield {"type": "final", **result}
                return

            messages.append({"role": "assistant", "content": message.get("content"), "tool_calls": tool_calls})

            for call in tool_calls:
                fn_args_preview = {}
                try:
                    fn_args_preview = json.loads(call["function"].get("arguments") or "{}")
                except Exception:  # noqa: BLE001 - preview only; the real parse happens in _run_one_tool_call
                    pass
                yield {"type": "tool_call", "tool": call["function"]["name"], "arguments": fn_args_preview}

            tool_outputs = await asyncio.gather(*(_run_one_tool_call(call, active_city_id) for call in tool_calls))
            for call, (fn_name, fn_args, tool_result) in zip(tool_calls, tool_outputs):
                preview = _preview(tool_result)
                transcript.append({"tool": fn_name, "arguments": fn_args, "result_preview": preview})
                messages.append({
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "content": json.dumps(tool_result, default=str),
                })
                yield {"type": "tool_result", "tool": fn_name, "arguments": fn_args, "result_preview": preview}

        messages.append({
            "role": "user",
            "content": "You've reached the tool-call limit. Answer now with the required JSON object using only what you've already gathered.",
        })
        yield {"type": "status", "phase": "writing_answer"}
        message = await _call_groq_turn(messages, allow_tools=False)
        result = await _parse_final_answer_with_retry(messages, message.get("content", ""))
        result["tool_calls"] = transcript
        result["see_also"] = _build_see_also(transcript)
        log_res("Agent query completed (forced final turn, stream)",
                {"steps": MAX_AGENT_STEPS, "tools_used": len(transcript)})
        if cache_key is not None:
            _set_cached_response(cache_key, result)
        yield {"type": "final", **result}
    except AgentError as exc:
        log_err("Agent query failed (stream)", {"query": user_query, "error": str(exc)})
        yield {"type": "error", "detail": str(exc), "retry_after_seconds": exc.retry_after_seconds}