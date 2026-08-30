"""
Phase 14 — City-to-City Comparison, read side.

Pure reads over `historical_heat_data` (populated by the standalone
seed_historical.py script, migrated into the main database via
scripts/migrate_historical_from_neon.py). This module never writes to
that table and never talks to FortyGuard — it only aggregates rows that
are already there, so it's safe to call as often as the frontend wants.

Aggregation happens in SQL (date_trunc('month', ...)) rather than in
Python, since the row count here can span a year x 6 cities x 3 analytic
types x ~30 days — cheap for Postgres to fold, wasteful to pull raw and
fold client-side.
"""
import json
from datetime import date as date_cls

from .db import get_pool
from .locations import MONITORED_CITIES, get_city


async def get_available_months() -> list[str]:
    """Distinct YYYY-MM months that have at least one stored row —
    lets the frontend know what's actually been fetched instead of
    assuming a full year exists."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT DISTINCT to_char(date_trunc('month', feature_date), 'YYYY-MM') AS month
        FROM historical_heat_data
        ORDER BY month
        """
    )
    return [r["month"] for r in rows]


async def get_available_dates(month: str | None = None) -> list[str]:
    """Distinct feature_dates that have at least one stored row, optionally
    narrowed to a single YYYY-MM month. Powers the exact-date picker used
    by the single-date, cross-city comparison view — only ever offers
    dates that actually have something stored, never a full calendar."""
    pool = get_pool()
    if month:
        rows = await pool.fetch(
            """
            SELECT DISTINCT feature_date
            FROM historical_heat_data
            WHERE to_char(feature_date, 'YYYY-MM') = $1
            ORDER BY feature_date
            """,
            month,
        )
    else:
        rows = await pool.fetch(
            "SELECT DISTINCT feature_date FROM historical_heat_data ORDER BY feature_date"
        )
    return [r["feature_date"].isoformat() for r in rows]


async def get_latest_snapshot(city_ids: list[str]) -> dict:
    """Most recent stored TCM row per requested city — this is what the
    "Latest Stored Snapshot" cards read instead of hitting FortyGuard
    live. Pure Postgres read over historical_heat_data (already seeded);
    a city with nothing stored yet just comes back with has_data=False,
    it never triggers a fetch of any kind."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (city_id)
            city_id, feature_date, mean_value, max_value, min_value, raw_stats_data
        FROM historical_heat_data
        WHERE analytic_type = 'tcm' AND city_id = ANY($1::text[])
        ORDER BY city_id, feature_date DESC
        """,
        city_ids,
    )
    by_city = {r["city_id"]: r for r in rows}

    out = []
    for city_id in city_ids:
        city = get_city(city_id)
        r = by_city.get(city_id)
        if r is None:
            out.append({
                "city_id": city_id,
                "city_name": city["name"] if city else city_id,
                "has_data": False,
            })
            continue

        std_dev = None
        try:
            raw = json.loads(r["raw_stats_data"]) if r["raw_stats_data"] else {}
            temp_stats = raw.get("temperature_stats") or {}
            std_dev = temp_stats.get("standard_deviation")
        except (TypeError, ValueError):
            std_dev = None

        out.append({
            "city_id": city_id,
            "city_name": city["name"] if city else city_id,
            "has_data": True,
            "feature_date": r["feature_date"].isoformat(),
            "mean_c": r["mean_value"],
            "max_c": r["max_value"],
            "min_c": r["min_value"],
            "std_dev": std_dev,
        })
    return {"cities": out}


