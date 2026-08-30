"""
PostgreSQL access layer.

On startup:
  1. Connect to the maintenance "postgres" database and CREATE DATABASE
     the target DB if it doesn't already exist.
  2. Open a connection pool to the target DB.
  3. Run CREATE TABLE IF NOT EXISTS for every table Thermora needs.

No manual migration step is required to get a fresh environment running.
"""
import asyncpg

from .config import settings
from .logger import log_db, log_err

_pool: asyncpg.Pool | None = None


async def _ensure_database_exists() -> None:
    """Connect to the default 'postgres' maintenance DB and create the
    target database if it isn't there yet."""
    log_db(f"Checking whether database '{settings.POSTGRES_DB}' exists")
    conn = await asyncpg.connect(
        host=settings.POSTGRES_HOST,
        port=settings.POSTGRES_PORT,
        user=settings.POSTGRES_USER,
        password=settings.POSTGRES_PASSWORD,
        database="postgres",
    )
    try:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", settings.POSTGRES_DB
        )
        if not exists:
            log_db(f"Database '{settings.POSTGRES_DB}' not found — creating it")
            # CREATE DATABASE cannot run inside a transaction / with params,
            # identifier is server-controlled (from our own settings), safe to format.
            await conn.execute(f'CREATE DATABASE "{settings.POSTGRES_DB}"')
        else:
            log_db(f"Database '{settings.POSTGRES_DB}' already exists")
    finally:
        await conn.close()


