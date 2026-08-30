"""
Thin, reusable client for the FortyGuard Enterprise API.

Every endpoint follows the same async lifecycle:
  POST /v1/<endpoint>          -> { data: { activity_id } }
  GET  /v1/status/<activity_id> (poll) -> Processing | Completed | Failed

This module owns that lifecycle so callers just get back a finished result
(or a clear exception) instead of dealing with polling themselves.
"""
import asyncio
import hashlib
import json
import random
import time
from typing import Any

import httpx

from .config import settings
from .logger import log_req, log_res, log_poll, log_err
from . import status_tracker


class FortyGuardError(Exception):
    def __init__(self, message: str, status_code: int | None = None, activity_id: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        # Set only when the error happened AFTER a real activity_id was
        # already assigned by FortyGuard (i.e. failed/timed out while
        # polling, not while submitting). Lets callers tell the two apart
        # instead of assuming every FortyGuardError means "nothing was ever
        # created" — see repository.py's _heatmap_job for why that
        # assumption was wrong and silently threw away real activity_ids.
        self.activity_id = activity_id


class FortyGuardValidationError(FortyGuardError):
    """Raised for input problems we catch BEFORE ever calling FortyGuard,
    so we never waste credits on requests we already know are invalid."""


def request_signature(endpoint: str, payload: dict, salt: str | None = None) -> str:
    """Deterministic fingerprint of a request, used for caching lookups.

    `salt`, when given, is folded into the hash but is NEVER part of
    `payload` itself and never gets sent to FortyGuard — it exists purely
    to let two callers with an otherwise byte-identical payload land in
    different cache buckets. Phase 11 (Heat Story) needs exactly this: a
    forecast request for "16:00" and, two hours later, a genuine observed
    request for that same "16:00" build the IDENTICAL payload (same AOI,
    same date, same start_time) — without a salt they'd collide on the
    same signature, and the observed fetch would silently be served the
    stale forecast value back out of cache instead of a fresh FortyGuard
    call. See repository.get_heatmap's `persist` parameter."""
    canonical = json.dumps(payload, sort_keys=True)
    key = f"{endpoint}:{canonical}"
    if salt:
        key = f"{key}:{salt}"
    digest = hashlib.sha256(key.encode()).hexdigest()
    return digest


def _headers() -> dict:
    return {
        "api-key": settings.FORTYGUARD_API_KEY,
        "Content-Type": "application/json",
    }


def _validate_bbox(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> None:
    """Reject degenerate / inverted bounding boxes before they ever reach
    FortyGuard. Caught a real bug in manual testing where min == max on
    both axes, producing a zero-area polygon."""
    if max_lat <= min_lat or max_lng <= min_lng:
        raise FortyGuardValidationError(
            f"Invalid bounding box: max_lat/max_lng must be strictly greater than "
            f"min_lat/min_lng (got min=({min_lat},{min_lng}), max=({max_lat},{max_lng}))"
        )


def bbox_to_polygon_aoi(min_lat: float, min_lng: float, max_lat: float, max_lng: float) -> dict:
    _validate_bbox(min_lat, min_lng, max_lat, max_lng)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[
                        [min_lng, min_lat],
                        [max_lng, min_lat],
                        [max_lng, max_lat],
                        [min_lng, max_lat],
                        [min_lng, min_lat],
                    ]],
                },
            }
        ],
    }


def _retry_delay(attempt: int, resp: httpx.Response | None = None) -> float:
    """Exponential backoff with jitter, capped at RETRY_MAX_DELAY_SECONDS.
    Honors a Retry-After header (seconds form) when the server sent one —
    the common case for 429s — otherwise backs off 2^attempt * base."""
    if resp is not None:
        retry_after = resp.headers.get("retry-after")
        if retry_after:
            try:
                return min(float(retry_after), settings.RETRY_MAX_DELAY_SECONDS)
            except ValueError:
                pass
    base = settings.RETRY_BASE_DELAY_SECONDS * (2 ** (attempt - 1))
    capped = min(base, settings.RETRY_MAX_DELAY_SECONDS)
    return capped * (0.75 + random.random() * 0.5)  # +/-25% jitter


def _is_transient(status_code: int) -> bool:
    """429 (rate limit) and 5xx (server-side) are worth retrying;
    400/401/403/404 on submission are not — retrying a bad request just
    burns time and still fails."""
    return status_code == 429 or status_code >= 500