async def get_monthly_comparison(
    city_ids: list[str],
    analytic_type: str,
    months_back: int = 12,
    months_list: list[str] | None = None,
) -> dict:
    """One time series per requested city: monthly average of
    `mean_value` for the given analytic_type. Two mutually-exclusive
    range modes:
      - months_list given: exactly those YYYY-MM months, in whatever
        order the caller picked them (e.g. any 3 non-consecutive months),
        so the frontend isn't limited to a trailing window.
      - months_list absent: the last `months_back` calendar months
        counting back from now, as before.
    A city with zero stored rows still gets an entry (empty points list)
    so the frontend can show "no data yet for this city" rather than
    silently omitting it."""
    pool = get_pool()

    if months_list:
        rows = await pool.fetch(
            """
            SELECT
                city_id,
                to_char(date_trunc('month', feature_date), 'YYYY-MM') AS month,
                avg(mean_value) AS avg_mean,
                avg(max_value) AS avg_max,
                count(*) FILTER (WHERE mean_value IS NOT NULL) AS days_sampled
            FROM historical_heat_data
            WHERE analytic_type = $1
              AND city_id = ANY($2::text[])
              AND to_char(date_trunc('month', feature_date), 'YYYY-MM') = ANY($3::text[])
            GROUP BY city_id, date_trunc('month', feature_date)
            ORDER BY city_id, month
            """,
            analytic_type, city_ids, months_list,
        )
    else:
        rows = await pool.fetch(
            """
            SELECT
                city_id,
                to_char(date_trunc('month', feature_date), 'YYYY-MM') AS month,
                avg(mean_value) AS avg_mean,
                avg(max_value) AS avg_max,
                count(*) FILTER (WHERE mean_value IS NOT NULL) AS days_sampled
            FROM historical_heat_data
            WHERE analytic_type = $1
              AND city_id = ANY($2::text[])
              AND feature_date >= (date_trunc('month', now()) - make_interval(months => $3))
            GROUP BY city_id, date_trunc('month', feature_date)
            ORDER BY city_id, month
            """,
            analytic_type, city_ids, months_back,
        )

    by_city: dict[str, list[dict]] = {c: [] for c in city_ids}
    for r in rows:
        by_city.setdefault(r["city_id"], []).append({
            "month": r["month"],
            "mean": round(r["avg_mean"], 2) if r["avg_mean"] is not None else None,
            "max": round(r["avg_max"], 2) if r["avg_max"] is not None else None,
            "days_sampled": r["days_sampled"],
        })

    series = []
    for city_id in city_ids:
        city = get_city(city_id)
        series.append({
            "city_id": city_id,
            "city_name": city["name"] if city else city_id,
            "points": by_city.get(city_id, []),
        })

    unit = "°C" if analytic_type == "tcm" else "hours"
    return {"analytic_type": analytic_type, "unit": unit, "series": series}