DDL_STATEMENTS = [
    # Audit / job table — one row per FortyGuard activity we've submitted.
    """
    CREATE TABLE IF NOT EXISTS fortyguard_activities (
        activity_id        TEXT PRIMARY KEY,
        endpoint_type       TEXT NOT NULL,
        request_payload     JSONB NOT NULL,
        request_signature   TEXT NOT NULL,
        status              TEXT NOT NULL DEFAULT 'Processing',
        submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at        TIMESTAMPTZ,
        error                TEXT
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_activities_signature ON fortyguard_activities (request_signature);",
    "CREATE INDEX IF NOT EXISTS idx_activities_endpoint ON fortyguard_activities (endpoint_type);",

    # Heatmap results
    """
    CREATE TABLE IF NOT EXISTS heatmaps (
        id            SERIAL PRIMARY KEY,
        activity_id   TEXT NOT NULL REFERENCES fortyguard_activities (activity_id),
        map_data      JSONB NOT NULL,
        stats_data    JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,

    # Environmental parameters results
    """
    CREATE TABLE IF NOT EXISTS environmental_parameters (
        id            SERIAL PRIMARY KEY,
        activity_id   TEXT NOT NULL REFERENCES fortyguard_activities (activity_id),
        metadata      JSONB NOT NULL,
        locations     JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,

    # Satellite segmentation results
    """
    CREATE TABLE IF NOT EXISTS satellite_segmentations (
        id             SERIAL PRIMARY KEY,
        activity_id    TEXT NOT NULL REFERENCES fortyguard_activities (activity_id),
        coordinates    JSONB NOT NULL,
        original_image JSONB,
        image_year     INTEGER,
        segmentation   JSONB NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Adds the original_image column for installs that already created this
    # table before it existed — CREATE TABLE IF NOT EXISTS alone won't add
    # a column to an existing table, so this covers the upgrade path too.
    "ALTER TABLE satellite_segmentations ADD COLUMN IF NOT EXISTS original_image JSONB;",

    # Street view segmentation results
    """
    CREATE TABLE IF NOT EXISTS streetview_segmentations (
        id            SERIAL PRIMARY KEY,
        activity_id   TEXT NOT NULL REFERENCES fortyguard_activities (activity_id),
        coordinates   JSONB NOT NULL,
        front         JSONB NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,

    # Heat Intelligence reports — we store our own copy of the PDF bytes
    # location (not the temporary signed URL) once downloaded.
    """
    CREATE TABLE IF NOT EXISTS heat_intelligence_reports (
        id            SERIAL PRIMARY KEY,
        activity_id   TEXT NOT NULL REFERENCES fortyguard_activities (activity_id),
        file_path     TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,

    # Derived Features Layer (Phase 5). One row per (monitored city, date).
    # Auto-populated a column at a time whenever a raw heatmap/env-params
    # fetch actually completes (see repository.py) — every later
    # "intelligence" layer (Risk Score, People Impact, Heat Story, ...) is
    # meant to read FROM here instead of re-parsing raw jsonb every time.
    # Columns are nullable and upserted with COALESCE so one signal type
    # arriving (e.g. a tcm heatmap) never clobbers another (e.g. exceedance)
    # already stored for that same city+date.
    """
    CREATE TABLE IF NOT EXISTS location_features (
        id                  SERIAL PRIMARY KEY,
        city_id             TEXT NOT NULL,
        feature_date        DATE NOT NULL,
        -- Hour-scoped fields (mean/max/min temp, heat index, wet bulb,
        -- humidity, AQI) and day-scoped fields (exceedance_hours,
        -- persistence_hours) used to share one row keyed only by
        -- (city_id, feature_date) — a specific hour's heat index sitting
        -- next to a full day's exceedance count, with nothing recording
        -- which hour the heat index was even for. feature_hour makes that
        -- explicit: 'DAY' is a fixed sentinel for the day-scoped row (NULL
        -- can't be used here — Postgres treats every NULL as distinct for
        -- uniqueness, which would let duplicate day-scoped rows through),
        -- any other value ('14:00') is a real hour-scoped row. See
        -- location_features.py for how each analytic/param type maps to
        -- one or the other.
        feature_hour        TEXT NOT NULL DEFAULT 'DAY',
        mean_temp_c         DOUBLE PRECISION,
        max_temp_c          DOUBLE PRECISION,
        min_temp_c          DOUBLE PRECISION,
        exceedance_hours    DOUBLE PRECISION,
        persistence_hours   DOUBLE PRECISION,
        heat_index_c        DOUBLE PRECISION,
        wet_bulb_c          DOUBLE PRECISION,
        humidity_pct        DOUBLE PRECISION,
        aqi                 DOUBLE PRECISION,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT location_features_city_date_hour_key UNIQUE (city_id, feature_date, feature_hour)
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_location_features_city_date ON location_features (city_id, feature_date);",
    # Migrates any pre-existing rows from before feature_hour existed —
    # ADD COLUMN ... DEFAULT 'DAY' above already backfills existing rows
    # to 'DAY' automatically, so no separate UPDATE is needed; this just
    # covers the case where the table pre-dates the column entirely and
    # the UNIQUE constraint needs the column to exist first.
    "ALTER TABLE location_features ADD COLUMN IF NOT EXISTS feature_hour TEXT NOT NULL DEFAULT 'DAY';",
    # The UNIQUE constraint in CREATE TABLE above only applies on a brand
    # new table — CREATE TABLE IF NOT EXISTS no-ops entirely on a table
    # that already exists, so an existing deployment's constraint is still
    # the old (city_id, feature_date) one even after the ADD COLUMN above.
    # Drop whatever unique constraint currently covers exactly
    # (city_id, feature_date) — found by inspecting pg_constraint directly
    # rather than assuming Postgres's default auto-generated name, since
    # that assumption can't be verified against a real server from here —
    # then add the new three-column one under a fixed name. Safe to run on
    # every startup regardless of which state the table is currently in
    # (brand new, pre-feature_hour, or already migrated).
    """
    DO $$
    DECLARE
        old_constraint_name TEXT;
    BEGIN
        SELECT con.conname INTO old_constraint_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'location_features'
          AND con.contype = 'u'
          AND con.conname <> 'location_features_city_date_hour_key'
          AND (
              SELECT array_agg(attname::text ORDER BY attname)
              FROM pg_attribute
              WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
          ) = ARRAY['city_id', 'feature_date']
        LIMIT 1;

        IF old_constraint_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE location_features DROP CONSTRAINT %I', old_constraint_name);
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'location_features_city_date_hour_key'
        ) THEN
            ALTER TABLE location_features
                ADD CONSTRAINT location_features_city_date_hour_key UNIQUE (city_id, feature_date, feature_hour);
        END IF;
    END $$;
    """,

    # Phase 6 — OSM exposure points ("who/what is exposed"). One row per
    # point found for a given AOI signature; re-fetching the same AOI
    # replaces its rows rather than accumulating duplicates forever.
    """
    CREATE TABLE IF NOT EXISTS exposure_points (
        id             SERIAL PRIMARY KEY,
        aoi_signature  TEXT NOT NULL,
        type           TEXT NOT NULL,
        name           TEXT,
        lat            DOUBLE PRECISION NOT NULL,
        lon            DOUBLE PRECISION NOT NULL,
        source         TEXT NOT NULL DEFAULT 'osm',
        fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_exposure_points_signature ON exposure_points (aoi_signature);",

    # Phase 6 — coarse density proxy (buildings / residential landuse /
    # roads) for the same AOI signature. One row per AOI, upserted.
    """
    CREATE TABLE IF NOT EXISTS exposure_density (
        aoi_signature              TEXT PRIMARY KEY,
        building_count             INTEGER NOT NULL DEFAULT 0,
        residential_landuse_count  INTEGER NOT NULL DEFAULT 0,
        road_count                 INTEGER NOT NULL DEFAULT 0,
        fetched_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,

    # Phase 7 — NWS/NOAA active alerts ("is this a real, officially
    # recognized event"). Re-fetching a city replaces its rows — this is a
    # snapshot of what's active NOW, not an append-only history.
    """
    CREATE TABLE IF NOT EXISTS official_alerts (
        id             SERIAL PRIMARY KEY,
        city_id        TEXT NOT NULL,
        alert_type     TEXT NOT NULL,
        severity       TEXT,
        headline       TEXT,
        description    TEXT,
        area_desc      TEXT,
        active_from    TIMESTAMPTZ,
        active_to      TIMESTAMPTZ,
        source         TEXT NOT NULL DEFAULT 'nws',
        fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_official_alerts_city ON official_alerts (city_id);",

    # Cross-process request coordination (see request_coordination.py).
    # A row here means "someone, somewhere, is currently fetching this
    # exact request" — an atomic INSERT ... ON CONFLICT DO NOTHING claim
    # that works correctly across multiple backend workers/replicas,
    # replacing what used to be a single-process-only in-memory lock.
    """
    CREATE TABLE IF NOT EXISTS in_progress_requests (
        endpoint_type      TEXT NOT NULL,
        request_signature  TEXT NOT NULL,
        claimed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (endpoint_type, request_signature)
    );
    """,

    # Phase 3 fix: Heat Intelligence jobs. The roadmap's own spec says
    # "Slow endpoints (Heat Intelligence) return a job id; frontend polls
    # our status" — this table is what makes that literally true, instead
    # of the request itself blocking open for however long FortyGuard
    # takes (which the docs say can be several minutes).
    """
    CREATE TABLE IF NOT EXISTS heat_intelligence_jobs (
        job_id             UUID PRIMARY KEY,
        request_signature  TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'queued',
        activity_id        TEXT,
        file_path          TEXT,
        error              TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_heat_intelligence_jobs_signature ON heat_intelligence_jobs (request_signature);",

    # Phase 11 — Heat Story. Caches the generated narrative per exact
    # inputs that produced it, since a Groq call has real latency and
    # cost — re-opening the same story shouldn't regenerate it.
    # `input_fingerprint` (not just city_id+feature_date) is what makes
    # this actually safe to cache: Heat Story's observed hours grow
    # through the day (see heat_story.expected_hours) and its forecast
    # array is caller-supplied per request (routers/heat_story.py never
    # persists forecast anywhere it could read back later — see
    # repository.get_heatmap's `persist` param) — so the SAME city/date
    # can legitimately need a fresh narrative several times in one day.
    # Hashing the actual observed+forecast content into the cache key
    # means a stale cache entry can never be served once new data
    # arrives, without needing an explicit invalidation step anywhere.
    """
    CREATE TABLE IF NOT EXISTS heat_stories (
        id                 SERIAL PRIMARY KEY,
        city_id            TEXT NOT NULL,
        feature_date       DATE NOT NULL,
        input_fingerprint  TEXT NOT NULL,
        narrative          JSONB NOT NULL,
        model              TEXT NOT NULL,
        generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT heat_stories_city_date_fingerprint_key UNIQUE (city_id, feature_date, input_fingerprint)
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_heat_stories_city_date ON heat_stories (city_id, feature_date);",
    # CREATE TABLE IF NOT EXISTS above only applies on a brand new
    # database — a deployment whose heat_stories table pre-dates
    # input_fingerprint (added after the table was first created) never
    # gets the column, and every /narrate call then fails with
    # asyncpg.exceptions.UndefinedColumnError: column "input_fingerprint"
    # does not exist. The empty-string default is safe here specifically
    # because it can never collide with a real fingerprint (routers/
    # heat_story.py's _input_fingerprint always hashes real content into a
    # non-empty hex digest), so any pre-existing rows just end up
    # uncacheable under the new key rather than colliding with fresh ones.
    "ALTER TABLE heat_stories ADD COLUMN IF NOT EXISTS input_fingerprint TEXT NOT NULL DEFAULT '';",
    # The reverse case of the migration above: an existing deployment's
    # heat_stories table can carry columns from an EARLIER version of
    # this table that the current code no longer knows about at all (e.g.
    # a since-removed `compare_date` column) — nothing in this codebase
    # references such columns, so the INSERT in routers/heat_story.py
    # never supplies a value for them, and if they're still NOT NULL with
    # no default, every single narrate() call fails with
    # asyncpg.exceptions.NotNullViolationError. Rather than hunting down
    # each historical column by name, relax any NOT NULL constraint on a
    # column outside the current schema so old rows/tables stop blocking
    # new inserts — this never touches the columns the code actually
    # reads/writes (city_id, feature_date, input_fingerprint, narrative,
    # model, generated_at, id), only anything left over beyond them.
    """
    DO $$
    DECLARE
        stale_col TEXT;
    BEGIN
        FOR stale_col IN
            SELECT attname FROM pg_attribute
            WHERE attrelid = 'heat_stories'::regclass
              AND attnum > 0 AND NOT attisdropped
              AND attname NOT IN (
                  'id', 'city_id', 'feature_date', 'input_fingerprint',
                  'narrative', 'model', 'generated_at'
              )
        LOOP
            EXECUTE format('ALTER TABLE heat_stories ALTER COLUMN %I DROP NOT NULL', stale_col);
        END LOOP;
    END $$;
    """,
    # Same reasoning as location_features' migration above: the UNIQUE
    # constraint from CREATE TABLE also only applies to a brand-new table,
    # so an existing deployment's constraint (if heat_stories pre-dates
    # input_fingerprint) is still the old (city_id, feature_date) one even
    # after the ADD COLUMN. Find it by its actual columns rather than
    # assuming Postgres's auto-generated name, and replace it with the
    # three-column constraint the code actually relies on for its
    # ON CONFLICT (city_id, feature_date, input_fingerprint) DO NOTHING.
    """
    DO $$
    DECLARE
        old_constraint_name TEXT;
    BEGIN
        SELECT con.conname INTO old_constraint_name
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'heat_stories'
          AND con.contype = 'u'
          AND con.conname <> 'heat_stories_city_date_fingerprint_key'
          AND (
              SELECT array_agg(attname::text ORDER BY attname)
              FROM pg_attribute
              WHERE attrelid = con.conrelid AND attnum = ANY(con.conkey)
          ) = ARRAY['city_id', 'feature_date']
        LIMIT 1;

        IF old_constraint_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE heat_stories DROP CONSTRAINT %I', old_constraint_name);
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'heat_stories_city_date_fingerprint_key'
        ) THEN
            ALTER TABLE heat_stories
                ADD CONSTRAINT heat_stories_city_date_fingerprint_key UNIQUE (city_id, feature_date, input_fingerprint);
        END IF;
    END $$;
    """,

    # Phase 14 — City-to-City Comparison. Mirrors seed_historical.py's own
    # CREATE_TABLE_SQL exactly (that script is deliberately standalone and
    # creates this same table in its own separate database — see that
    # script's docstring). Declaring it here too means the live app's
    # normal init_db() startup keeps this table verified/created in the
    # MAIN database as well, the same way every other table above is —
    # no separate manual step needed once historical rows have been
    # migrated in via scripts/migrate_historical_from_neon.py. Fully
    # isolated: nothing else in this file references or joins against it,
    # so `DROP TABLE IF EXISTS historical_heat_data;` alone fully removes
    # this feature with zero effect on anything else.
    """
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
    """,
    "CREATE INDEX IF NOT EXISTS idx_historical_city_date ON historical_heat_data (city_id, feature_date);",
    "CREATE INDEX IF NOT EXISTS idx_historical_analytic_type ON historical_heat_data (analytic_type);",

    # Phase 11 — Heat Story forecast log. Deliberately its OWN table, never
    # location_features: location_features is the canonical OBSERVED store
    # (see location_features.py's module docstring and repository.py's
    # `persist` parameter) — a forecast is explicitly not an observation,
    # and must never be readable back as if it were one (that's the whole
    # reason forecast fetches use persist=False against location_features
    # in the first place). This table exists purely so a forecast the user
    # explicitly requested is actually kept somewhere queryable instead of
    # living only in the browser tab's React state, without blurring that
    # observed/forecast line. UNIQUE + upsert: a later re-fetch of the same
    # city/date/hour (the forecast for a given hour can genuinely change
    # the closer it gets) updates the row rather than accumulating stale
    # duplicates.
    """
    CREATE TABLE IF NOT EXISTS heat_story_forecasts (
        id              SERIAL PRIMARY KEY,
        city_id         TEXT NOT NULL,
        feature_date    DATE NOT NULL,
        feature_hour    TEXT NOT NULL,
        temperature_c   DOUBLE PRECISION,
        fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (city_id, feature_date, feature_hour)
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_heat_story_forecasts_city_date ON heat_story_forecasts (city_id, feature_date);",

    # Phase 12.5 boundary enforcement — one cached admin-boundary polygon
    # per monitored city (see city_boundary_repository.py). UNIQUE on
    # city_id since there's exactly one boundary per city; a refresh is
    # an upsert, not a growing history.
    """
    CREATE TABLE IF NOT EXISTS city_boundaries (
        city_id           TEXT PRIMARY KEY,
        boundary_geojson  JSONB NOT NULL,
        fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    # Phase 12.5 — whole-response cache for POST /api/routes (see
    # route_query_cache.py). cache_key is a hash of the grid-snapped
    # origin/destination/hour-bucket/heat_weight; UNIQUE lets a repeat or
    # nearby request upsert the same row instead of accumulating one row
    # per near-duplicate query forever.
    """
    CREATE TABLE IF NOT EXISTS route_query_cache (
        id                      SERIAL PRIMARY KEY,
        cache_key               TEXT UNIQUE NOT NULL,
        city_id                 TEXT NOT NULL,
        origin_lat              DOUBLE PRECISION NOT NULL,
        origin_lon              DOUBLE PRECISION NOT NULL,
        destination_lat         DOUBLE PRECISION NOT NULL,
        destination_lon         DOUBLE PRECISION NOT NULL,
        departure_hour_bucket   TEXT NOT NULL,
        result                  JSONB NOT NULL,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    """,
    "CREATE INDEX IF NOT EXISTS idx_route_query_cache_city ON route_query_cache (city_id, created_at);",
    # Phase 12.5g — per-city/category cache for POI shortcut lookups
    # (see poi_repository.py). UNIQUE(city_id, category) — a refresh is
    # an upsert, same pattern as city_boundaries above, not a growing
    # history of every Overpass call ever made.
    """
    CREATE TABLE IF NOT EXISTS poi_cache (
        city_id     TEXT NOT NULL,
        category    TEXT NOT NULL,
        points      JSONB NOT NULL,
        fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (city_id, category)
    );
    """,
]


async def init_db() -> None:
    global _pool
    await _ensure_database_exists()
    _pool = await asyncpg.create_pool(
        host=settings.POSTGRES_HOST,
        port=settings.POSTGRES_PORT,
        user=settings.POSTGRES_USER,
        password=settings.POSTGRES_PASSWORD,
        database=settings.POSTGRES_DB,
        min_size=1,
        max_size=10,
    )
    async with _pool.acquire() as conn:
        for statement in DDL_STATEMENTS:
            await conn.execute(statement)
    log_db("All tables verified/created successfully")


async def close_db() -> None:
    if _pool is not None:
        await _pool.close()


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        log_err("Database pool accessed before init_db() completed")
        raise RuntimeError("Database pool not initialized")
    return _pool