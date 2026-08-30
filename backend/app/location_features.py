"""
Phase 5 — Derived Features Layer.

Auto-populates `location_features` (one row per monitored city + date +
hour) a column at a time, whenever a raw FortyGuard fetch actually
completes:
  - a 'tcm' heatmap fetch      -> mean/max/min temp   (hour-scoped)
  - an env-params fetch        -> heat index, wet bulb, humidity, AQI (hour-scoped)
  - an 'exceedance' heatmap    -> exceedance_hours     (day-scoped)
  - a 'persistence' heatmap    -> persistence_hours    (day-scoped)

feature_hour distinguishes the two: hour-scoped fields go in a row keyed
to the actual hour that was fetched (e.g. '14:00'); day-scoped fields go
in a separate row keyed to the fixed sentinel 'DAY'. This used to be one
row per (city_id, feature_date) with everything mixed together — a
specific hour's heat index sitting next to a full day's exceedance count,
with nothing recording which hour the heat index even came from. See
db.py's location_features table comment for the schema side of this.

Nothing downstream reads this yet (that's Phase 8+ — Risk Score, People
Impact, Heat Story, ...) but every one of those is meant to read FROM this
table instead of re-parsing raw jsonb every time. This module only runs on
a genuine new completion, not on cache hits, since a cache hit isn't a raw
fetch "completing" — it's a reuse of one that already did.
"""
from datetime import date as date_cls, timedelta

from .db import get_pool
from .locations import nearest_city
from .logger import log_db, log_err

# Fixed sentinel for the day-scoped row — see the module docstring and
# db.py's schema comment for why this can't just be NULL.
DAY_SENTINEL = "DAY"


def _missing(value) -> bool:
    """FortyGuard uses JSON null for missing readings; older stored
    responses may still contain the legacy sentinel -999. Both mean
    'no data', never zero."""
    return value is None or value == -999


def _polygon_centroid(polygon_aoi: dict) -> tuple[float, float] | None:
    try:
        coords = polygon_aoi["features"][0]["geometry"]["coordinates"][0]
    except (KeyError, IndexError, TypeError):
        return None
    # Last point closes the ring (same as the first) — drop it before averaging.
    pts = coords[:-1] if len(coords) > 1 and coords[0] == coords[-1] else coords
    if not pts:
        return None
    lat = sum(p[1] for p in pts) / len(pts)
    lon = sum(p[0] for p in pts) / len(pts)
    return lat, lon


async def _upsert(city_id: str, feature_date: date_cls, feature_hour: str, **fields) -> None:
    columns = ["mean_temp_c", "max_temp_c", "min_temp_c", "exceedance_hours",
               "persistence_hours", "heat_index_c", "wet_bulb_c", "humidity_pct", "aqi"]
    values = [fields.get(c) for c in columns]
    if all(v is None for v in values):
        return  # nothing to record

    set_clause = ", ".join(f"{c} = COALESCE(EXCLUDED.{c}, location_features.{c})" for c in columns)
    pool = get_pool()
    await pool.execute(
        f"""
        INSERT INTO location_features (city_id, feature_date, feature_hour, {", ".join(columns)}, updated_at)
        VALUES ($1, $2, $3, {", ".join(f"${i + 4}" for i in range(len(columns)))}, now())
        ON CONFLICT (city_id, feature_date, feature_hour) DO UPDATE SET
            {set_clause},
            updated_at = now()
        """,
        city_id, feature_date, feature_hour, *values,
    )
    log_db(f"location_features upserted for {city_id} / {feature_date} / {feature_hour}",
           {c: v for c, v in zip(columns, values) if v is not None})