async def _submit(client: httpx.AsyncClient, endpoint: str, payload: dict) -> str:
    url = f"{settings.FORTYGUARD_BASE_URL}/{endpoint}"
    log_req(f"POST {url}", payload)

    resp: httpx.Response | None = None
    for attempt in range(1, settings.RETRY_MAX_ATTEMPTS + 1):
        try:
            resp = await client.post(url, headers=_headers(), json=payload, timeout=30)
        except httpx.RequestError as exc:
            # A connection-level failure (DNS hiccup, momentary drop, "all
            # connection attempts failed") is exactly the kind of thing
            # retrying helps with — arguably more so than an HTTP error
            # response, since it's often a few-second network blip. This
            # used to raise immediately on the very first such failure,
            # bypassing this loop's retry/backoff entirely, while an
            # actual 429/5xx response a line below got multiple retries.
            # That was backwards: the one failure retrying is MOST likely
            # to fix got NONE of the retry protection every other failure
            # already had.
            log_err(f"Network error submitting to {endpoint} — attempt {attempt}/{settings.RETRY_MAX_ATTEMPTS}",
                    {"error": str(exc)})
            status_tracker.record_error(f"network error: {exc}")
            if attempt < settings.RETRY_MAX_ATTEMPTS:
                delay = _retry_delay(attempt, None)
                await asyncio.sleep(delay)
                continue
            raise FortyGuardError(f"Network error contacting FortyGuard: {exc}") from exc

        if resp.status_code == 200:
            break
        if _is_transient(resp.status_code) and attempt < settings.RETRY_MAX_ATTEMPTS:
            delay = _retry_delay(attempt, resp)
            log_err(f"{endpoint} submission got {resp.status_code} — backing off {delay:.1f}s "
                    f"(attempt {attempt}/{settings.RETRY_MAX_ATTEMPTS})", {"status_code": resp.status_code})
            status_tracker.record_error(f"{endpoint} submission got {resp.status_code}, retrying")
            await asyncio.sleep(delay)
            continue
        break  # non-transient error, or retries exhausted — fall through to raise below

    if resp.status_code != 200:
        log_err(f"FortyGuard rejected {endpoint} submission", {
            "status_code": resp.status_code, "body": _safe_json(resp),
        })
        status_tracker.record_error(f"{endpoint} submission returned {resp.status_code}")
        raise FortyGuardError(
            f"FortyGuard returned {resp.status_code} for {endpoint}: {resp.text}",
            status_code=resp.status_code,
        )

    body = resp.json()
    activity_id = body.get("data", {}).get("activity_id")
    if not activity_id:
        log_err(f"No activity_id in {endpoint} response", body)
        status_tracker.record_error(f"{endpoint} response missing activity_id")
        raise FortyGuardError(f"FortyGuard response for {endpoint} missing activity_id")

    log_res("Request submitted successfully", body)
    status_tracker.record_success()
    return activity_id


def _redact_signed_urls(body: dict) -> dict:
    """Deep-copies `body` with any `download_link` value masked before it's
    ever logged. Heat Intelligence's doc is explicit: 'do not log or share
    the full signed URL' — but the completed poll response has no separate
    'safe' view, the signed URL is just a field inside the same body we log
    for every other endpoint too. This is the one redaction point that
    covers it without special-casing heat_intelligence throughout _poll."""
    def scrub(obj):
        if isinstance(obj, dict):
            return {k: ("<redacted>" if k == "download_link" and isinstance(v, str) else scrub(v))
                    for k, v in obj.items()}
        if isinstance(obj, list):
            return [scrub(v) for v in obj]
        return obj
    return scrub(body)


