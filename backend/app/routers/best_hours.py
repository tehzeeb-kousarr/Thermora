"""
Phase 12.5e — "Best hours to travel" timeline.

This is the piece Heat-Safe Routing was missing on top of per-route
scoring (route_heat_scoring.py already labels ONE route, for ONE
departure time, as safe/moderate/risk): here we hold the LOCATION fixed
(the trip's origin, or the city center if no trip is set up yet) and
walk the NEXT ROUTE_FORECAST_HORIZON_HOURS hours instead, so the person
can see — before they even pick a route — which hour of the day is
actually the safe one to leave.

Reuses route_heat_scoring.point_payload (the exact same grid-snapped
tcm-heatmap payload a route's own point sampling already uses) and
repository.get_heatmap(persist=False), so this is never a second,
disagreeing source of truth for "what's the temperature at this point
at this hour" — it's the same lookup, just walked across hours instead
of across a route's geometry.
"""
import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query

from .. import repository
from ..config import settings
from ..locations import get_city
from ..logger import log_err
from ..route_heat_scoring import heat_category, point_payload

router = APIRouter(prefix="/api/cities", tags=["routing"])


def _hour_12_label(hour_dt: datetime) -> str:
    """Cross-platform 12-hour label ("2 PM", "12 AM") without a leading
    zero. strftime's no-leading-zero flag is platform-specific — "%-I"
    on Linux/macOS, "%#I" on Windows — and using either one directly
    crashes with a ValueError on the other OS. Building it by hand from
    hour_dt.hour avoids depending on either platform's strftime quirks."""
    hour_12 = hour_dt.hour % 12 or 12
    period = "AM" if hour_dt.hour < 12 else "PM"
    return f"{hour_12} {period}"


async def _hour_reading(lat: float, lon: float, hour_dt: datetime) -> dict:
    date_str = hour_dt.date().isoformat()
    hour_str = f"{hour_dt.hour:02d}:00"
    payload = point_payload(lat, lon, date_str, hour_str)
    temp_c = None
    try:
        heatmap = await repository.get_heatmap(payload, persist=False)
        temp_c = (heatmap.get("stats_data") or {}).get("temperature_stats", {}).get("mean")
    except Exception as exc:  # noqa: BLE001 - one bad hour must not break the whole timeline
        log_err("Best-hours point lookup failed", {"lat": lat, "lon": lon, "hour": hour_str, "error": str(exc)})

    category, color = heat_category(temp_c)
    return {
        "hour": hour_dt.isoformat(),
        "local_hour_label": _hour_12_label(hour_dt),
        "temperature_c": round(temp_c, 1) if temp_c is not None else None,
        "category": category,
        "color": color,
    }


@router.get("/{city_id}/best-hours")
async def get_best_hours(
    city_id: str,
    lat: float | None = Query(None, description="Point to evaluate; defaults to the city's own center"),
    lon: float | None = Query(None),
):
    """Returns one entry per hour for the next ROUTE_FORECAST_HORIZON_HOURS
    hours (FortyGuard's own forecast horizon — same one route scoring is
    bounded by), each labeled safe/moderate/risk with the SAME 32°C/39°C
    breakpoints route_heat_scoring.heat_category already uses, plus a
    `recommended_hour` pointing at the coolest safe (or least-bad) hour
    in that window so the UI has a single headline answer, not just a
    strip of dots to interpret."""
    city = get_city(city_id)
    if city is None:
        raise HTTPException(status_code=404, detail=f"Unknown city_id '{city_id}'")

    point_lat = lat if lat is not None else city["lat"]
    point_lon = lon if lon is not None else city["lon"]

    try:
        local_now = datetime.now(ZoneInfo(city["timezone"]))
    except Exception:  # noqa: BLE001 - fall back to UTC rather than fail the whole request over tz data
        local_now = datetime.now(timezone.utc)
    start_hour = local_now.replace(minute=0, second=0, microsecond=0)

    hours = [start_hour + timedelta(hours=i) for i in range(settings.ROUTE_FORECAST_HORIZON_HOURS)]
    readings = await asyncio.gather(*(_hour_reading(point_lat, point_lon, h) for h in hours))
    readings = list(readings)

    with_data = [r for r in readings if r["temperature_c"] is not None]
    safe_hours = [r for r in with_data if r["category"] == "safe"]
    # Best available hour: prefer the coolest "safe" hour; if the whole
    # window is moderate/risk, fall back to the single coolest reading
    # instead of claiming a safe hour that doesn't exist in this window.
    pool = safe_hours or with_data
    recommended = min(pool, key=lambda r: r["temperature_c"]) if pool else None

    return {
        "city_id": city_id,
        "lat": point_lat,
        "lon": point_lon,
        "generated_at": local_now.isoformat(),
        "horizon_hours": settings.ROUTE_FORECAST_HORIZON_HOURS,
        "hours": readings,
        "recommended_hour": recommended["hour"] if recommended else None,
    }