async def get_temperature_profile_monthly(
    city_ids: list[str],
    months_back: int = 12,
    months_list: list[str] | None = None,
) -> dict:
    """Mean/Max/Min/StdDev trend, one point per calendar month, per city —
    tcm-only (this is the temperature profile graph that replaced the old
    'Latest Stored Snapshot' cards; exceedance/persistence don't carry a
    meaningful std dev the same way). Mean/max/min are averages of the
    daily mean/max/min readings for that month, same as
    get_monthly_comparison's avg_mean/avg_max. StdDev is the average of
    each stored day's OWN spatial standard_deviation (pulled out of
    raw_stats_data->temperature_stats, the same field
    get_latest_snapshot's card reads) — i.e. 'how spread out was a
    typical day's reading this month', not the month-to-month variance of
    the mean itself. That keeps 'std' meaning the same thing here as it
    did on the old single-day card, just averaged across the month
    instead of read off one day.
    """
    pool = get_pool()

    if months_list:
        rows = await pool.fetch(
            """
            SELECT
                city_id,
                to_char(date_trunc('month', feature_date), 'YYYY-MM') AS month,
                avg(mean_value) AS avg_mean,
                avg(max_value) AS avg_max,
                avg(min_value) AS avg_min,
                avg((raw_stats_data->'temperature_stats'->>'standard_deviation')::double precision) AS avg_std,
                count(*) FILTER (WHERE mean_value IS NOT NULL) AS days_sampled
            FROM historical_heat_data
            WHERE analytic_type = 'tcm'
              AND city_id = ANY($1::text[])
              AND to_char(date_trunc('month', feature_date), 'YYYY-MM') = ANY($2::text[])
            GROUP BY city_id, date_trunc('month', feature_date)
            ORDER BY city_id, month
            """,
            city_ids, months_list,
        )
    else:
        rows = await pool.fetch(
            """
            SELECT
                city_id,
                to_char(date_trunc('month', feature_date), 'YYYY-MM') AS month,
                avg(mean_value) AS avg_mean,
                avg(max_value) AS avg_max,
                avg(min_value) AS avg_min,
                avg((raw_stats_data->'temperature_stats'->>'standard_deviation')::double precision) AS avg_std,
                count(*) FILTER (WHERE mean_value IS NOT NULL) AS days_sampled
            FROM historical_heat_data
            WHERE analytic_type = 'tcm'
              AND city_id = ANY($1::text[])
              AND feature_date >= (date_trunc('month', now()) - make_interval(months => $2))
            GROUP BY city_id, date_trunc('month', feature_date)
            ORDER BY city_id, month
            """,
            city_ids, months_back,
        )

    by_city: dict[str, list[dict]] = {c: [] for c in city_ids}
    for r in rows:
        by_city.setdefault(r["city_id"], []).append({
            "month": r["month"],
            "mean": round(r["avg_mean"], 2) if r["avg_mean"] is not None else None,
            "max": round(r["avg_max"], 2) if r["avg_max"] is not None else None,
            "min": round(r["avg_min"], 2) if r["avg_min"] is not None else None,
            "std": round(r["avg_std"], 2) if r["avg_std"] is not None else None,
            "days_sampled": r["days_sampled"],
        })

    series = []
    for city_id in city_ids:
        city = get_city(city_id)
        series.append({
            "city_id": city_id,
            "city_name": city["name"] if city else city_id,
            "points": by_city.get(city_id, []),
        })

    return {"unit": "°C", "series": series}


async def get_temperature_profile_date(city_ids: list[str], feature_date: date_cls) -> dict:
    """Same mean/max/min/std shape as get_temperature_profile_monthly, but
    for one exact stored day instead of a month average — this is the
    'actual date' branch: the table shown below the profile graph when
    the user picks a specific date instead of a month."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT city_id, mean_value, max_value, min_value,
               (raw_stats_data->'temperature_stats'->>'standard_deviation')::double precision AS std_dev
        FROM historical_heat_data
        WHERE analytic_type = 'tcm' AND feature_date = $1 AND city_id = ANY($2::text[])
        """,
        feature_date, city_ids,
    )
    by_city = {r["city_id"]: r for r in rows}

    cities_out = []
    for city_id in city_ids:
        city = get_city(city_id)
        r = by_city.get(city_id)
        if r is None:
            cities_out.append({"city_id": city_id, "city_name": city["name"] if city else city_id, "has_data": False})
            continue
        cities_out.append({
            "city_id": city_id,
            "city_name": city["name"] if city else city_id,
            "has_data": True,
            "mean": round(r["mean_value"], 2) if r["mean_value"] is not None else None,
            "max": round(r["max_value"], 2) if r["max_value"] is not None else None,
            "min": round(r["min_value"], 2) if r["min_value"] is not None else None,
            "std": round(r["std_dev"], 2) if r["std_dev"] is not None else None,
        })

    return {"feature_date": feature_date.isoformat(), "cities": cities_out}


async def get_date_comparison(city_ids: list[str], feature_date: date_cls) -> dict:
    """Single-date cross-section: for one exact calendar day, every
    requested city's tcm/exceedance/persistence readings side by side —
    a snapshot comparison rather than a trend. A city with nothing
    stored for that exact date comes back with has_data=False for it;
    nothing is interpolated or estimated."""
    pool = get_pool()
    rows = await pool.fetch(
        """
        SELECT city_id, analytic_type, mean_value, max_value, min_value
        FROM historical_heat_data
        WHERE feature_date = $1 AND city_id = ANY($2::text[])
        """,
        feature_date, city_ids,
    )

    by_city: dict[str, dict] = {}
    for r in rows:
        by_city.setdefault(r["city_id"], {})[r["analytic_type"]] = {
            "mean": round(r["mean_value"], 2) if r["mean_value"] is not None else None,
            "max": round(r["max_value"], 2) if r["max_value"] is not None else None,
            "min": round(r["min_value"], 2) if r["min_value"] is not None else None,
        }

    cities_out = []
    for city_id in city_ids:
        city = get_city(city_id)
        types = by_city.get(city_id, {})
        cities_out.append({
            "city_id": city_id,
            "city_name": city["name"] if city else city_id,
            "has_data": bool(types),
            "tcm": types.get("tcm"),
            "exceedance": types.get("exceedance"),
            "persistence": types.get("persistence"),
        })

    return {"feature_date": feature_date.isoformat(), "cities": cities_out}


