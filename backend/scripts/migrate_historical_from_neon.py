"""
One-time (but safely re-runnable) migration: copies every row from
`historical_heat_data` in the SEPARATE Neon database (used only by
seed_historical.py, see that script's own docstring) into the MAIN
Thermora Postgres database — the same one backend/app/db.py manages.

Why this is safe:
  - It ONLY ever touches one table: historical_heat_data. It creates that
    table in the destination with CREATE TABLE IF NOT EXISTS (identical
    schema to seed_historical.py's own CREATE_TABLE_SQL) and never runs
    ALTER/DROP on anything else. No existing table, column, or row in
    your main database is read, written, or referenced.
  - It's a pure upsert (ON CONFLICT ... DO UPDATE) keyed on the same
    unique constraint the seeder uses (city_id, feature_date,
    analytic_type, threshold_c, direction, granularity_m) — re-running
    this script after your June fetch finishes just adds/refreshes rows,
    never duplicates them. Safe to run again anytime, as many times as
    you want.
  - To fully undo everything this script (and the historical feature)
    ever did to your main database, one command is enough and touches
    nothing else:
        DROP TABLE IF EXISTS historical_heat_data;

Destination connection reuses your actual backend's own config
(backend/app/config.py + .env) — so it always targets exactly the
database your running app uses, with no risk of a typo'd host/port
pointing this at the wrong place.

Source connection (the separate Neon DB) is NOT part of your app's
config — pass it explicitly, either as an argument or via the
SOURCE_DATABASE_URL environment variable. Get this connection string from
the Neon console: https://console.neon.tech/app/projects/late-sunset-15221529/branches/br-dry-bird-ax3mloyh
-> "Connection Details" (top of that page) -> copy the "psql" / pooled
connection string (starts with postgresql://...).

Usage (from your backend/ directory):
    python scripts/migrate_historical_from_neon.py "postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require"

    # or, without retyping it every time:
    set SOURCE_DATABASE_URL=postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require   (Windows PowerShell: $env:SOURCE_DATABASE_URL="...")
    python scripts/migrate_historical_from_neon.py
"""
import asyncio
import os
import sys
from pathlib import Path

import asyncpg

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db import init_db, close_db, get_pool  # noqa: E402

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS historical_heat_data (
    id              SERIAL PRIMARY KEY,
    city_id         TEXT NOT NULL,
    city_name       TEXT NOT NULL,
    state           TEXT,
    lat             DOUBLE PRECISION NOT NULL,
    lon             DOUBLE PRECISION NOT NULL,
    feature_date    DATE NOT NULL,
    analytic_type   TEXT NOT NULL,
    mean_value      DOUBLE PRECISION,
    max_value       DOUBLE PRECISION,
    min_value       DOUBLE PRECISION,
    n_tiles         INTEGER NOT NULL,
    threshold_c     DOUBLE PRECISION,
    direction       TEXT,
    granularity_m   INTEGER NOT NULL,
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_stats_data  JSONB NOT NULL,
    UNIQUE (city_id, feature_date, analytic_type, threshold_c, direction, granularity_m)
);
"""

UPSERT_SQL = """
INSERT INTO historical_heat_data
    (city_id, city_name, state, lat, lon, feature_date, analytic_type,
     mean_value, max_value, min_value, n_tiles, threshold_c, direction,
     granularity_m, fetched_at, raw_stats_data)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
ON CONFLICT (city_id, feature_date, analytic_type, threshold_c, direction, granularity_m)
DO UPDATE SET
    mean_value = EXCLUDED.mean_value,
    max_value = EXCLUDED.max_value,
    min_value = EXCLUDED.min_value,
    n_tiles = EXCLUDED.n_tiles,
    raw_stats_data = EXCLUDED.raw_stats_data,
    fetched_at = EXCLUDED.fetched_at
"""


async def main() -> None:
    source_url = (sys.argv[1] if len(sys.argv) > 1 else None) or os.getenv("SOURCE_DATABASE_URL")
    if not source_url:
        print("Missing source connection string. Pass it as an argument or set SOURCE_DATABASE_URL.")
        print('Example: python scripts/migrate_historical_from_neon.py "postgresql://user:pass@host/db?sslmode=require"')
        sys.exit(1)

    print("Connecting to source (Neon) database...")
    source_conn = await asyncpg.connect(dsn=source_url, ssl="require")
    try:
        rows = await source_conn.fetch(
            """
            SELECT city_id, city_name, state, lat, lon, feature_date, analytic_type,
                   mean_value, max_value, min_value, n_tiles, threshold_c, direction,
                   granularity_m, fetched_at, raw_stats_data
            FROM historical_heat_data
            ORDER BY city_id, feature_date, analytic_type
            """
        )
    finally:
        await source_conn.close()

    print(f"Found {len(rows)} rows in the source database")
    if not rows:
        print("Nothing to migrate.")
        return

    print("Connecting to destination (main app) database...")
    await init_db()
    dest_pool = get_pool()
    await dest_pool.execute(CREATE_TABLE_SQL)

    async with dest_pool.acquire() as conn:
        async with conn.transaction():
            for row in rows:
                await conn.execute(
                    UPSERT_SQL,
                    row["city_id"], row["city_name"], row["state"], row["lat"], row["lon"],
                    row["feature_date"], row["analytic_type"], row["mean_value"], row["max_value"],
                    row["min_value"], row["n_tiles"], row["threshold_c"], row["direction"],
                    row["granularity_m"], row["fetched_at"], row["raw_stats_data"],
                )

    print(f"Migrated {len(rows)} rows into historical_heat_data in the main database.")
    print("Re-run this same command anytime (e.g. after your June fetch finishes) — it's a pure upsert, safe to repeat.")
    await close_db()


if __name__ == "__main__":
    asyncio.run(main())