async def _poll(client: httpx.AsyncClient, activity_id: str) -> dict:
    url = f"{settings.FORTYGUARD_BASE_URL}/status/{activity_id}"
    log_poll(f"Polling activity {activity_id}")

    consecutive_transient_errors = 0

    for attempt in range(1, settings.POLL_MAX_ATTEMPTS + 1):
        try:
            resp = await client.get(url, headers=_headers(), timeout=30)
        except httpx.RequestError as exc:
            # Same fix as _submit above, for the same reason — a poll can
            # run for several minutes across many attempts, so treating
            # one momentary connection drop as instantly fatal threw away
            # an entire in-progress FortyGuard job over what's often a
            # few-second network blip, while a 429/5xx response two
            # branches below already got proper retry/backoff.
            consecutive_transient_errors += 1
            log_err(f"Network error polling {activity_id} — "
                    f"{consecutive_transient_errors}/{settings.RETRY_MAX_ATTEMPTS}", {"error": str(exc)})
            status_tracker.record_error(f"network error: {exc}")
            if consecutive_transient_errors <= settings.RETRY_MAX_ATTEMPTS:
                delay = _retry_delay(consecutive_transient_errors, None)
                await asyncio.sleep(delay)
                continue
            raise FortyGuardError(f"Network error polling FortyGuard: {exc}", activity_id=activity_id) from exc

        if resp.status_code == 404:
            # Doc: activity may be temporarily unavailable immediately after submission.
            log_poll(f"Poll #{attempt} — 404 (not yet available), retrying")
            await asyncio.sleep(settings.POLL_INTERVAL_SECONDS)
            continue

        if _is_transient(resp.status_code):
            consecutive_transient_errors += 1
            if consecutive_transient_errors <= settings.RETRY_MAX_ATTEMPTS:
                delay = _retry_delay(consecutive_transient_errors, resp)
                log_err(f"Poll #{attempt} for {activity_id} got {resp.status_code} — "
                        f"backing off {delay:.1f}s ({consecutive_transient_errors}/{settings.RETRY_MAX_ATTEMPTS})",
                        {"status_code": resp.status_code})
                status_tracker.record_error(f"poll got {resp.status_code}, retrying")
                await asyncio.sleep(delay)
                continue
            log_err(f"Poll for {activity_id} exhausted retries on repeated {resp.status_code}")
            status_tracker.record_error(f"poll returned {resp.status_code} repeatedly")
            raise FortyGuardError(
                f"FortyGuard status endpoint kept returning {resp.status_code} "
                f"after {settings.RETRY_MAX_ATTEMPTS} retries",
                status_code=resp.status_code,
                activity_id=activity_id,
            )

        if resp.status_code != 200:
            log_err(f"Unexpected status polling {activity_id}", {
                "status_code": resp.status_code, "body": _safe_json(resp),
            })
            status_tracker.record_error(f"poll returned {resp.status_code}")
            raise FortyGuardError(
                f"FortyGuard status endpoint returned {resp.status_code}",
                status_code=resp.status_code,
                activity_id=activity_id,
            )

        consecutive_transient_errors = 0
        body = resp.json()
        status = body.get("data", {}).get("status", "").lower()
        log_poll(f"Poll #{attempt}", _redact_signed_urls(body))

        if status == "completed":
            log_res("FortyGuard task completed", _redact_signed_urls(body))
            status_tracker.record_success()
            return body
        if status == "failed":
            log_err(f"Activity {activity_id} failed", body)
            status_tracker.record_error(f"activity {activity_id} failed")
            raise FortyGuardError(f"FortyGuard activity {activity_id} failed", activity_id=activity_id)

        await asyncio.sleep(settings.POLL_INTERVAL_SECONDS)

    log_err(f"Activity {activity_id} did not complete within poll budget")
    status_tracker.record_error(f"activity {activity_id} timed out after {settings.POLL_MAX_ATTEMPTS} polls")
    raise FortyGuardError(
        f"Activity {activity_id} did not complete after "
        f"{settings.POLL_MAX_ATTEMPTS} polls",
        activity_id=activity_id,
    )


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return resp.text


async def submit_and_wait(endpoint: str, payload: dict) -> tuple[str, dict]:
    """Submit a request to FortyGuard and block (async) until it completes.
    Returns (activity_id, full status-response body with .data.result).
    Used by the fast endpoints (heatmap, env_params, satellite, streetview)
    where blocking the request is acceptable/expected."""
    async with httpx.AsyncClient() as client:
        activity_id = await _submit(client, endpoint, payload)
        result = await _poll(client, activity_id)
        return activity_id, result


async def submit_only(endpoint: str, payload: dict) -> str:
    """Submit WITHOUT waiting for completion — returns just the
    activity_id. Used by Heat Intelligence's async job flow: the initial
    request returns immediately with this id, and a background task (see
    repository.py) calls poll_until_done() separately, later."""
    async with httpx.AsyncClient() as client:
        return await _submit(client, endpoint, payload)


async def poll_until_done(activity_id: str) -> dict:
    """Poll a previously-submitted activity_id to completion. Split out
    from submit_and_wait so a background task can resume polling an
    activity whose submit already happened (and already returned to the
    original caller) in an earlier request."""
    async with httpx.AsyncClient() as client:
        return await _poll(client, activity_id)


async def download_heat_intelligence_pdf(download_link: str, dest_path: str) -> None:
    """Immediately fetch the temporary signed PDF URL and persist it locally.
    Per FortyGuard's docs, this link is temporary and must not be logged/shared."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(download_link, timeout=60)
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            f.write(resp.content)