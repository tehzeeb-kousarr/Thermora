"""
Phase 12.5 — Heat-Safe Routing: score a candidate route's heat exposure.

The core idea (matches how Heat Story already treats FortyGuard's
forecast product): a route isn't scored against "the current
temperature" as one flat number. Each sampled point along the route gets
scored against the temperature FOR THE HOUR A TRAVELER WOULD ACTUALLY BE
THERE — a point 40 minutes into a trip is scored with the +1-hour
forecast, a point 3 hours in with the +3-hour forecast, and so on. Any
point whose estimated arrival falls beyond FortyGuard's 12-hour forecast
horizon (settings.ROUTE_FORECAST_HORIZON_HOURS) gets no FortyGuard call
at all — it's reported as "no forecast available", never silently
guessed or backfilled with the current hour's reading.

Every point-level heat reading goes through repository.get_heatmap with
persist=False — the exact same call Heat Story's forecast fetch already
uses (see heat_story.py's module docstring) — so this never becomes a
second, inconsistent source of heat data. persist=False also means a
route's speculative point samples are never written into
location_features, Phase 5's canonical OBSERVED store.
"""
import asyncio
import math
from bisect import bisect_left
from datetime import datetime, timedelta

from . import repository
from .config import settings
from .logger import log_err


def _haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat1, lon1 = a
    lat2, lon2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def _cumulative_distances(geometry: list[tuple[float, float]]) -> list[float]:
    cum = [0.0]
    for i in range(1, len(geometry)):
        cum.append(cum[-1] + _haversine_m(geometry[i - 1], geometry[i]))
    return cum


def _point_at_fraction(geometry: list[tuple[float, float]], cum: list[float], fraction: float) -> tuple[float, float]:
    total = cum[-1] or 1.0
    target = fraction * total
    idx = bisect_left(cum, target)
    idx = max(0, min(idx, len(geometry) - 1))
    return geometry[idx]


def sample_route_points(route: dict) -> list[dict]:
    """Picks sample points evenly spaced by travel TIME (not raw
    distance) along the route's geometry, so a slow/congested segment
    gets sampled proportionally to how long a traveler is actually
    exposed to it rather than how many meters it covers. Point count is
    bounded by both ROUTE_MAX_SAMPLE_POINTS (a hard ceiling on FortyGuard
    calls per route) and ROUTE_MIN_SAMPLE_INTERVAL_MINUTES (no point in
    sampling every 2 minutes on a 15-minute trip). Returns
    [{"lat", "lon", "fraction"}], fraction being 0..1 of total duration."""
    geometry = route["geometry"]
    duration_s = route["duration_s"]
    cum = _cumulative_distances(geometry)

    duration_minutes = duration_s / 60
    n_by_interval = max(2, math.floor(duration_minutes / settings.ROUTE_MIN_SAMPLE_INTERVAL_MINUTES) + 1)
    n = max(2, min(settings.ROUTE_MAX_SAMPLE_POINTS, n_by_interval))

    points = []
    for i in range(n):
        fraction = i / (n - 1) if n > 1 else 0.0
        lat, lon = _point_at_fraction(geometry, cum, fraction)
        points.append({"lat": lat, "lon": lon, "fraction": fraction})
    return points


def _grid_round(value: float, grid: float) -> float:
    return round(value / grid) * grid


def point_payload(lat: float, lon: float, date_str: str, hour_str: str) -> dict:
    """Public wrapper around _point_payload — routers/best_hours.py needs
    the exact same tcm-heatmap payload shape (grid-snapped, same cache
    signature) for a single point/hour lookup that isn't tied to a route
    at all, so this is exposed rather than duplicated."""
    return _point_payload(lat, lon, date_str, hour_str)


def _point_payload(lat: float, lon: float, date_str: str, hour_str: str) -> dict:
    """Same tcm-heatmap payload shape as heat_story.tcm_payload_for_hour,
    but the AOI is a small box centered on one route sample point instead
    of a whole city's box. Coordinates are snapped to
    ROUTE_POINT_GRID_DEG first so that nearby sample points — whether
    from the same route or from a different candidate route entirely —
    collapse onto an identical payload/signature and hit repository's
    existing FortyGuard cache instead of each paying for its own
    near-duplicate fetch."""
    half = settings.ROUTE_POINT_HALF_WIDTH_DEG
    g_lat = _grid_round(lat, settings.ROUTE_POINT_GRID_DEG)
    g_lon = _grid_round(lon, settings.ROUTE_POINT_GRID_DEG)
    min_lat, max_lat = g_lat - half, g_lat + half
    min_lng, max_lng = g_lon - half, g_lon + half
    return {
        "polygon_aoi": {
            "type": "FeatureCollection",
            "features": [{
                "type": "Feature", "properties": {},
                "geometry": {"type": "Polygon", "coordinates": [[
                    [min_lng, min_lat], [max_lng, min_lat],
                    [max_lng, max_lat], [min_lng, max_lat],
                    [min_lng, min_lat],
                ]]},
            }],
        },
        "date_time": {"start_date": date_str, "filter_type": 1, "start_time": hour_str},
        "granularity": settings.SUMMARY_GRANULARITY,
        "analytic_type": "tcm",
        "threshold": 30,
        "direction": "above",
    }


def _within_forecast_horizon(departure_dt: datetime, arrival_dt: datetime) -> bool:
    horizon = timedelta(hours=settings.ROUTE_FORECAST_HORIZON_HOURS)
    return departure_dt <= arrival_dt <= departure_dt + horizon