async def record_heatmap_result(payload: dict, stats_data: dict) -> None:
    """Called after a heatmap fetch genuinely completes (not a cache hit)."""
    try:
        centroid = _polygon_centroid(payload.get("polygon_aoi", {}))
        if not centroid:
            return
        city = nearest_city(*centroid)
        if not city:
            return  # not a monitored location — Phase 5 only tracks known cities for now

        date_time = payload.get("date_time", {})
        start_date = date_time.get("start_date")
        if not start_date:
            return
        feature_date = date_cls.fromisoformat(start_date)

        analytic_type = payload.get("analytic_type") or "tcm"

        if analytic_type == "tcm":
            # tcm nests its aggregate under stats_data.temperature_stats
            # (mean/maximum/minimum/standard_deviation) — this shape is
            # tcm-specific.
            temp_stats = (stats_data or {}).get("temperature_stats", {}) or {}
            mean_val = temp_stats.get("mean")
            # Hour-scoped: whatever specific hour this TCM fetch actually
            # used (Heat Map's own default is single-hour). A rarer
            # Single Day TCM fetch (filter_type 3, no start_time) has no
            # single hour to attribute the mean/max/min to — falls back to
            # the DAY sentinel in that case, same bucket as
            # exceedance/persistence, which is honestly what a full-day
            # TCM aggregate actually is.
            feature_hour = date_time.get("start_time") or DAY_SENTINEL
            await _upsert(city["id"], feature_date, feature_hour,
                          mean_temp_c=None if _missing(mean_val) else mean_val,
                          max_temp_c=None if _missing(temp_stats.get("maximum")) else temp_stats.get("maximum"),
                          min_temp_c=None if _missing(temp_stats.get("minimum")) else temp_stats.get("minimum"))
        elif analytic_type in ("exceedance", "persistence"):
            # exceedance/persistence (and time_of_measure) return a FLAT
            # stats_data shape per FortyGuard's docs — mean/min/max/units/
            # n_cells sit directly on stats_data, NOT nested under
            # temperature_stats the way tcm's is (confirmed against a real
            # response: {"activity_id": ..., "units": "hour", "mean": 1.0,
            # ...} with no temperature_stats key at all). This used to
            # read stats_data.temperature_stats.mean regardless of
            # analytic_type, which only exists for tcm — so mean_val was
            # ALWAYS None here, `_upsert` was ALWAYS called with its one
            # field set to None, and its own "nothing to record" guard
            # ALWAYS silently skipped the write. No exception, no log —
            # every exceedance/persistence fetch that ever completed
            # (with real FortyGuard data) was silently discarded here.
            mean_val = (stats_data or {}).get("mean")
            # Day-scoped by definition — "hours above threshold" / the
            # longest continuous run are structurally whole-day figures,
            # not tied to any one hour.
            column = "exceedance_hours" if analytic_type == "exceedance" else "persistence_hours"
            await _upsert(city["id"], feature_date, DAY_SENTINEL,
                          **{column: None if _missing(mean_val) else mean_val})
        # time_of_measure isn't one of Phase 5's tracked columns — skipped.
    except Exception as exc:  # noqa: BLE001 - derived-features population must never break the real request
        log_err("Failed to populate location_features from heatmap result",
                {"error": str(exc), "analytic_type": payload.get("analytic_type"),
                 "start_date": payload.get("date_time", {}).get("start_date")})


async def get_combined_features(city_id: str, feature_date: date_cls) -> tuple[dict | None, str | None]:
    """Reads back what Phase 5 has recorded for a city/date, merging the
    day-scoped 'DAY' row (exceedance_hours, persistence_hours) with
    whichever hour-scoped row was most recently updated (mean/max/min
    temp, heat index, wet bulb, humidity, AQI) into one dict — the shape
    every Phase 8+ consumer (Heat Risk Score, People Impact Score, ...)
    actually wants. Pulled out of routers/risk.py so Phase 9's impact
    router can read the exact same merged features without copy-pasting
    the day/hour merge logic. Returns (features_or_None, used_hour)."""
    pool = get_pool()
    day_row = await pool.fetchrow(
        "SELECT * FROM location_features WHERE city_id = $1 AND feature_date = $2 AND feature_hour = 'DAY'",
        city_id, feature_date,
    )
    hour_row = await pool.fetchrow(
        """
        SELECT * FROM location_features
        WHERE city_id = $1 AND feature_date = $2 AND feature_hour <> 'DAY'
        ORDER BY updated_at DESC LIMIT 1
        """,
        city_id, feature_date,
    )

    if not day_row and not hour_row:
        return None, None

    features: dict = {}
    if day_row:
        features.update(dict(day_row))
    used_hour = None
    if hour_row:
        # Hour-scoped fields win on overlap (there shouldn't be any — see
        # risk.py's original comment on this same merge for why).
        features.update({k: v for k, v in dict(hour_row).items() if v is not None})
        used_hour = hour_row["feature_hour"]
    return features, used_hour


