"""
Phase 11 — Heat Story narrative generation (Groq).

Same role as gemini_client.py (kept in place, unused, in case of a switch
back — see config.py's GEMINI_* block): the first place in Thermora an LLM
actually writes prose. Every engine before this one (Heat Risk Score,
People Impact Score, Emergency Mode) is deterministic. This module only
ever sends data Thermora already computed (Phase 5's observed
location_features rows, a forecast heatmap result the frontend already
fetched with persist=False, Phase 6's exposure counts) — it never lets the
model invent a number, and the prompt says so explicitly. See
routers/heat_story.py for how the three are assembled.

Groq's API is OpenAI-compatible (POST /openai/v1/chat/completions,
messages: [{role, content}], response under
choices[0].message.content) — different shape from Gemini's
system_instruction/contents/candidates, so this is a real rewrite of the
request/response handling, not a config-only swap. Uses httpx directly,
same pattern as every other client in this codebase — no new SDK
dependency.
"""
import asyncio
import json
import random

import httpx

from .config import settings
from .logger import log_req, log_res, log_err


class GroqError(Exception):
    """Raised whenever a narrative genuinely couldn't be produced — a
    missing API key, a network failure, a non-200 from Groq (after
    exhausting retries on transient ones), or a response that didn't parse
    into the expected shape. Callers (routers/heat_story.py) catch this
    and return an honest 'story unavailable' response instead of failing
    the whole page — Heat Story's observed/coverage data is still useful
    with no narrative on top of it."""


# Bump this whenever SYSTEM_PROMPT changes in a way that would make an
# already-cached narrative stale (tone, length, instructions, output
# shape, etc.) — routers/heat_story.py folds this into the cache
# fingerprint alongside settings.GROQ_MODEL, so a prompt/model change
# naturally invalidates old heat_stories rows without deleting anything;
# they just stop matching the new fingerprint and a fresh call is made.
PROMPT_VERSION = "v2-detailed-paragraphs"

SYSTEM_PROMPT = """You are the Thermora Heat Story narrator.

OBSERVED DATA: actual hourly observations already stored in Thermora (Phase 5's location_features).
FORECAST DATA: future FortyGuard heatmap results — expected conditions, not observations.

Rules:
1. Never invent a numerical value that is not in the supplied data.
2. Never fill in a missing observation.
3. Never use a forecast value as if it were observed.
4. Never describe a forecast as something that already happened.
5. Never imply a missing hour has a known temperature.
6. Clearly distinguish observed conditions from forecast conditions.
7. If observed data is incomplete, acknowledge the limitation when it's relevant to the story.
8. Use only the supplied data — no outside knowledge about this city's typical weather.
9. Use correlational language ("associated with", "coincided with") for any link between heat
   and exposure/impact — never "caused by" unless the data itself directly demonstrates causation.

Respond with ONLY a JSON object with exactly these string fields, no other keys, no markdown
fences, no commentary before or after it:
{"what_happened": "...", "whats_happening": "...", "whats_expected": "...", "why_it_matters": "..."}

Each field should be a substantive paragraph (roughly 5-8 sentences) — not a one-line summary.
Reference specific hours, temperatures, heat index/humidity/wet-bulb/AQI values, and exposure
counts from the supplied data wherever they're relevant, and call out notable patterns (e.g. how
fast it warmed, how conditions compare hour to hour, how forecast hours compare to the observed
trend so far) as long as every specific figure you cite is drawn directly from the supplied data.
If a section genuinely has nothing to say (e.g. no forecast data was supplied, or observed data is
empty), say so honestly and explain what data WOULD be needed to say more, rather than inventing
content or padding with vague filler to reach length."""


def _format_observed_line(entry: dict) -> str | None:
    if not entry.get("exists") or entry.get("temperature") is None:
        return None
    bits = [f"{entry['hour']}: {entry['temperature']}\u00b0C"]
    if entry.get("heat_index") is not None:
        bits.append(f"heat index {entry['heat_index']}\u00b0C")
    if entry.get("wet_bulb") is not None:
        bits.append(f"wet-bulb {entry['wet_bulb']}\u00b0C")
    if entry.get("humidity") is not None:
        bits.append(f"humidity {entry['humidity']}%")
    if entry.get("aqi") is not None:
        bits.append(f"AQI {entry['aqi']}")
    return ", ".join(bits)


