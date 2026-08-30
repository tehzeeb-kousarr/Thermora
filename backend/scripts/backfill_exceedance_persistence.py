"""
One-off backfill for the location_features.py flat-vs-nested stats_data
fix (see that module's record_heatmap_result docstring for the full
root-cause explanation).

Every exceedance/persistence heatmap fetch that completed BEFORE the fix
was silently dropped: the old code only ever looked for
stats_data["temperature_stats"]["mean"], but FortyGuard returns those two
analytic types with stats_data FLAT (mean sits at the top level, no
temperature_stats wrapper). record_heatmap_result() is fixed now, but it
only runs on a genuine NEW completion — a cache hit (repository.py's
_try_heatmap_cache) never calls it again. So an activity that already
completed and is sitting in Postgres's heatmaps table won't self-heal
just from restarting the backend; it needs to be reprocessed once.

This script re-runs every already-completed exceedance/persistence
activity through the now-fixed record_heatmap_result(), reading stats_data
straight from the `heatmaps` table already in Postgres. It makes ZERO
FortyGuard requests and burns ZERO credits.

Usage:
    cd backend
    python scripts/backfill_exceedance_persistence.py
"""
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db import init_db, close_db, get_pool  # noqa: E402
from app import location_features  # noqa: E402


async def main() -> None:
    await init_db()
    pool = get_pool()

    rows = await pool.fetch(
        """
        SELECT fa.activity_id, fa.request_payload, h.stats_data
        FROM fortyguard_activities fa
        JOIN heatmaps h ON h.activity_id = fa.activity_id
        WHERE fa.endpoint_type = 'heatmap'
          AND fa.status = 'Completed'
          AND fa.request_payload->>'analytic_type' IN ('exceedance', 'persistence')
        """
    )
    print(f"Found {len(rows)} completed exceedance/persistence activities to reprocess")

    for row in rows:
        payload = json.loads(row["request_payload"])
        stats_data = json.loads(row["stats_data"])
        await location_features.record_heatmap_result(payload, stats_data)
        print(f"  reprocessed {row['activity_id']} "
              f"({payload.get('analytic_type')}, {payload.get('date_time', {}).get('start_date')})")

    print("Done. location_features rows with feature_hour='DAY' should now have "
          "exceedance_hours/persistence_hours populated for these dates.")
    await close_db()


if __name__ == "__main__":
    asyncio.run(main())