async def record_env_params_result(payload: dict, locations_result: list) -> None:
    """Called after an env-params fetch genuinely completes (not a cache hit)."""
    try:
        lat, lon = payload.get("latitude"), payload.get("longitude")
        if lat is None or lon is None:
            return
        city = nearest_city(lat, lon)
        if not city:
            return

        date_time = payload.get("date_time", {})
        start_date = date_time.get("start_date")
        if not start_date or not locations_result:
            return
        feature_date = date_cls.fromisoformat(start_date)
        # Env-params is fundamentally a single-moment reading — always
        # hour-scoped. Falls back to DAY only in the unusual case where no
        # start_time was actually sent (shouldn't normally happen for this
        # endpoint, but a value still needs somewhere honest to live
        # rather than being silently dropped).
        feature_hour = date_time.get("start_time") or DAY_SENTINEL

        params = (locations_result[0] or {}).get("parameters", {}) or {}

        def first(key):
            vals = params.get(key)
            val = vals[0] if isinstance(vals, list) and vals else None
            return None if _missing(val) else val

        await _upsert(
            city["id"], feature_date, feature_hour,
            heat_index_c=first("heat_index_celsius"),
            wet_bulb_c=first("wet_bulb_temperature_celsius"),
            humidity_pct=first("relative_humidity_percent"),
            aqi=first("air_quality:idx"),
        )
    except Exception as exc:  # noqa: BLE001 - same rationale as above
        log_err("Failed to populate location_features from env-params result", {"error": str(exc)})


async def get_daily_history(city_id: str, start_date: date_cls, end_date: date_cls) -> list[dict]:
    """Research tab's real (non-fabricated) trend source. One entry per
    calendar day in [start_date, end_date], reading exactly two things
    for each day, never estimating a third:

      - day_max_temp_c: the DAY-sentinel row's max_temp_c if a Single Day
        TCM fetch was ever made for this date (see record_heatmap_result's
        own comment on when that row gets a temperature at all), else the
        highest max_temp_c/mean_temp_c across whatever HOUR-scoped rows
        exist for that date — genuinely the day's hottest reading Thermora
        has on file, just sourced from hourly fetches instead of a
        single-day one. `day_max_temp_source` records which of the two
        happened, so the frontend/prompt can be honest about it instead of
        implying every day was fetched the same way.
      - exceedance_hours / persistence_hours: DAY-row only — there is no
        hourly fallback for these, they are day-scoped by definition (see
        record_heatmap_result).

    A day with NO row at all (never fetched, via any tab) comes back with
    every field None and has_data=False — Research renders that as a
    genuine gap, never a zero. `fetched_hours` is the actual list of
    HOUR-scoped rows on file for that date (may be empty even when
    has_data=True, if only a DAY-sentinel row exists) — routers/research.py
    diffs this against heat_story.expected_hours() to know exactly which
    hours are still missing for a "fetch missing data" action, using the
    SAME expected-hours daytime window Heat Story already defines, so
    every day in a Research range is judged against one consistent
    yardstick rather than however many hours happened to get fetched."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT feature_date, feature_hour, mean_temp_c, max_temp_c,
               exceedance_hours, persistence_hours
        FROM location_features
        WHERE city_id = $1 AND feature_date BETWEEN $2 AND $3
        """,
        city_id, start_date, end_date,
    )

    by_date: dict[date_cls, list[dict]] = {}
    for r in rows:
        by_date.setdefault(r["feature_date"], []).append(dict(r))

    out = []
    day = start_date
    while day <= end_date:
        day_rows = by_date.get(day, [])
        day_row = next((r for r in day_rows if r["feature_hour"] == DAY_SENTINEL), None)
        hour_rows = [r for r in day_rows if r["feature_hour"] != DAY_SENTINEL]

        day_max = day_row.get("max_temp_c") if day_row else None
        source = "single_day_fetch" if day_max is not None else None
        if day_max is None and hour_rows:
            candidates = [r.get("max_temp_c") if r.get("max_temp_c") is not None else r.get("mean_temp_c")
                          for r in hour_rows]
            candidates = [c for c in candidates if c is not None]
            if candidates:
                day_max = max(candidates)
                source = "hourly_max"

        out.append({
            "date": day.isoformat(),
            "has_data": bool(day_rows),
            "max_temp_c": day_max,
            "max_temp_source": source,
            "exceedance_hours": day_row.get("exceedance_hours") if day_row else None,
            "persistence_hours": day_row.get("persistence_hours") if day_row else None,
            "hours_fetched": len(hour_rows),
            "fetched_hours": sorted(r["feature_hour"] for r in hour_rows),
        })
        day += timedelta(days=1)
    return out