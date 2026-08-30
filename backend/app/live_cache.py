"""
In-memory "latest known summary" per monitored city, written by the
background scheduler and read by a cheap GET endpoint.

Deliberately NOT the Postgres cache (repository.py) — that's keyed by
exact request signature and meant for full-fidelity results. This is a
tiny, always-current snapshot purely for list/compare-style views that
just need "roughly how hot is it right now in city X", refreshed on a
fixed cadence in the background rather than on every page view.
"""
import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_latest: dict[str, dict] = {}


def set_latest(city_id: str, heatmap: dict, env_params: dict, alerts: list[dict] | None = None) -> None:
    with _lock:
        _latest[city_id] = {
            "heatmap": heatmap,
            "envParams": env_params,
            "alerts": alerts or [],
            "updatedAt": datetime.now(timezone.utc).isoformat(),
        }


def get_latest(city_id: str) -> dict | None:
    with _lock:
        return _latest.get(city_id)


def all_latest() -> dict:
    with _lock:
        return dict(_latest)
