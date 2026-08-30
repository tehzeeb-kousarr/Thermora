from datetime import date as date_cls
import hashlib
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import groq_client
from .. import heat_story
from .. import repository as repo
from ..config import settings
from ..db import get_pool
from ..locations import get_city
from ..logger import log_err

router = APIRouter(prefix="/api/heat-story", tags=["heat-story"])

# A "fetch missing hours" or "fetch forecast" click is an explicit, bounded
# batch (Section 18: "don't blindly fire a huge parallel burst") — this
# caps it at a sane size regardless of what the frontend sends, the same
# spirit as queryWindow.js's evenSample() capping Heat Map's timeline
# pre-build.
MAX_HOURS_PER_REQUEST = 8


def _parse_date(city: dict, date: str | None) -> date_cls:
    """Defaults to the CITY's own local calendar day (see
    heat_story.local_today), not the server's/UTC's — every monitored
    city is hours behind UTC, so `date_cls.today()` here could name
    tomorrow relative to what's actually "today" where the city is."""
    if not date:
        return heat_story.local_today(city)
    try:
        return date_cls.fromisoformat(date)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD") from exc


def _require_city(city_id: str) -> dict:
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")
    return city


@router.get("/{city_id}")
async def get_story(city_id: str, date: str | None = None):
    """Opening Heat Story. Postgres-only — never submits anything to
    FortyGuard (Sections 8/14). Returns observed hours + coverage +
    exposure context; the narrative is a separate call (POST .../narrate)
    so a later forecast fetch can ask for an updated story without
    re-deriving the observed side over again."""
    city = _require_city(city_id)
    feature_date = _parse_date(city, date)

    observed = await heat_story.get_observed_hours(city, feature_date)
    coverage = await heat_story.compute_coverage(city, feature_date)
    exposure_summary = await heat_story.get_exposure_summary(city)

    return {
        "city_id": city_id,
        "date": feature_date.isoformat(),
        "observed": observed,
        "coverage": coverage,
        "exposure_summary": exposure_summary,
    }


@router.get("/{city_id}/coverage")
async def get_coverage(city_id: str, date: str | None = None):
    city = _require_city(city_id)
    return await heat_story.compute_coverage(city, _parse_date(city, date))


class ForecastHour(BaseModel):
    hour: str
    temperature: float | None = None


class NarrateRequest(BaseModel):
    date: str
    # The frontend supplies forecast hours it has already fetched
    # (persist=False, via POST .../fetch-forecast + polling
    # /api/heatmap/status) — forecast is never written to
    # location_features (that stays OBSERVED-only), so this is still the
    # only way a forecast value reaches the NARRATIVE specifically, even
    # though a copy of it now also lives in heat_story_forecasts (see
    # POST .../forecast/record) for reference.
    forecast: list[ForecastHour] = Field(default_factory=list)
    # True for the frontend's "Regenerate" action — bypasses the cache
    # lookup below even when the fingerprint is unchanged, and overwrites
    # whatever was cached under it. False (the default) is "Generate
    # Story"'s first-open behavior: serve the cache if this exact
    # city/date/forecast/model/prompt combination was already narrated.
    force: bool = False