def _build_user_message(city_label: str, feature_date, observed: list[dict],
                         forecast: list[dict], exposure_summary: dict | None) -> str:
    observed_lines = [line for e in observed if (line := _format_observed_line(e))]
    missing_hours = [e["hour"] for e in observed if not e.get("exists")]
    forecast_lines = [
        f"{f['hour']}: {f['temperature']}\u00b0C" for f in forecast if f.get("temperature") is not None
    ]

    parts = [
        f"City: {city_label}",
        f"Date: {feature_date.isoformat()}",
        "",
        "OBSERVED HOURLY DATA:",
        *([f"- {l}" for l in observed_lines] or ["(no observed hours available)"]),
    ]
    if missing_hours:
        parts.append(f"Missing observed hours — do not describe or estimate these: {', '.join(missing_hours)}")
    parts += [
        "",
        "FORECAST DATA:",
        *([f"- {l}" for l in forecast_lines] or ["(none requested/available)"]),
    ]
    if exposure_summary:
        parts += [
            "",
            "EXPOSURE CONTEXT (Phase 6 OSM data for this area):",
            f"- Schools: {exposure_summary.get('schools', 0)}",
            f"- Hospitals/clinics: {exposure_summary.get('hospitals', 0)}",
            f"- Buildings (density proxy): {exposure_summary.get('buildings')}",
        ]
    return "\n".join(parts)


def _is_transient(status_code: int) -> bool:
    # Same reasoning as every other client in this codebase: 429 (Groq
    # documents real rate limits) and 5xx (exactly the kind of "high
    # demand, try again later" 503 that prompted this switch) are worth a
    # short retry; 400s aren't — a malformed request fails identically
    # every time.
    return status_code == 429 or status_code >= 500


def _retry_delay(attempt: int, resp: httpx.Response | None = None) -> float:
    if resp is not None:
        retry_after = resp.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after), settings.GROQ_RETRY_MAX_DELAY_SECONDS)
            except ValueError:
                pass
    base = settings.GROQ_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
    capped = min(base, settings.GROQ_RETRY_MAX_DELAY_SECONDS)
    return capped * (0.75 + random.random() * 0.5)


