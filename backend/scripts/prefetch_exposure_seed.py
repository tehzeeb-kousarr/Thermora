"""
Run this once (or occasionally) whenever the public Overpass mirrors
happen to be reachable, to populate app/data/exposure_seed.json with
REAL data for the 6 monitored cities — used only as a last-resort
offline fallback if Overpass is ever down when the live app needs it.

This does not fabricate anything: it calls the exact same
osm_client.fetch_exposure() the live app uses, for the exact same AOI
(±0.01°, matching frontend/src/data/cities.js's defaultBBoxForCity), and
saves whatever comes back for real.

Usage:
    cd backend
    python scripts/prefetch_exposure_seed.py
"""
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app import osm_client  # noqa: E402
from app.exposure_repository import aoi_signature  # noqa: E402
from app.locations import MONITORED_CITIES  # noqa: E402

HALF_WIDTH_DEG = 0.01  # must match frontend/src/data/cities.js defaultBBoxForCity
SEED_PATH = Path(__file__).parent.parent / "app" / "data" / "exposure_seed.json"


async def main() -> None:
    seed: dict = {}
    if SEED_PATH.exists():
        try:
            seed = json.loads(SEED_PATH.read_text())
        except json.JSONDecodeError:
            seed = {}

    for city in MONITORED_CITIES:
        min_lat, max_lat = city["lat"] - HALF_WIDTH_DEG, city["lat"] + HALF_WIDTH_DEG
        min_lng, max_lng = city["lon"] - HALF_WIDTH_DEG, city["lon"] + HALF_WIDTH_DEG
        signature = aoi_signature(min_lat, min_lng, max_lat, max_lng)

        print(f"Fetching {city['name']}...")
        try:
            result = await osm_client.fetch_exposure(min_lat, min_lng, max_lat, max_lng)
        except Exception as exc:  # noqa: BLE001
            print(f"  FAILED ({exc}) — leaving any existing seed entry for this city untouched")
            continue

        seed[signature] = {
            "points": result["points"],
            "density": result["density"],
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        print(f"  OK — {len(result['points'])} points, density={result['density']}")

    SEED_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEED_PATH.write_text(json.dumps(seed, indent=2))
    print(f"\nWrote {len(seed)} seed entries to {SEED_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