def _input_fingerprint(observed: list[dict], forecast: list[dict], exposure_summary: dict | None) -> str:
    """Hashes exactly the content that determines the narrative — not
    just city_id+feature_date, since observed hours grow through the day
    and forecast is supplied fresh per request (see heat_stories'
    CREATE TABLE comment in db.py for why). Built from the same
    observed/forecast/exposure values groq_client.generate_heat_story
    itself reads, so this can never drift out of sync with what actually
    went into the prompt.

    Also folds in GROQ_MODEL and groq_client.PROMPT_VERSION: the
    narrative depends just as much on which model answered and what the
    prompt asked for as it does on the input data. Without this, changing
    the model or editing SYSTEM_PROMPT (e.g. asking for longer sections)
    would silently keep serving old cached narratives generated under the
    previous prompt/model forever, since the input data itself hadn't
    changed — the fingerprint would never know to differ.
    """
    canonical = json.dumps(
        {
            "observed": observed,
            "forecast": forecast,
            "exposure": exposure_summary,
            "model": settings.GROQ_MODEL,
            "prompt_version": groq_client.PROMPT_VERSION,
        },
        sort_keys=True, default=str,
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


@router.post("/{city_id}/narrate")
async def narrate(city_id: str, req: NarrateRequest):
    """Generates the AI narrative. Re-reads observed/exposure fresh from
    Postgres (cheap, no FortyGuard involved) and combines it with whatever
    forecast hours the caller already fetched. Never fails the whole
    request on a Groq error — an honest "story unavailable" is a normal,
    displayable outcome, not a 500.

    Cache-first against heat_stories, keyed on the actual observed +
    forecast + exposure content plus the model/prompt version (see
    _input_fingerprint) rather than force-regenerating on every open — a
    Groq call has real latency and cost, and the underlying facts
    genuinely don't change between two people opening the same
    city/date/forecast combination minutes apart.

    `req.force=True` (the frontend's "Regenerate" button, as opposed to
    the initial "Generate Story") skips that cache lookup entirely and
    always calls Groq, then overwrites whatever was cached under this
    exact fingerprint — the point of an explicit regenerate is a fresh
    take even when nothing about the inputs changed, which a same-key
    cache hit would otherwise always short-circuit.
    """
    city = _require_city(city_id)
    feature_date = _parse_date(city, req.date)

    observed = await heat_story.get_observed_hours(city, feature_date)
    exposure_summary = await heat_story.get_exposure_summary(city)
    forecast = [f.model_dump() for f in req.forecast]
    fingerprint = _input_fingerprint(observed, forecast, exposure_summary)

    pool = get_pool()
    if not req.force:
        cached = await pool.fetchrow(
            """
            SELECT narrative FROM heat_stories
            WHERE city_id = $1 AND feature_date = $2 AND input_fingerprint = $3
            """,
            city_id, feature_date, fingerprint,
        )
        if cached:
            story = json.loads(cached["narrative"])
            return {"story": story, "cached": True}

    try:
        story = await groq_client.generate_heat_story(
            city_label=f"{city['name']}, {city['state']}",
            feature_date=feature_date,
            observed=observed,
            forecast=forecast,
            exposure_summary=exposure_summary,
        )
    except groq_client.GroqError as exc:
        log_err("Heat Story narrative failed", {"city": city_id, "error": str(exc)})
        story = {"available": False, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 - see docstring: a narrative
        # failure must degrade to "story unavailable", never a 500. Only
        # groq_client.GroqError was being caught here, which covers a bad
        # API key, a non-200 response, or a response that failed to parse
        # — but NOT other failure shapes (e.g. a genuinely malformed
        # response body, or something in _build_user_message/city lookup),
        # which were falling through to FastAPI's generic 500 instead of
        # this endpoint's own honest "unavailable" contract.
        log_err("Heat Story narrative failed (unexpected error)", {"city": city_id, "error": str(exc)})
        story = {"available": False, "reason": f"Unexpected error generating narrative: {exc}"}

    # Only a genuine success is cached — a failure (missing key, transient
    # Groq error) must not get "stuck" as the stored answer for this
    # exact input the next time someone opens the same city/date.
    if story.get("available"):
        await pool.execute(
            """
            INSERT INTO heat_stories (city_id, feature_date, input_fingerprint, narrative, model)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (city_id, feature_date, input_fingerprint) DO NOTHING
            """,
            city_id, feature_date, fingerprint, json.dumps(story), settings.GROQ_MODEL,
        )

    return {"story": story, "cached": False}


class FetchHoursRequest(BaseModel):
    date: str
    hours: list[str] = Field(..., description='e.g. ["11:00", "13:00"]', min_length=1)


async def _submit_hours(city_id: str, req: FetchHoursRequest, persist: bool) -> dict:
    city = _require_city(city_id)
    feature_date = _parse_date(city, req.date)
    # De-dupe, then bound the batch — see MAX_HOURS_PER_REQUEST above.
    hours = list(dict.fromkeys(req.hours))[:MAX_HOURS_PER_REQUEST]
    if not hours:
        raise HTTPException(status_code=400, detail="At least one hour is required.")

    # Forecast (persist=False) hours are the ones FortyGuard's own 12-hour
    # horizon actually constrains (see heat_story.FORECAST_HORIZON_HOURS) —
    # "missing observed" (persist=True) requests are for past/current
    # hours and aren't subject to this at all. The frontend already caps
    # its own candidates to this window; this rejects anything that
    # slipped past that (a stale UI, a direct API call) instead of quietly
    # submitting a request FortyGuard can't meaningfully answer.
    if not persist:
        out_of_range = [h for h in hours if not heat_story.is_within_forecast_horizon(city, feature_date, h)]
        if out_of_range:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"These hours are outside FortyGuard's {heat_story.FORECAST_HORIZON_HOURS}-hour "
                    f"forecast horizon for {city['name']} right now: {', '.join(out_of_range)}"
                ),
            )

    jobs = []
    # Deliberately sequential, not asyncio.gather — Section 18 again.
    # start_heatmap() itself only submits-and-returns (see
    # repository.py's own comment on why POST /api/heatmap stopped
    # blocking), so this loop is fast; it only bounds how many jobs get
    # CREATED at once, not how long any individual one takes to resolve.
    for hour in hours:
        payload = heat_story.tcm_payload_for_hour(city, feature_date, hour)
        result = await repo.start_heatmap(payload, force_refresh=False, persist=persist)
        jobs.append({"hour": hour, **result})
    return {"jobs": jobs}


