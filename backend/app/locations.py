"""
The fixed set of cities the background scheduler keeps warm.

MUST stay in sync with frontend/src/data/cities.js — same ids, same
coordinates, same `timezone`. Duplicated rather than shared because
frontend and backend are separate deployable units; if you add a city,
add it in both places.
"""
from datetime import date as date_cls, datetime
from zoneinfo import ZoneInfo

MONITORED_CITIES = [
    {"id": "dfw", "name": "Dallas–Fort Worth", "state": "Texas", "lat": 32.7767, "lon": -96.7970, "timezone": "America/Chicago"},
    {"id": "houston", "name": "Houston", "state": "Texas", "lat": 29.7604, "lon": -95.3698, "timezone": "America/Chicago"},
    {"id": "austin", "name": "Austin", "state": "Texas", "lat": 30.2672, "lon": -97.7431, "timezone": "America/Chicago"},
    {"id": "san-antonio", "name": "San Antonio", "state": "Texas", "lat": 29.4241, "lon": -98.4936, "timezone": "America/Chicago"},
    # Arizona doesn't observe DST — "America/Phoenix" is a fixed UTC-7
    # offset year-round, unlike "America/Denver". Using the Mountain-time
    # zone name here would silently be an hour wrong for half the year.
    {"id": "phoenix", "name": "Phoenix", "state": "Arizona", "lat": 33.4484, "lon": -112.0740, "timezone": "America/Phoenix"},
    {"id": "miami", "name": "Miami", "state": "Florida", "lat": 25.7617, "lon": -80.1918, "timezone": "America/New_York"},
]


def get_city(city_id: str) -> dict | None:
    return next((c for c in MONITORED_CITIES if c["id"] == city_id), None)


def nearest_city(lat: float, lon: float, max_distance_deg: float = 0.08) -> dict | None:
    """Finds the MONITORED_CITY closest to (lat, lon), or None if nothing is
    within `max_distance_deg` (~9km at these latitudes). Used to attribute a
    raw FortyGuard fetch — which only carries coordinates, not a city_id —
    back to a known monitored location for the derived-features layer.
    Simple planar distance is fine at city scale; no need for haversine."""
    best: dict | None = None
    best_dist = None
    for city in MONITORED_CITIES:
        dist = ((city["lat"] - lat) ** 2 + (city["lon"] - lon) ** 2) ** 0.5
        if best_dist is None or dist < best_dist:
            best, best_dist = city, dist
    if best is not None and best_dist is not None and best_dist <= max_distance_deg:
        return best
    return None


# --- City-local time ------------------------------------------------------
#
# Every monitored city is hours behind UTC (all US, per MONITORED_CITIES
# above). A bare `date.today()`/`datetime.now()` on the server uses the
# SERVER's own clock — in practice UTC in most deployments — which can
# genuinely name a different calendar day than what it currently is where
# the city actually is (e.g. 8pm in Houston is already past midnight UTC —
# `date.today()` there names TOMORROW relative to Houston's real "today").
#
# This used to be defined only inside heat_story.py (as city_local_now/
# local_today) and used only by Phase 11's own endpoints — every other
# module that needs "today" for a city (the scheduler's on-demand summary
# loader, Risk/Impact/Emergency's default-date routers) independently
# called bare date.today()/date_cls.today() instead. Two different "todays"
# for the same city meant: the scheduler could write location_features
# under one calendar date while Risk/Impact/Emergency/Heat Story looked
# for (or wrote) a DIFFERENT one, depending on time of day and which
# module you asked — data that had genuinely just been fetched could look
# entirely missing to a different endpoint reading it back. Centralized
# here (locations.py, not heat_story.py) since this is foundational to any
# module that reads/writes location_features by date, not a Phase
# 11-specific concern — heat_story.py now imports these from here instead
# of defining its own copy.
def city_local_now(city: dict) -> datetime:
    """The one place any module should ask "what time is it right now,
    for this city" — call this (or local_today() below) instead of
    datetime.now()/date.today() directly, so there's exactly one
    local-time conversion to ever get right."""
    return datetime.now(ZoneInfo(city["timezone"]))


def local_today(city: dict) -> date_cls:
    return city_local_now(city).date()