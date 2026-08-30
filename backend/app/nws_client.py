"""
Phase 7 — NWS/NOAA Integration.

Answers "is this an officially recognized heat event?" — the VERIFY step.
Thermora doesn't have its own Risk Score yet (that's Phase 8), so right
now this is the only "is this real" signal in the app; it's deliberately
kept separate and clearly source-labeled so it's never confused with a
Thermora-computed estimate later.
"""
import asyncio
import random
from datetime import datetime, timezone

import httpx

from .config import settings
from .logger import log_req, log_res, log_err


class NWSError(Exception):
    """Raised on any failure to actually reach/parse NWS — network error,
    or a non-200 that survives the retry loop below. Necessary so callers
    (alerts_repository.get_alerts) can tell 'confirmed zero alerts' apart
    from 'couldn't check'. Previously both returned [] identically, which
    made alerts_repository silently overwrite a city's last-known real
    alerts with nothing whenever NWS was just briefly unreachable — the
    exact failure mode its own stale-cache fallback exists to prevent,
    made unreachable by this module never actually raising into it."""


def _headers() -> dict:
    # NWS requires a descriptive User-Agent identifying the calling app;
    # unlike FortyGuard there's no API key at all — this header IS the auth.
    return {"User-Agent": settings.NWS_USER_AGENT, "Accept": "application/geo+json"}


def _is_transient(status_code: int) -> bool:
    # Same reasoning as fortyguard_client._is_transient: 429 (NWS does
    # document rate limits) and 5xx are worth a short retry; 400s aren't —
    # a malformed point parameter will fail identically every time.
    return status_code == 429 or status_code >= 500


def _retry_delay(attempt: int, resp: httpx.Response | None = None) -> float:
    if resp is not None:
        retry_after = resp.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after), settings.NWS_RETRY_MAX_DELAY_SECONDS)
            except ValueError:
                pass
    base = settings.NWS_RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
    capped = min(base, settings.NWS_RETRY_MAX_DELAY_SECONDS)
    return capped * (0.75 + random.random() * 0.5)


def _parse_datetime(value: str | None) -> datetime | None:
    """NWS returns ISO 8601 timestamps as strings (e.g.
    '2026-08-22T11:15:00-05:00'). asyncpg needs actual datetime objects for
    TIMESTAMPTZ columns — passing the raw string raises 'expected a
    datetime.date or datetime.datetime instance, got str'. Parse once here,
    at the point the data enters the system, so every downstream consumer
    (repository, schemas) already has real datetimes."""
    if not value:
        return None
    try:
        # datetime.fromisoformat handles '+HH:MM'/'-HH:MM' offsets natively;
        # NWS occasionally uses a bare 'Z' suffix which fromisoformat only
        # accepts on Python 3.11+, so normalize it defensively.
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        log_err("Could not parse NWS timestamp", {"value": value})
        return None


def _parse_alert(feature: dict) -> dict:
    props = feature.get("properties", {})
    return {
        "alert_type": props.get("event") or "Unknown",
        "severity": props.get("severity"),
        "headline": props.get("headline"),
        "description": props.get("description"),
        "area_desc": props.get("areaDesc"),
        "active_from": _parse_datetime(props.get("onset") or props.get("effective") or props.get("sent")),
        "active_to": _parse_datetime(props.get("ends") or props.get("expires")),
        "source": "nws",
    }


async def fetch_active_alerts(lat: float, lon: float) -> list[dict]:
    """Live point-based query against NWS's public alerts endpoint. No
    submit/poll lifecycle like FortyGuard — but it IS worth a bounded
    retry on 429/5xx, which this previously had none of at all."""
    url = f"{settings.NWS_BASE_URL}/alerts/active"
    params = {"point": f"{lat},{lon}"}
    log_req(f"GET {url}", params)

    resp: httpx.Response | None = None
    for attempt in range(1, settings.NWS_RETRY_MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.get(url, headers=_headers(), params=params, timeout=15)
        except httpx.RequestError as exc:
            log_err("Network error contacting NWS", {"error": str(exc)})
            # Raise rather than degrade to [] here — that decision belongs
            # to alerts_repository, which can fall back to a
            # stale-but-real cached copy instead of overwriting known
            # alerts with a false "all clear".
            raise NWSError(f"Network error contacting NWS: {exc}") from exc

        if resp.status_code == 200:
            break
        if _is_transient(resp.status_code) and attempt < settings.NWS_RETRY_MAX_ATTEMPTS:
            delay = _retry_delay(attempt, resp)
            log_err(f"NWS returned {resp.status_code} — backing off {delay:.1f}s "
                     f"(attempt {attempt}/{settings.NWS_RETRY_MAX_ATTEMPTS})", {"status_code": resp.status_code})
            await asyncio.sleep(delay)
            continue
        break

    if resp is None or resp.status_code != 200:
        log_err("NWS returned a non-200 response", {
            "status_code": resp.status_code if resp else None,
            "body": resp.text[:300] if resp else None,
        })
        raise NWSError(
            f"NWS returned {resp.status_code if resp else 'no response'} "
            f"after {settings.NWS_RETRY_MAX_ATTEMPTS} attempt(s)"
        )

    body = resp.json()
    alerts = [_parse_alert(f) for f in body.get("features", [])]
    log_res("NWS alerts fetched", {"count": len(alerts), "fetched_at": datetime.now(timezone.utc).isoformat()})
    return alerts