async def get_extremes(
    city_ids: list[str],
    months_back: int = 12,
    months_list: list[str] | None = None,
) -> dict:
    """For each requested city, the single hottest and single coolest
    stored day (by tcm mean_value) within the same range the trend chart
    is currently showing — a concrete "what actually happened" anchor
    next to an otherwise abstract monthly-average line. Two DISTINCT ON
    queries (one ordered DESC, one ASC) rather than a single window-
    function query, to keep each easy to read/verify on its own; the
    row counts here are small enough that the extra query costs nothing
    that matters."""
    pool = get_pool()

    if months_list:
        hottest_rows = await pool.fetch(
            """
            SELECT DISTINCT ON (city_id) city_id, feature_date, mean_value
            FROM historical_heat_data
            WHERE analytic_type = 'tcm' AND city_id = ANY($1::text[])
              AND mean_value IS NOT NULL
              AND to_char(date_trunc('month', feature_date), 'YYYY-MM') = ANY($2::text[])
            ORDER BY city_id, mean_value DESC
            """,
            city_ids, months_list,
        )
        coolest_rows = await pool.fetch(
            """
            SELECT DISTINCT ON (city_id) city_id, feature_date, mean_value
            FROM historical_heat_data
            WHERE analytic_type = 'tcm' AND city_id = ANY($1::text[])
              AND mean_value IS NOT NULL
              AND to_char(date_trunc('month', feature_date), 'YYYY-MM') = ANY($2::text[])
            ORDER BY city_id, mean_value ASC
            """,
            city_ids, months_list,
        )
    else:
        hottest_rows = await pool.fetch(
            """
            SELECT DISTINCT ON (city_id) city_id, feature_date, mean_value
            FROM historical_heat_data
            WHERE analytic_type = 'tcm' AND city_id = ANY($1::text[])
              AND mean_value IS NOT NULL
              AND feature_date >= (date_trunc('month', now()) - make_interval(months => $2))
            ORDER BY city_id, mean_value DESC
            """,
            city_ids, months_back,
        )
        coolest_rows = await pool.fetch(
            """
            SELECT DISTINCT ON (city_id) city_id, feature_date, mean_value
            FROM historical_heat_data
            WHERE analytic_type = 'tcm' AND city_id = ANY($1::text[])
              AND mean_value IS NOT NULL
              AND feature_date >= (date_trunc('month', now()) - make_interval(months => $2))
            ORDER BY city_id, mean_value ASC
            """,
            city_ids, months_back,
        )

    hottest_by_city = {r["city_id"]: r for r in hottest_rows}
    coolest_by_city = {r["city_id"]: r for r in coolest_rows}

    out = []
    for city_id in city_ids:
        city = get_city(city_id)
        hot = hottest_by_city.get(city_id)
        cool = coolest_by_city.get(city_id)
        out.append({
            "city_id": city_id,
            "city_name": city["name"] if city else city_id,
            "hottest": {
                "date": hot["feature_date"].isoformat(),
                "value_c": round(hot["mean_value"], 2),
            } if hot else None,
            "coolest": {
                "date": cool["feature_date"].isoformat(),
                "value_c": round(cool["mean_value"], 2),
            } if cool else None,
        })
    return {"cities": out}


async def get_all_monitored_city_ids() -> list[str]:
    return [c["id"] for c in MONITORED_CITIES]
