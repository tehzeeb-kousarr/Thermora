from datetime import date as date_cls, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import groq_client
from .. import heat_story
from .. import location_features
from .. import repository as repo
from ..locations import get_city
from ..logger import log_err

router = APIRouter(prefix="/api/research", tags=["research"])

# A date-range request is Postgres-only (see get_history below) so there's
# no FortyGuard-cost reason to cap it tightly, but an unbounded range
# still means an unbounded prompt to Groq for the summary endpoint — this
# keeps both endpoints looking at the same, sane window. 92 days = ~3
# months, comfortably covers the "last 7/14/30 days" + "this summer"
# ranges the frontend's range picker actually offers.
MAX_RANGE_DAYS = 92

# A "Fetch missing data" click is an explicit, bounded batch — same spirit
# as heat_story.py's MAX_HOURS_PER_REQUEST ("don't blindly fire a huge
# parallel burst"), just scaled up a bit since a Research range spans many
# days rather than one. If a range has more missing hours than this, the
# response's `remaining_missing` tells the frontend so it can show
# "N more — fetch again to continue" and the person clicks again for the
# next batch, rather than one click silently queuing an unbounded number
# of FortyGuard requests.
MAX_FILL_JOBS_PER_REQUEST = 20


def _require_city(city_id: str) -> dict:
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")
    return city


def _parse_range(city: dict, start_date: str | None, end_date: str | None) -> tuple[date_cls, date_cls]:
    """Defaults to the last 7 days ending on the CITY's own local calendar
    day (same reasoning as routers/heat_story.py's _parse_date — every
    monitored city is hours behind UTC/the server)."""
    try:
        end = date_cls.fromisoformat(end_date) if end_date else heat_story.local_today(city)
        start = date_cls.fromisoformat(start_date) if start_date else end - timedelta(days=6)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="start_date/end_date must be YYYY-MM-DD") from exc

    if start > end:
        raise HTTPException(status_code=400, detail="start_date must not be after end_date")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise HTTPException(status_code=400, detail=f"Range too large — max {MAX_RANGE_DAYS} days")
    return start, end


def _with_coverage(city: dict, day: dict) -> dict:
    """Folds in Heat Story's own expected_hours() (the 6am-8pm local
    daytime window every OTHER tab already judges "a complete day"
    against — see heat_story.py's START_HOUR/END_HOUR) so every day in a
    Research range is measured against that SAME yardstick, instead of
    just whatever number of hours happened to get fetched for it. A
    future date (past the city's local today) is skipped — expected_hours
    doesn't cap by current hour for anything but today, so treating a
    future date as "missing" hours that haven't happened yet would be
    nonsensical."""
    feature_date = date_cls.fromisoformat(day["date"])
    if feature_date > heat_story.local_today(city):
        expected: list[str] = []
    else:
        expected = heat_story.expected_hours(city, feature_date)
    fetched = set(day.get("fetched_hours") or [])
    missing = [h for h in expected if h not in fetched]
    coverage_percent = round((len(expected) - len(missing)) / len(expected) * 100, 1) if expected else None
    return {
        **day,
        "expected_hours": len(expected),
        "missing_hours": missing,
        "coverage_percent": coverage_percent,
    }


@router.get("/{city_id}/history")
async def get_history(city_id: str, start_date: str | None = None, end_date: str | None = None):
    """Research tab's main read. Postgres-only, same as GET
    /api/heat-story/{city_id} — never submits anything to FortyGuard just
    by being opened. Every day in range comes back honestly: a day
    nothing was ever fetched for (by ANY tab — Heat Map, Heat Story,
    Dashboard, this one) has has_data=False and every field null, never a
    fabricated or interpolated value. See
    location_features.get_daily_history's own docstring for exactly how
    each field is sourced.

    Each day also carries `expected_hours`/`missing_hours`/
    `coverage_percent` (see _with_coverage above) — the SAME 6am-8pm
    local-daytime yardstick Heat Story already uses, so every day in the
    range is comparable on equal footing instead of one day's number
    coming from a single stray hourly fetch and another's from a full
    day's worth. `total_missing_hours` is the sum across the whole range —
    what POST .../fill-gaps would need to fully backfill it.

    Reuses heat_story.get_exposure_summary (Phase 6's unified AOI) rather
    than querying exposure again — same cached data Heat Story's own
    "why it matters" section already reads, not a second exposure call."""
    city = _require_city(city_id)
    start, end = _parse_range(city, start_date, end_date)

    daily = await location_features.get_daily_history(city_id, start, end)
    daily = [_with_coverage(city, d) for d in daily]
    exposure_summary = await heat_story.get_exposure_summary(city)

    available_days = sum(1 for d in daily if d["has_data"])
    total_missing_hours = sum(len(d["missing_hours"]) for d in daily)
    return {
        "city_id": city_id,
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": daily,
        "coverage": {"available_days": available_days, "total_days": len(daily)},
        "total_missing_hours": total_missing_hours,
        "exposure_summary": exposure_summary,
    }


