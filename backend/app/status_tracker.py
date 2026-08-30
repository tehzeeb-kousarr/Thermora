"""
Lightweight in-process tracker for FortyGuard connectivity.

Every submit/poll call in fortyguard_client.py reports success or failure
here. The /api/status route reads this to tell the frontend whether
FortyGuard is actually responding right now — not just whether the
backend process is alive (that's what /api/health is for).
"""
import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_state = {
    "last_success_at": None,
    "last_error_at": None,
    "last_error": None,
    "consecutive_errors": 0,
}


def record_success() -> None:
    with _lock:
        _state["last_success_at"] = datetime.now(timezone.utc).isoformat()
        _state["consecutive_errors"] = 0


def record_error(message: str) -> None:
    with _lock:
        _state["last_error_at"] = datetime.now(timezone.utc).isoformat()
        _state["last_error"] = message
        _state["consecutive_errors"] += 1


def get_status() -> dict:
    with _lock:
        snapshot = dict(_state)

    # "live" = at least one call has ever succeeded AND we're not currently
    # in a run of failures. "degraded" = has succeeded before but the most
    # recent calls are failing. "unknown" = no calls made yet this process.
    if snapshot["last_success_at"] is None and snapshot["last_error_at"] is None:
        fortyguard_status = "unknown"
    elif snapshot["consecutive_errors"] == 0:
        fortyguard_status = "live"
    elif snapshot["last_success_at"] is None:
        fortyguard_status = "down"
    else:
        fortyguard_status = "degraded"

    return {"fortyguard_status": fortyguard_status, **snapshot}
