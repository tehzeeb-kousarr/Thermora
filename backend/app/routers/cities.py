from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import live_cache
from .. import scheduler
from .. import groq_client
from ..config import settings
from ..locations import MONITORED_CITIES, get_city
from ..logger import log_err

router = APIRouter(prefix="/api/cities", tags=["cities"])


@router.get("")
async def list_cities():
    return {"cities": MONITORED_CITIES}


def _is_stale(updated_at_iso: str) -> bool:
    updated_at = datetime.fromisoformat(updated_at_iso)
    age_minutes = (datetime.now(timezone.utc) - updated_at).total_seconds() / 60
    return age_minutes >= settings.CITY_SUMMARY_TTL_MINUTES


@router.get("/{city_id}/latest")
async def get_latest(city_id: str):
    """Loads ONLY the requested city, lazily, on-demand — not a passive
    read of a background job's output. First visit to a city triggers a
    real live fetch (heatmap + env params + alerts); repeat visits within
    CITY_SUMMARY_TTL_MINUTES reuse that in-memory result. A city nobody
    has ever selected is never fetched at all."""
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    entry = live_cache.get_latest(city_id)
    if entry is not None and not _is_stale(entry["updatedAt"]):
        return entry

    try:
        await scheduler.refresh_city_summary(city)
    except Exception as exc:  # noqa: BLE001
        log_err(f"On-demand summary load failed for {city_id}", {"error": str(exc)})
        # If we have ANY previous result (even stale), prefer serving that
        # over a hard failure — a temporary FortyGuard/NWS hiccup shouldn't
        # blank out data that was fine a few minutes ago.
        stale_entry = live_cache.get_latest(city_id)
        if stale_entry is not None:
            return {**stale_entry, "stale": True}
        raise HTTPException(status_code=502, detail=f"Could not load data for {city['name']}: {exc}") from exc

    entry = live_cache.get_latest(city_id)
    if entry is None:
        raise HTTPException(status_code=502, detail=f"Could not load data for {city['name']}")
    return entry


class TimeComparisonWindow(BaseModel):
    label: str
    # What's actually being compared — TimeCompareView enforces the SAME
    # metric on both windows (comparing e.g. temperature against
    # exceedance hours wouldn't mean anything), so both windows in one
    # request always share metric_name/metric_unit; only `values` differs.
    metric_name: str = "Temperature"
    metric_unit: str = "\u00b0F"
    # Whatever statistics FortyGuard actually reported for this window's
    # metric — {"mean": ..., "max": ..., "min": ..., "std_dev": ...} for
    # tcm (temperature), or just {"value": ...} for exceedance/
    # persistence/time_of_measure (see location_features.py's own
    # documented flat-vs-nested stats_data shape difference). Any value
    # may be None (genuinely not available) — never fabricated by the
    # frontend or filled in here.
    values: dict[str, float | None] = {}


class TimeComparisonRequest(BaseModel):
    window_a: TimeComparisonWindow
    window_b: TimeComparisonWindow


@router.post("/{city_id}/time-comparison")
async def get_time_comparison(city_id: str, req: TimeComparisonRequest):
    """TimeCompareView — called once BOTH Window A and Window B have a
    completed FortyGuard fetch (see that component: the frontend only
    calls this after both requestedA/requestedB heatmaps have resolved,
    same off-by-default gating as everything else there). This endpoint
    itself makes no FortyGuard call — only Groq, fed exactly the
    statistics the frontend already pulled from those two fetches for
    whichever ONE analytic type (tcm/exceedance/persistence/
    time_of_measure) the user picked for both windows, nothing
    re-derived or estimated here.

    Never fails the whole request on a Groq error — same contract as
    routers/heat_story.py's narrate endpoint: an honest "unavailable" is
    a normal, displayable outcome, not a 500. No caching table for this
    one (unlike heat_stories) — Window A/B are two arbitrary,
    user-chosen date/time/filter-type combinations, not a per-city/date
    slot that different visitors are likely to land on again."""
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    try:
        story = await groq_client.generate_time_comparison(
            city_label=f"{city['name']}, {city['state']}",
            window_a=req.window_a.model_dump(),
            window_b=req.window_b.model_dump(),
        )
    except groq_client.GroqError as exc:
        log_err("Time comparison explanation failed", {"city": city_id, "error": str(exc)})
        story = {"available": False, "reason": str(exc)}
    except Exception as exc:  # noqa: BLE001 - see routers/heat_story.py's narrate for why
        # this is caught too, not just GroqError: a narrative failure must
        # degrade to "explanation unavailable", never a generic 500.
        log_err("Time comparison explanation failed (unexpected error)", {"city": city_id, "error": str(exc)})
        story = {"available": False, "reason": f"Unexpected error generating explanation: {exc}"}

    return {"story": story}