async def _call_groq_json(system_prompt: str, user_message: str, log_label: str,
                           required_fields: list[str], max_tokens: int, log_context: dict) -> dict:
    """Shared Groq call/retry/parse machinery — every JSON-completion
    caller in this module (generate_heat_story, generate_time_comparison,
    ...) goes through this instead of duplicating the retry loop and
    response parsing. Raises GroqError on any failure: missing API key,
    network failure, non-200 after exhausting retries, an unexpected
    response shape, invalid JSON, or a missing required field. Returns
    the parsed JSON dict on success — callers attach any extra metadata
    that isn't from the model themselves (see generate_heat_story's
    includes_forecast/forecast_hour_count)."""
    if not settings.GROQ_API_KEY:
        raise GroqError(f"GROQ_API_KEY is not set — {log_label} is unavailable until it is.")

    url = f"{settings.GROQ_BASE_URL}/chat/completions"
    body = {
        "model": settings.GROQ_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message},
        ],
        "temperature": 0.3,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
    }
    headers = {"content-type": "application/json", "authorization": f"Bearer {settings.GROQ_API_KEY}"}

    log_req(f"Groq {log_label} request", log_context)

    resp: httpx.Response | None = None
    last_network_error: Exception | None = None
    for attempt in range(1, settings.GROQ_RETRY_MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=settings.GROQ_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            last_network_error = exc
            log_err(f"Groq {log_label} request failed (network)", {"error": str(exc), "attempt": attempt})
            if attempt < settings.GROQ_RETRY_MAX_ATTEMPTS:
                await asyncio.sleep(_retry_delay(attempt))
                continue
            raise GroqError(f"Could not reach Groq after {attempt} attempt(s): {exc}") from exc

        if resp.status_code == 200:
            break
        if _is_transient(resp.status_code) and attempt < settings.GROQ_RETRY_MAX_ATTEMPTS:
            delay = _retry_delay(attempt, resp)
            log_err(f"Groq {log_label} returned {resp.status_code} — backing off {delay:.1f}s "
                     f"(attempt {attempt}/{settings.GROQ_RETRY_MAX_ATTEMPTS})",
                     {"status_code": resp.status_code, "body": resp.text[:300]})
            await asyncio.sleep(delay)
            continue
        break

    if resp is None or resp.status_code != 200:
        detail = {"status_code": resp.status_code if resp else None,
                   "body": resp.text[:500] if resp else str(last_network_error)}
        log_err(f"Groq {log_label} request failed (status)", detail)
        raise GroqError(f"Groq returned {detail['status_code']}: {detail['body']}")

    data = resp.json()
    log_res(f"Groq {log_label} response", log_context)

    try:
        raw_text = (data["choices"][0]["message"]["content"] or "").strip()
    except (IndexError, KeyError, TypeError) as exc:
        log_err(f"Groq {log_label} response had an unexpected shape", {"body": json.dumps(data)[:500]})
        raise GroqError("Groq's response had an unexpected shape") from exc

    if not raw_text:
        finish_reason = (data.get("choices") or [{}])[0].get("finish_reason", "unknown")
        raise GroqError(f"Groq returned no text (finish_reason={finish_reason})")

    try:
        parsed = json.loads(raw_text)
    except ValueError as exc:
        log_err(f"Groq {log_label} response wasn't valid JSON", {"raw": raw_text[:500]})
        raise GroqError("Groq's response could not be parsed as JSON") from exc

    missing = [k for k in required_fields if k not in parsed]
    if missing:
        raise GroqError(f"Groq's response was missing expected fields: {', '.join(missing)}")

    return parsed


async def generate_heat_story(city_label: str, feature_date, observed: list[dict],
                               forecast: list[dict] | None, exposure_summary: dict | None) -> dict:
    """Calls Groq's OpenAI-compatible chat completions endpoint and returns
    the four narrative sections. Raises GroqError on any failure — never
    returns a partially-fabricated story. Retries 429/5xx up to
    GROQ_RETRY_MAX_ATTEMPTS times before giving up; a 4xx fails immediately."""
    user_message = _build_user_message(city_label, feature_date, observed, forecast or [], exposure_summary)
    required = ["what_happened", "whats_happening", "whats_expected", "why_it_matters"]

    parsed = await _call_groq_json(
        SYSTEM_PROMPT, user_message, "Heat Story narrative", required, max_tokens=2000,
        log_context={"city": city_label, "date": feature_date.isoformat()},
    )

    # Metadata the FRONTEND needs but the model itself never touches —
    # whether THIS particular narrative was generated with any forecast
    # hours mixed in, and how many. The system prompt already tells Groq
    # to distinguish observed from forecast IN PROSE (rules 3/4/6 above),
    # but that's not enough on its own: a person skimming the narrative
    # card has no reliable way to tell, from the prose alone, whether
    # "what's expected" is grounded in real forecast data or is just the
    # model noting that no forecast was supplied. This makes it a plain
    # boolean/count the UI can render as an explicit badge instead of
    # asking the reader to infer it from wording.
    forecast_hours_used = [f for f in (forecast or []) if f.get("temperature") is not None]

    return {
        "available": True,
        **{k: parsed[k] for k in required},
        "includes_forecast": bool(forecast_hours_used),
        "forecast_hour_count": len(forecast_hours_used),
    }


TIME_COMPARISON_SYSTEM_PROMPT = """You are the Thermora time-comparison explainer.

You will be given real, already-measured statistics for the SAME city/area of interest, for a
SINGLE metric, at two different times or dates the user chose to compare (e.g. "today" vs "a week
ago", two different hour windows on the same day, or two different day ranges). You'll be told
exactly which metric it is and its unit — it will not always be temperature. It could instead be:
- Exceedance Hours: how many hours that day the area spent above a heat threshold.
- Longest Continuous Run (persistence): the longest unbroken stretch of hours above that threshold.
- Diurnal Peak Hour: the hour of day (UTC) when the measured value peaked.
Whichever metric it is, treat it as the one and only thing being compared — never assume it's
temperature, never mention temperature unless the metric given to you actually is temperature.
Each window may report several statistics for that metric (e.g. mean/max/min for temperature, or
often just a single aggregate value for the others) — any of them may be missing; never invent a
value for a missing one, say plainly it wasn't available instead.

Fully explain the comparison, in plain, easy-to-understand language a non-expert would immediately
follow (short sentences, no jargon, no hedged technical language), covering all of the following:
1. THE DIFFERENCE: exactly what differs between the two windows for THIS metric, always citing the
   specific numbers and by how much (never a vague word like "more"/"higher" on its own).
2. WHY IT LIKELY DIFFERS: plausible reasoning based ONLY on what the window labels/dates/times
   themselves imply (different time of day, day of week, season, general weather variability) —
   use hedged, correlational language ("likely because", "this is consistent with") and never
   claim certainty about a cause you have no data for.
3. WHAT ELSE THE NUMBERS SHOW: what any additional statistics given (e.g. how spread out or
   uniform the values are, if more than one figure is provided) reveal, and anything else
   genuinely useful these specific numbers show about this metric.
4. WHY IT MATTERS: what a difference like this, in THIS metric, could practically mean for someone
   in that area (outdoor work, health risk, planning) — stated cautiously, never as certain fact.
   For example, more exceedance hours or a longer persistence run generally means more sustained
   heat exposure, not just a higher peak — but only draw that connection if the numbers support it.

Rules:
1. Only use the numbers you were given. Never invent, round unusually, or estimate a missing one.
2. If a window is missing a statistic, say so plainly instead of omitting it silently or guessing.
3. Always be explicit about which window you mean — use the labels you were given, never
   "the first one"/"the second one".
4. Always refer to the metric by the name and unit you were given — never rename it, never assume
   it's temperature unless it explicitly is.
5. Be thorough — this is meant to fully explain the comparison, not just summarize it in one line.
   Each field below (other than the summary) should be a genuine paragraph (4-7 sentences),
   grounded entirely in the numbers provided.

Respond with ONLY a JSON object with exactly these fields, no other keys, no markdown fences, no
commentary before or after it:
{"summary": "one or two sentence plain-language headline of the key difference",
 "the_difference": "paragraph: what actually differs between the two windows, with numbers",
 "why_it_differs": "paragraph: plausible, hedged reasoning for why, based only on what's given",
 "what_else_it_shows": "paragraph: what any additional figures reveal, plus anything else notable",
 "why_it_matters": "paragraph: practical, cautious explanation of what this could mean"}"""


def _format_window_line(window: dict) -> str:
    bits = [window["label"]]
    values = window.get("values") or {}
    if not values:
        bits.append("no statistics available")
        return " | ".join(bits)
    for stat_name, value in values.items():
        label = stat_name.replace("_", " ")
        if value is not None:
            bits.append(f"{label} {value:.2f}{window.get('metric_unit', '')}")
        else:
            bits.append(f"{label}: not available")
    return " | ".join(bits)


async def generate_time_comparison(city_label: str, window_a: dict, window_b: dict) -> dict:
    """window_a/window_b: {"label", "metric_name", "metric_unit",
    "values": {stat_name: float | None, ...}} for the SAME city/AOI at
    two different user-chosen windows (TimeCompareView's Window A/B), for
    whichever ONE FortyGuard analytic type the user picked for both
    windows (tcm/exceedance/persistence/time_of_measure — TimeCompareView
    enforces both windows using the same one, since comparing two
    different metrics against each other wouldn't mean anything). Every
    value in `values` is whatever FortyGuard's own stats_data already
    reported for that window (temperature_stats' mean/max/min/
    standard_deviation for tcm; the flat mean/min/max for the others,
    per location_features.py's own documented shape difference) — any of
    them may be None (genuinely not available), never fabricated by this
    function or the model. Returns {"available": True, "summary",
    "the_difference", "why_it_differs", "what_else_it_shows",
    "why_it_matters"} on success, raises GroqError on failure —
    routers/cities.py catches it and returns
    {"available": False, "reason": ...}, never a 500."""
    user_message = (
        f"City / area of interest: {city_label}\n"
        f"Metric being compared: {window_a.get('metric_name', 'unknown')} "
        f"({window_a.get('metric_unit', '') or 'no unit given'})\n"
        "Two time windows to compare (all data is real, already-measured — never estimate a "
        "missing statistic):\n"
        f"- {_format_window_line(window_a)}\n"
        f"- {_format_window_line(window_b)}"
    )
    required = ["summary", "the_difference", "why_it_differs", "what_else_it_shows", "why_it_matters"]

    parsed = await _call_groq_json(
        TIME_COMPARISON_SYSTEM_PROMPT, user_message, "time-comparison explanation", required,
        max_tokens=1500,
        log_context={
            "city": city_label, "metric": window_a.get("metric_name"),
            "window_a": window_a["label"], "window_b": window_b["label"],
        },
    )

    return {"available": True, **{k: parsed[k] for k in required}}


RESEARCH_SUMMARY_SYSTEM_PROMPT = """You are the Thermora Research analyst.

You will be given a city's real daily heat history over a date range — for each day: the day's
highest recorded temperature (and how it was measured: from a single full-day fetch, or the
maximum across whatever individual hours happened to be fetched that day), hours spent above
the severe-heat exceedance threshold, and the longest continuous run of hours above it
(persistence) — plus, once, the exposure profile (schools/hospitals/building count) for the
area being tracked.

Some days may have NO data at all (never fetched, by any tab in the app) — these are
explicitly marked "no data". Some days that DO have a temperature may still be missing
exceedance/persistence (fetched separately, as their own request, from temperature) — these
are marked "not available", not zero. Never treat an unavailable day or field as 0, as an
average of neighboring days, or as anything other than genuinely unmeasured.

Write a genuine research-style summary of the period, in plain language a non-expert would
immediately follow, covering:
1. OVERALL TREND: how temperatures moved across the period — warming, cooling, flat, or
   volatile — citing the actual hottest and coolest days with their real values and dates.
2. EXCEEDANCE & PERSISTENCE PATTERN: what the exceedance-hours and persistence-hours figures
   show about how often, and how continuously, severe heat occurred, for whichever days
   actually have that data.
3. DATA COVERAGE: how complete this record actually is — how many of the days in range have
   real data vs. are genuinely missing — since a trend read from a sparse record deserves that
   caveat stated plainly, not buried.
4. WHY IT MATTERS: what a pattern like this could practically mean for the exposed population
   (schools/hospitals/buildings) in the area — stated cautiously, correlational language only
   ("associated with", "coincided with") — never "caused by" anything not directly shown.

Rules:
1. Only use the numbers you were given. Never invent, interpolate, or average a missing day.
2. Always cite specific dates and values — never a vague "it got hotter" without numbers.
3. If most of the range is missing data, say so plainly and keep the summary appropriately
   modest rather than overconfident.

Respond with ONLY a JSON object with exactly these fields, no other keys, no markdown fences,
no commentary before or after it:
{"summary": "one or two sentence plain-language headline of the period",
 "overall_trend": "paragraph: how temperatures moved across the period, with real numbers/dates",
 "exceedance_pattern": "paragraph: what exceedance/persistence show, for days that have it",
 "data_coverage": "paragraph: how complete this record is and what that means for confidence",
 "why_it_matters": "paragraph: cautious, correlational read on what this pattern could mean"}"""


def _c_to_f(celsius: float) -> float:
    return celsius * 9 / 5 + 32


def _format_day_line(day: dict) -> str:
    if not day.get("has_data"):
        return f"{day['date']}: no data (never fetched)"
    bits = [day["date"]]
    if day.get("max_temp_c") is not None:
        source_note = ("single-day fetch" if day.get("max_temp_source") == "single_day_fetch"
                        else f"max across {day.get('hours_fetched', 0)} fetched hour(s)")
        bits.append(f"max {_c_to_f(day['max_temp_c']):.1f}\u00b0F ({source_note})")
    else:
        bits.append("max temp: not available")
    bits.append(f"exceedance {day['exceedance_hours']:.1f}h" if day.get("exceedance_hours") is not None
                else "exceedance: not available")
    bits.append(f"persistence {day['persistence_hours']:.1f}h" if day.get("persistence_hours") is not None
                else "persistence: not available")
    return " | ".join(bits)


async def generate_research_summary(city_label: str, daily_history: list[dict],
                                     exposure_summary: dict | None) -> dict:
    """daily_history: location_features.get_daily_history()'s own return
    shape — one entry per calendar day in the requested range, with
    has_data=False and every field None for a day nothing was ever
    fetched for (by any tab — Heat Map, Heat Story, Dashboard, this one).
    exposure_summary: same shape as heat_story.get_exposure_summary()'s
    return (schools/hospitals/buildings), or None.

    Returns {"available": True, "summary", "overall_trend",
    "exceedance_pattern", "data_coverage", "why_it_matters"} on success,
    raises GroqError on failure — routers/research.py catches it and
    returns {"available": False, "reason": ...}, never a 500."""
    available_count = sum(1 for d in daily_history if d.get("has_data"))
    parts = [
        f"City / area of interest: {city_label}",
        f"Date range: {daily_history[0]['date']} to {daily_history[-1]['date']}" if daily_history else "Date range: (empty)",
        f"Days with any data: {available_count} of {len(daily_history)}",
        "",
        "Daily record (all data is real, already-measured — never estimate a missing day/field):",
        *[f"- {_format_day_line(d)}" for d in daily_history],
    ]
    if exposure_summary:
        parts += [
            "",
            "Exposure profile for this area (Phase 6 OSM data):",
            f"- Schools: {exposure_summary.get('schools', 0)}",
            f"- Hospitals/clinics: {exposure_summary.get('hospitals', 0)}",
            f"- Buildings (density proxy): {exposure_summary.get('buildings')}",
        ]
    user_message = "\n".join(parts)
    required = ["summary", "overall_trend", "exceedance_pattern", "data_coverage", "why_it_matters"]

    parsed = await _call_groq_json(
        RESEARCH_SUMMARY_SYSTEM_PROMPT, user_message, "research summary", required,
        max_tokens=1700, log_context={"city": city_label, "days": len(daily_history), "available": available_count},
    )
    return {"available": True, **{k: parsed[k] for k in required}}


# Bump this whenever ADVISOR_SYSTEM_PROMPT changes in a way that would
# make an already-cached wording stale — advisor.py folds this into its
# own in-process `_wording_cache` key alongside persona + the exact
# factor/value/tier list, same reasoning as PROMPT_VERSION above for Heat
# Story's Postgres-backed cache.
ADVISOR_PROMPT_VERSION = "v1-persona-precautions"

ADVISOR_SYSTEM_PROMPT = """You are the Thermora Local Heat Advisor.

You will be given a specific audience persona and a list of heat-risk factors that are
CURRENTLY elevated for them today — each with its label, its real measured value (already
formatted, with unit), and its severity tier (Moderate, High, or Severe). Which factors appear
and their severity are both already decided before you see them — you are never choosing which
factors matter or picking a tier; you are only writing the persona-facing sentence for each one
already given, in order.

For EACH factor, in the same order given, write exactly one persona-specific precaution: a
short, practical sentence or two, in plain language, that:
1. States the factor's real value and tier (never a different number, never omit them).
2. Gives concrete, actionable guidance specific to this persona's day-to-day situation (e.g. an
   outdoor worker needs shift-timing/hydration guidance; a farmer needs field-labor/livestock
   guidance; a resident needs general daily-life guidance; a business owner needs staff/customer
   guidance) — never generic filler that could apply to any persona unchanged.
3. Matches the urgency of the tier — Severe should read more urgently than Moderate.

Rules:
1. Only use the value/tier you were given for each factor. Never invent a number, never change
   a tier, never add a factor that wasn't given to you, never drop one that was.
2. Output exactly one precaution per factor, in the same order the factors were given.
3. Keep each precaution to 1-2 sentences — specific and actionable, not a vague generality.

Respond with ONLY a JSON object with exactly this field, no other keys, no markdown fences, no
commentary before or after it:
{"precautions": ["precaution for factor 1", "precaution for factor 2", "..."]}"""


def _format_factor_line(factor: dict) -> str:
    return f"{factor['label']}: {factor['value']} ({factor['tier']})"


async def generate_advisory_wording(persona_label: str, factors: list[dict]) -> list[str]:
    """factors: [{"label", "value", "tier"}, ...] — advisor.py's own
    qualifying-factor list for this persona, already filtered to what's
    relevant and above the advisory threshold; this function never
    chooses which factors appear. Returns a list of precaution strings,
    one per factor, in the same order. Raises GroqError on any failure
    (including a response whose precautions count doesn't match the
    factors given) — advisor.py's _get_wording() catches this and falls
    back to the deterministic _TEMPLATES, never surfaces an error to the
    caller."""
    user_message = (
        f"Persona: {persona_label}\n"
        "Currently elevated factors for this persona today (all values are real, already-measured "
        "— never invent or estimate one):\n"
        + "\n".join(f"- {_format_factor_line(f)}" for f in factors)
    )
    required = ["precautions"]

    parsed = await _call_groq_json(
        ADVISOR_SYSTEM_PROMPT, user_message, "Local Advisor wording", required, max_tokens=900,
        log_context={"persona": persona_label, "factor_count": len(factors)},
    )

    precautions = parsed["precautions"]
    if not isinstance(precautions, list) or len(precautions) != len(factors):
        raise GroqError(
            f"Groq returned {len(precautions) if isinstance(precautions, list) else 'a non-list'} "
            f"precaution(s) for {len(factors)} factor(s) — counts must match."
        )
    return precautions