class SummaryRequest(BaseModel):
    start_date: str | None = None
    end_date: str | None = None


@router.post("/{city_id}/summary")
async def post_summary(city_id: str, req: SummaryRequest):
    """Groq research summary over the same range GET .../history already
    read — this endpoint re-reads it fresh (cheap, Postgres-only) rather
    than trusting whatever the frontend last rendered, so the summary can
    never describe a stale or client-tampered version of the record.

    No caching table (unlike Heat Story's heat_stories) — deliberate:
    unlike a per-city/date narrative many visitors independently land on,
    a research range is whatever the person just picked in the range
    picker, and the underlying daily rows can gain new days between two
    calls (someone fetches a missing day elsewhere in the app) in a way
    that would make a fingerprint-keyed cache serve a stale read exactly
    when it matters most. Never fails the whole request on a Groq error —
    same contract as heat_story.py's narrate / cities.py's
    get_time_comparison: an honest "unavailable" is a normal, displayable
    outcome, not a 500."""
    city = _require_city(city_id)
    start, end = _parse_range(city, req.start_date, req.end_date)

    daily = await location_features.get_daily_history(city_id, start, end)
    exposure_summary = await heat_story.get_exposure_summary(city)

    try:
        summary = await groq_client.generate_research_summary(
            city_label=f"{city['name']}, {city['state']}",
            daily_history=daily,
            exposure_summary=exposure_summary,
        )
    except groq_client.GroqError as exc:
        log_err("Research summary failed", {"city": city_id, "error": str(exc)})
        summary = {"available": False, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 - see routers/heat_story.py's narrate for why this
        # is caught too, not just GroqError: a summary failure must
        # degrade to "unavailable", never a generic 500.
        log_err("Research summary failed (unexpected error)", {"city": city_id, "error": str(exc)})
        summary = {"available": False, "reason": f"Unexpected error generating summary: {exc}"}

    return {"summary": summary}


class FillGapsRequest(BaseModel):
    start_date: str | None = None
    end_date: str | None = None


@router.post("/{city_id}/fill-gaps")
async def fill_gaps(city_id: str, req: FillGapsRequest):
    """Explicit, consent-gated backfill for the SAME range GET .../history
    just showed as incomplete — the frontend shows the "this will make N
    FortyGuard requests" modal (same Section 16 pattern as Heat Story's
    fetch-missing) before ever calling this. Never runs on its own just
    from opening or paging through Research.

    Walks the range chronologically and, for each day, submits exactly
    its still-missing hours (per _with_coverage's expected_hours/
    missing_hours — the same 6am-8pm local yardstick every day in the
    range is already judged against), via the identical
    heat_story.tcm_payload_for_hour + repository.start_heatmap(persist=True)
    machinery Heat Story's own fetch-missing uses — this IS a real
    per-hour FortyGuard fetch, just batched across days instead of one.

    Bounded to MAX_FILL_JOBS_PER_REQUEST total (day, hour) pairs — a big
    range can have far more missing hours than that in one go, so
    `remaining_missing` in the response tells the frontend how many are
    left; clicking again continues from wherever this call left off,
    since already-fetched hours are never re-requested."""
    city = _require_city(city_id)
    start, end = _parse_range(city, req.start_date, req.end_date)

    daily = await location_features.get_daily_history(city_id, start, end)
    daily = [_with_coverage(city, d) for d in daily]

    to_fetch: list[tuple[date_cls, str]] = []
    for day in daily:
        feature_date = date_cls.fromisoformat(day["date"])
        for hour in day["missing_hours"]:
            to_fetch.append((feature_date, hour))

    total_missing = len(to_fetch)
    batch = to_fetch[:MAX_FILL_JOBS_PER_REQUEST]

    jobs = []
    # Deliberately sequential, not asyncio.gather — same reasoning as
    # heat_story.py's _submit_hours: start_heatmap() only submits-and-
    # returns, so this loop is fast; it just bounds how many jobs get
    # CREATED at once, not how long any individual one takes to resolve.
    for feature_date, hour in batch:
        payload = heat_story.tcm_payload_for_hour(city, feature_date, hour)
        result = await repo.start_heatmap(payload, force_refresh=False, persist=True)
        jobs.append({"date": feature_date.isoformat(), "hour": hour, **result})

    return {"jobs": jobs, "remaining_missing": total_missing - len(batch), "total_missing_before": total_missing}