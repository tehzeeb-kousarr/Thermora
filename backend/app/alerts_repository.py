"""
Phase 7 repository — caches NWS active alerts per monitored city.

Alerts genuinely change (that's the point), so this is a short TTL
(ALERTS_CACHE_MINUTES, default 10) rather than the long OSM-style cache —
just enough to stop every page view from re-hitting NWS.
"""
from datetime import datetime, timezone

from . import nws_client
from .config import settings
from .db import get_pool
from .logger import log_db, log_err


def _is_fresh(fetched_at: datetime) -> bool:
    age_minutes = (datetime.now(timezone.utc) - fetched_at).total_seconds() / 60
    return age_minutes < settings.ALERTS_CACHE_MINUTES


async def _load_cached(city_id: str) -> tuple[list[dict], datetime] | None:
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT * FROM official_alerts WHERE city_id = $1 ORDER BY fetched_at DESC", city_id
    )
    if not rows:
        return None
    fetched_at = rows[0]["fetched_at"]
    if not _is_fresh(fetched_at):
        return None
    alerts = [
        {
            "alert_type": r["alert_type"], "severity": r["severity"], "headline": r["headline"],
            "description": r["description"], "area_desc": r["area_desc"],
            "active_from": r["active_from"].isoformat() if r["active_from"] else None,
            "active_to": r["active_to"].isoformat() if r["active_to"] else None,
            "source": r["source"],
        }
        for r in rows
    ]
    return alerts, fetched_at


async def _store(city_id: str, alerts: list[dict]) -> None:
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # A city's alert set is "what's active right now", not
            # append-only history — replace rather than accumulate.
            await conn.execute("DELETE FROM official_alerts WHERE city_id = $1", city_id)
            for a in alerts:
                await conn.execute(
                    """
                    INSERT INTO official_alerts
                        (city_id, alert_type, severity, headline, description, area_desc,
                         active_from, active_to, source)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    """,
                    city_id, a["alert_type"], a.get("severity"), a.get("headline"),
                    a.get("description"), a.get("area_desc"),
                    a.get("active_from"), a.get("active_to"), a.get("source", "nws"),
                )
    log_db(f"Stored {len(alerts)} alert(s) for {city_id}")


async def get_alerts(city: dict, force_refresh: bool = False) -> dict:
    city_id = city["id"]

    if not force_refresh:
        cached = await _load_cached(city_id)
        if cached is not None:
            alerts, fetched_at = cached
            log_db(f"Alerts cache hit for {city_id}")
            return {"alerts": alerts, "fetched_at": fetched_at.isoformat()}

    try:
        alerts = await nws_client.fetch_active_alerts(city["lat"], city["lon"])
    except Exception as exc:  # noqa: BLE001
        log_err("NWS alerts fetch failed", {"city_id": city_id, "error": str(exc)})
        stale = await _load_cached_ignoring_freshness(city_id)
        if stale is not None:
            alerts, fetched_at = stale
            return {"alerts": alerts, "fetched_at": fetched_at.isoformat(), "stale": True}
        raise

    await _store(city_id, alerts)
    return {"alerts": alerts, "fetched_at": datetime.now(timezone.utc).isoformat()}


async def _load_cached_ignoring_freshness(city_id: str) -> tuple[list[dict], datetime] | None:
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT * FROM official_alerts WHERE city_id = $1 ORDER BY fetched_at DESC", city_id
    )
    if not rows:
        return None
    alerts = [
        {
            "alert_type": r["alert_type"], "severity": r["severity"], "headline": r["headline"],
            "description": r["description"], "area_desc": r["area_desc"],
            "active_from": r["active_from"].isoformat() if r["active_from"] else None,
            "active_to": r["active_to"].isoformat() if r["active_to"] else None,
            "source": r["source"],
        }
        for r in rows
    ]
    return alerts, rows[0]["fetched_at"]