@router.post("/{city_id}/fetch-missing")
async def fetch_missing(city_id: str, req: FetchHoursRequest):
    """Explicit, consent-gated fetch of specific missing OBSERVED hours —
    the frontend shows the "this will make N FortyGuard requests" modal
    (Section 16) before ever calling this. Reuses start_heatmap()/
    get_heatmap_status() exactly as Heat Map does; persist=True (the
    default) means a genuine completion writes into location_features
    like any other tcm fetch. The frontend polls each returned job's
    `signature` via the EXISTING GET /api/heatmap/status endpoint — no
    new job-status endpoint needed for this."""
    return await _submit_hours(city_id, req, persist=True)


@router.post("/{city_id}/fetch-forecast")
async def fetch_forecast(city_id: str, req: FetchHoursRequest):
    """Same machinery and same consent gate as fetch-missing, but
    persist=False — see repository.get_heatmap's docstring. The result is
    still returned to the frontend (via polling GET /api/heatmap/status,
    same as fetch-missing) and is never written to location_features —
    that table stays OBSERVED-only. It's since become loggable in its own
    right, though: see POST .../forecast/record just below, which the
    frontend calls once these jobs actually complete."""
    return await _submit_hours(city_id, req, persist=False)


class RecordForecastRequest(BaseModel):
    date: str
    hours: list[ForecastHour] = Field(..., min_length=1)


@router.post("/{city_id}/forecast/record")
async def record_forecast(city_id: str, req: RecordForecastRequest):
    """Logs a forecast fetch into heat_story_forecasts (see that table's
    DDL comment in db.py) — called by the frontend right after a
    fetch-forecast job it submitted above actually completes, with
    exactly the {hour, temperature} it read off that completed job.
    Never returns an error to the frontend for a logging failure — the
    forecast is already showing on screen by the time this is called;
    failing to log it shouldn't take that away. See
    heat_story.record_forecast_hours' own docstring for why this never
    raises internally either."""
    city = _require_city(city_id)
    feature_date = _parse_date(city, req.date)
    await heat_story.record_forecast_hours(city_id, feature_date, [h.model_dump() for h in req.hours])
    return {"recorded": True}


@router.get("/{city_id}/forecast")
async def get_forecast(city_id: str, date: str | None = None):
    """Read-back counterpart to POST .../forecast/record above — whatever
    was ever logged into heat_story_forecasts for this city/date. Called
    by the frontend on load (and on city/date change) so a forecast the
    user already fetched keeps showing up after navigating away and back
    to Heat Story, instead of only ever living in that component's own
    state and disappearing the moment it unmounts."""
    city = _require_city(city_id)
    feature_date = _parse_date(city, date)
    hours = await heat_story.get_recorded_forecast_hours(city_id, feature_date)
    return {"date": feature_date.isoformat(), "hours": hours}