async def _score_point(point: dict, departure_dt: datetime, duration_s: float) -> dict:
    arrival_dt = departure_dt + timedelta(seconds=point["fraction"] * duration_s)
    within_horizon = _within_forecast_horizon(departure_dt, arrival_dt)

    result = {
        **point,
        "arrival_time": arrival_dt.isoformat(),
        "within_forecast_horizon": within_horizon,
        "temperature_c": None,
    }
    if not within_horizon:
        return result

    date_str = arrival_dt.date().isoformat()
    hour_str = f"{arrival_dt.hour:02d}:00"
    payload = _point_payload(point["lat"], point["lon"], date_str, hour_str)
    try:
        heatmap = await repository.get_heatmap(payload, persist=False)
        temp = (heatmap.get("stats_data") or {}).get("temperature_stats", {}).get("mean")
        result["temperature_c"] = temp
    except Exception as exc:  # noqa: BLE001 - one point's heat lookup failing must not break the whole route
        log_err("Route point heat lookup failed", {"lat": point["lat"], "lon": point["lon"], "error": str(exc)})
    return result


async def score_route(route: dict, departure_dt: datetime) -> dict:
    """Returns `route` merged with per-point heat readings and an overall
    exposure summary. `departure_dt` is treated as "now" for forecast-
    horizon purposes — the trip is assumed to start at that instant, so
    the horizon check is always relative to the traveler's own departure,
    not the server's wall clock, which matters when a departure time in
    the near future was explicitly requested."""
    points = sample_route_points(route)
    scored_points = await asyncio.gather(
        *(_score_point(p, departure_dt, route["duration_s"]) for p in points)
    )
    scored_points = list(scored_points)

    temps = [p["temperature_c"] for p in scored_points if p["temperature_c"] is not None]
    out_of_horizon = sum(1 for p in scored_points if not p["within_forecast_horizon"])

    avg_temp = round(sum(temps) / len(temps), 1) if temps else None
    max_temp = round(max(temps), 1) if temps else None

    return {
        **route,
        "points": scored_points,
        "avg_temp_c": avg_temp,
        "max_temp_c": max_temp,
        "points_scored": len(temps),
        "points_total": len(scored_points),
        "points_out_of_horizon": out_of_horizon,
    }


# Phase 12.5d — a simple 3-bucket "safe / moderate / risk" read on a
# route's avg_temp_c, for a plain-language badge next to the existing
# fastest/coolest/balanced labels. Reuses the SAME breakpoints
# risk_score.py already uses for NWS's own "Caution" (32°C) / "Extreme
# Caution" (39°C) heat-index floors — not a second, independently
# invented threshold set for the same underlying idea.
HEAT_CATEGORIES = [
    (float("-inf"), 32.0, "safe", "emerald"),
    (32.0, 39.0, "moderate", "amber"),
    (39.0, float("inf"), "risk", "red"),
]


def heat_category(avg_temp_c: float | None) -> tuple[str, str]:
    """Returns (label, color) for a route's avg_temp_c. ("unknown",
    "slate") when there's no heat reading at all — e.g. every sampled
    point fell beyond the 12-hour forecast horizon — rather than
    guessing a bucket with no data behind it."""
    if avg_temp_c is None:
        return "unknown", "slate"
    for lo, hi, label, color in HEAT_CATEGORIES:
        if lo <= avg_temp_c < hi:
            return label, color
    return HEAT_CATEGORIES[-1][2], HEAT_CATEGORIES[-1][3]


def label_routes(routes: list[dict], heat_weight: float | None = None) -> list[dict]:
    """Assigns "fastest" / "coolest" / "balanced" labels (a route can
    hold more than one — e.g. the fastest route can also happen to be
    the coolest). Returns the same routes, sorted fastest-first, each
    with a new "labels" list. If no route has any heat data at all
    (every provider's points fell outside the forecast horizon, or every
    FortyGuard lookup failed), "coolest"/"balanced" both fall back to
    "fastest" rather than picking an arbitrary route with no basis.

    `heat_weight` (0.0-1.0) controls how much "balanced" leans toward
    heat vs time; None uses ROUTE_DEFAULT_HEAT_WEIGHT. Kept slightly
    heat-leaning by default (0.55) rather than an even 0.5 — this is
    literally the feature's whole point ("Heat-Safe Routing", not
    "fastest route with a heat sticker on it"), but not so heavy that a
    3x-slower route would ever win purely for being marginally cooler."""
    if not routes:
        return routes

    weight = heat_weight if heat_weight is not None else settings.ROUTE_DEFAULT_HEAT_WEIGHT

    fastest = min(routes, key=lambda r: r["duration_s"])
    with_heat = [r for r in routes if r["avg_temp_c"] is not None]
    coolest = min(with_heat, key=lambda r: r["avg_temp_c"]) if with_heat else fastest

    balanced = fastest
    if with_heat:
        max_duration = max(r["duration_s"] for r in routes) or 1.0
        temps = [r["avg_temp_c"] for r in with_heat]
        min_temp, max_temp = min(temps), max(temps)
        temp_range = (max_temp - min_temp) or 1.0

        def _combined_score(r: dict) -> float:
            norm_time = r["duration_s"] / max_duration
            norm_heat = (r["avg_temp_c"] - min_temp) / temp_range if r["avg_temp_c"] is not None else 1.0
            return (1 - weight) * norm_time + weight * norm_heat

        balanced = min(with_heat, key=_combined_score)

    for r in routes:
        labels = []
        if r is fastest:
            labels.append("fastest")
        if r is coolest:
            labels.append("coolest")
        if r is balanced:
            labels.append("balanced")
        r["labels"] = labels
        category, color = heat_category(r.get("avg_temp_c"))
        r["heat_category"] = category
        r["heat_category_color"] = color

    return sorted(routes, key=lambda r: r["duration_s"])
