"""
Repository layer: wraps FortyGuard calls with Postgres-backed caching.

Before hitting FortyGuard, check whether we already have a completed
activity for the exact same request (by signature). If so, reuse it —
this avoids burning credits/time on identical requests.
"""
import asyncio
import json

from . import fortyguard_client as fg
from . import location_features
from . import locations
from . import request_coordination
from .config import settings
from .db import get_pool
from .logger import log_db, log_err


async def _find_cached_activity(endpoint_type: str, signature: str) -> str | None:
    pool = get_pool()
    row = await pool.fetchrow(
        """
        SELECT activity_id FROM fortyguard_activities
        WHERE endpoint_type = $1 AND request_signature = $2 AND status = 'Completed'
        ORDER BY completed_at DESC LIMIT 1
        """,
        endpoint_type, signature,
    )
    if row:
        log_db(f"Cache hit for {endpoint_type}", {"activity_id": row["activity_id"]})
        return row["activity_id"]
    return None


async def _record_activity(activity_id: str, endpoint_type: str, payload: dict,
                            signature: str, status: str, error: str | None = None) -> None:
    pool = get_pool()
    await pool.execute(
        """
        INSERT INTO fortyguard_activities
            (activity_id, endpoint_type, request_payload, request_signature, status, completed_at, error)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'Completed' THEN now() ELSE NULL END, $6)
        ON CONFLICT (activity_id) DO UPDATE SET
            status = EXCLUDED.status,
            completed_at = EXCLUDED.completed_at,
            error = EXCLUDED.error
        """,
        activity_id, endpoint_type, json.dumps(payload), signature, status, error,
    )


async def _try_heatmap_cache(signature: str) -> dict | None:
    cached_id = await _find_cached_activity("heatmap", signature)
    if not cached_id:
        return None
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT map_data, stats_data FROM heatmaps WHERE activity_id = $1", cached_id
    )
    if not row:
        return None
    map_data = json.loads(row["map_data"])
    if map_data.get("features"):
        return {
            "activity_id": cached_id,
            "cached": True,
            "map_data": map_data,
            "stats_data": json.loads(row["stats_data"]),
        }
    # A previously-cached "Completed" result with zero tiles is almost
    # always a transient FortyGuard-side hiccup (a momentary gap for that
    # exact AOI/time), not a permanent fact about the location — treating
    # it as a real cache hit would mean this exact request is broken
    # FOREVER, since nothing else would ever trigger a fresh attempt.
    log_err(
        "Ignoring cached heatmap with zero tiles — retrying live instead of serving it forever",
        {"activity_id": cached_id, "signature": signature},
    )
    return None


async def get_heatmap(payload: dict, force_refresh: bool = False, extra_payload_fields: dict | None = None,
                       persist: bool = True) -> dict:
    # `payload` stays exactly what's signed and sent to FortyGuard — never
    # touched by extra_payload_fields, so a purpose tag can't create a
    # duplicate cache entry for an otherwise-identical request, and can
    # never end up in the JSON body FortyGuard actually receives (which
    # doesn't know or care about it). extra_payload_fields only gets
    # merged in at the _record_activity call below, purely for what
    # get_heatmap_history later reads back.
    #
    # Phase 11 — `persist=False` is how Heat Story asks for a FORECAST
    # hour (a future start_time on the same tcm heatmap endpoint — see
    # heat_story.py's module docstring): the raw result is still cached in
    # fortyguard_activities/heatmaps like any other heatmap fetch (so
    # re-opening Heat Story a minute later doesn't re-bill FortyGuard for
    # the same forecast hour), but it is NEVER written to
    # location_features — that table is Phase 5's canonical OBSERVED
    # store, and a forecast is not an observation. The signature is
    # salted for persist=False specifically so this forecast entry can
    # never be accidentally served back out of cache once that same hour
    # is later fetched for real with persist=True (see
    # fortyguard_client.request_signature's own docstring for why that
    # collision would otherwise happen).
    signature = fg.request_signature("heatmap", payload, salt=None if persist else "forecast")
    if not force_refresh:
        cached = await _try_heatmap_cache(signature)
        if cached:
            return cached

    async def _do_fetch() -> dict:
        async def _submit_once() -> tuple[str, dict]:
            try:
                activity_id, body = await fg.submit_and_wait("heatmap", payload)
            except fg.FortyGuardError as exc:
                log_err("Heatmap submission failed", {"error": str(exc)})
                if exc.activity_id:
                    # FortyGuard DID create this activity — it failed or
                    # timed out while we were polling it, not while
                    # submitting. Record it (status='Failed') so it's not
                    # simply thrown away with no trace: it shows up in
                    # fortyguard_activities for debugging, and if this
                    # activity_id later turns out to have actually
                    # completed on FortyGuard's side (a slow request that
                    # finished just after our poll budget ran out), there's
                    # a real row to reconcile against instead of nothing.
                    await _record_activity(exc.activity_id, "heatmap", payload, signature, "Failed", str(exc))
                raise
            result = body.get("data", {}).get("result", {})
            return activity_id, result

        activity_id, result = await _submit_once()
        map_data = result.get("map_data", {})
        stats_data = result.get("stats_data", {})

        if not map_data.get("features"):
            # One bounded retry on a genuinely fresh empty result — enough
            # to ride out a one-off FortyGuard hiccup without hammering
            # it, and without ever looping indefinitely.
            #
            # The retry itself can fail outright (e.g. a transient 500 on
            # FortyGuard's side, separate from the first request's empty
            # result) — that used to propagate straight up as an
            # unhandled exception, turning "we already have a valid (if
            # empty) result" into a hard 502 that threw away the first
            # attempt's data for no reason. Now a failed retry just falls
            # back to the original empty result instead of failing the
            # whole request — the caller still sees n_cells: 0 (an
            # honest, real answer) rather than an error for a case that
            # already had *a* successful response.
            log_err("Heatmap came back with zero tiles — retrying once", {"activity_id": activity_id})
            try:
                activity_id, result = await _submit_once()
                map_data = result.get("map_data", {})
                stats_data = result.get("stats_data", {})
            except fg.FortyGuardError as exc:
                log_err(
                    "Zero-tile retry also failed — falling back to the original empty result",
                    {"activity_id": activity_id, "retry_error": str(exc)},
                )

        await _record_activity(activity_id, "heatmap", {**payload, **(extra_payload_fields or {})}, signature, "Completed")
        pool = get_pool()
        await pool.execute(
            "INSERT INTO heatmaps (activity_id, map_data, stats_data) VALUES ($1, $2, $3)",
            activity_id, json.dumps(map_data), json.dumps(stats_data),
        )

        # Phase 5: derived-features population — only on a genuine new
        # completion (never on a cache hit, which returns earlier above),
        # only for a non-empty result, AND only when persist=True. This
        # last condition is Phase 11's whole safety property: a forecast
        # fetch (persist=False) returns its map_data/stats_data to the
        # caller same as any other heatmap result, but never touches
        # location_features — see this function's docstring.
        if map_data.get("features") and persist:
            await location_features.record_heatmap_result(payload, stats_data)

        return {
            "activity_id": activity_id,
            "cached": False,
            "map_data": map_data,
            "stats_data": stats_data,
        }

    if force_refresh:
        # A force_refresh (Retry, or the Query panel's Refresh) must still
        # take the SAME cross-process claim the normal path does — not so
        # two force_refresh clicks can share a cache hit (force_refresh
        # means "skip the cache" by definition), but so
        # get_heatmap_status below can tell "a fresh fetch for this exact
        # signature is genuinely running right now" apart from whatever
        # an OLDER attempt at this same signature left behind. Without
        # this, a Retry after a zero-tile result would claim nothing,
        # its OWN fresh fetch would run invisibly, and status polling
        # would keep reporting the ORIGINAL (stale, empty) attempt's
        # 'Completed' row as if it were the retry's own outcome — the
        # retry visibly "failing" even though it goes on to genuinely
        # succeed and save real data a moment later, just with nobody
        # left polling to see it.
        won = await request_coordination.try_claim("heatmap", signature)
        if not won:
            # Someone else is already force-refreshing this exact
            # signature (e.g. a duplicate double-click on Retry) — wait
            # for THEM via the same coordinated path the normal case
            # uses, rather than firing a second concurrent FortyGuard
            # submission for identical work.
            return await request_coordination.coordinated_fetch(
                "heatmap", signature, lambda: _try_heatmap_cache(signature), _do_fetch
            )
        try:
            return await _do_fetch()
        finally:
            await request_coordination.release_claim("heatmap", signature)
    # Cross-process coordinated: see request_coordination.py. Two
    # near-simultaneous callers for the identical signature — even across
    # different backend workers — share one real FortyGuard submission.
    return await request_coordination.coordinated_fetch(
        "heatmap", signature, lambda: _try_heatmap_cache(signature), _do_fetch
    )


async def _heatmap_job(payload: dict, signature: str, force_refresh: bool, extra_payload_fields: dict | None = None,
                        persist: bool = True) -> None:
    """Background task: does the actual (potentially multi-minute) work
    that used to block POST /api/heatmap open the whole time — that's what
    produced the 332-second hang and the hour-change error you hit.
    get_heatmap already handles submit/retry/cache/coordination correctly;
    this just runs it off the request thread and lets get_heatmap_status
    (a plain Postgres read) report the outcome whenever the frontend next
    polls, instead of the HTTP connection itself carrying the wait."""
    try:
        await get_heatmap(payload, force_refresh=force_refresh, extra_payload_fields=extra_payload_fields, persist=persist)
    except fg.FortyGuardError as exc:
        # get_heatmap's own _do_fetch now records a 'Failed' row for a
        # timeout/failure that happens AFTER an activity_id exists (see
        # exc.activity_id) — this outer catch used to unconditionally
        # claim "before an activity_id existed" even when one clearly
        # did (e.g. 120 real polls against a real activity_id that just
        # never reported Completed in time). Log accurately instead of
        # guessing.
        if exc.activity_id:
            log_err("Heatmap background job's FortyGuard activity did not finish in time",
                    {"activity_id": exc.activity_id, "signature": signature, "error": str(exc)})
        else:
            log_err("Heatmap background job failed before an activity_id existed",
                    {"signature": signature, "error": str(exc)})


async def start_heatmap(payload: dict, force_refresh: bool = False, extra_payload_fields: dict | None = None,
                         persist: bool = True) -> dict:
    """Non-blocking entry point for POST /api/heatmap — returns immediately
    with either an already-cached result or a 'Processing' status + the
    request signature to poll. Mirrors start_heat_intelligence's shape
    exactly (see that function for the fuller design rationale); the
    difference here is there's no dedicated job table — heatmap reuses
    fortyguard_activities + heatmaps directly, the same tables the
    already-existing get_heatmap() writes to, so this is purely a
    non-blocking wrapper around it rather than a parallel implementation.

    extra_payload_fields (e.g. {"purpose": "risk_factor_background"}) is
    purely for what gets recorded in fortyguard_activities for history —
    see get_heatmap's own docstring. On a cache hit below, the ORIGINAL
    stored record's purpose (or lack of one) is left as-is deliberately:
    a background riskBoost call reusing an entry the user genuinely
    viewed earlier must not retroactively relabel it as background.

    `persist` is Phase 11's forecast flag, threaded straight through to
    get_heatmap/​_heatmap_job — see get_heatmap's docstring. routers/
    heat_story.py is the only caller that ever passes persist=False;
    every existing caller (Heat Map, scheduler.py) keeps the default,
    unchanged behavior."""
    signature = fg.request_signature("heatmap", payload, salt=None if persist else "forecast")

    if not force_refresh:
        cached = await _try_heatmap_cache(signature)
        if cached:
            return {**cached, "status": "Completed"}
        in_flight = await _try_heatmap_in_flight(signature)
        if in_flight:
            return in_flight

    asyncio.create_task(_heatmap_job(payload, signature, force_refresh, extra_payload_fields, persist))
    return {"status": "Processing", "signature": signature}


async def _try_heatmap_in_flight(signature: str) -> dict | None:
    """Is a heatmap job for this signature already running somewhere?

    This used to check `fortyguard_activities WHERE status = 'Processing'`
    — but nothing ever writes a heatmap row with that status: get_heatmap's
    `_do_fetch` only calls `_record_activity` once, at the very end, with
    status='Completed'. So that check was always querying for a row that
    could never exist and always returned None — dead code that looked
    like it was preventing redundant background-job spawns but never
    actually did. The real cross-process claim heatmaps take out while
    genuinely in flight lives in `in_progress_requests` (see
    request_coordination.py / get_heatmap's own `coordinated_fetch` call).

    Critically, this now goes through request_coordination.claim_status
    instead of a bare `SELECT 1` — a claim row existing does NOT mean a
    worker is still alive: if the process that took the claim was killed
    (crashed, or — as happened in practice — a `uvicorn --reload` restart
    triggered mid-fetch by an unrelated file save) it dies without ever
    reaching coordinated_fetch's `finally: release_claim(...)`, leaving
    the row behind forever. The bare-SELECT version treated that orphaned
    row as "still in flight" permanently, so start_heatmap() below would
    never spawn a fresh _heatmap_job for that signature again — not once,
    not ever, regardless of how much time passed — while
    get_heatmap_status kept truthfully reporting 'Processing' since
    nothing was ever going to move it further. claim_status's own
    staleness math (claimed_at older than DEFAULT_STALE_AFTER_SECONDS) is
    exactly what unsticks this: a stale or released claim here means
    "nobody is actually working on this", so start_heatmap proceeds to
    spawn a real job again."""
    status = await request_coordination.claim_status(
        "heatmap", signature, request_coordination.DEFAULT_STALE_AFTER_SECONDS
    )
    return {"status": "Processing", "signature": signature} if status == "waiting" else None


async def get_heatmap_status(signature: str) -> dict:
    """Polled by the frontend after start_heatmap() returns 'Processing'.
    Pure Postgres read, same pattern as get_heat_intelligence_status."""
    cached = await _try_heatmap_cache(signature)
    if cached:
        return {**cached, "status": "Completed"}

    # Checking the in-flight claim BEFORE the raw fortyguard_activities
    # query below matters specifically for a retry: get_heatmap's
    # force_refresh branch (and the normal coordinated_fetch path) both
    # hold this exact claim for as long as a fresh fetch for this
    # signature is genuinely running. If a PRIOR attempt at this same
    # signature already completed (e.g. the original zero-tile result
    # someone is retrying), its row is still sitting in
    # fortyguard_activities with status='Completed' — the query below,
    # with nothing to tell it a NEW attempt is in flight, would find that
    # stale row and report the retry "done" and empty before it's even
    # finished, which is exactly what made Retry look broken even though
    # the retry itself went on to succeed and save real data moments
    # later, just too late for anyone still polling to see it.
    in_flight = await _try_heatmap_in_flight(signature)
    if in_flight:
        return in_flight

    row = await get_pool().fetchrow(
        """
        SELECT status, error FROM fortyguard_activities
        WHERE endpoint_type = 'heatmap' AND request_signature = $1
        ORDER BY submitted_at DESC LIMIT 1
        """,
        signature,
    )
    if not row:
        return {"status": "Processing", "signature": signature}
    if row["status"] == "Failed":
        return {"status": "Failed", "signature": signature, "error": row["error"]}
    if row["status"] == "Completed":
        # _try_heatmap_cache above deliberately returns None for a
        # zero-tile result (see its own docstring) so a FRESH request
        # gets a real retry instead of being stuck replaying an empty
        # result forever. But get_heatmap_status isn't starting a fresh
        # request — it's asking "is the job that's already running
        # done yet?" _heatmap_job already ran get_heatmap to completion,
        # including its own one-shot zero-tile retry — by the time this
        # row says 'Completed', there is no more work happening, ever,
        # for this signature. Treating a Completed-but-empty activity as
        # still 'Processing' (the previous behavior) meant the frontend
        # polled forever with nothing left to wait for — that's the
        # infinite-poll loop this fixes. Report it as genuinely finished,
        # just empty, so the frontend can show "no data" instead of an
        # endless spinner.
        return {"status": "Completed", "signature": signature,
                "map_data": {"type": "FeatureCollection", "features": []},
                "stats_data": {"temperature_stats": None, "empty": True}}
    # 'Processing' — the only remaining case, and the only one where more
    # work is genuinely still happening.
    return {"status": "Processing", "signature": signature}


async def _try_env_params_cache(signature: str) -> dict | None:
    cached_id = await _find_cached_activity("env_params", signature)
    if not cached_id:
        return None
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT metadata, locations FROM environmental_parameters WHERE activity_id = $1", cached_id
    )
    if not row:
        return None
    return {
        "activity_id": cached_id,
        "cached": True,
        "metadata": json.loads(row["metadata"]),
        "locations": json.loads(row["locations"]),
    }


async def get_env_params(payload: dict, force_refresh: bool = False) -> dict:
    signature = fg.request_signature("env_params", payload)
    if not force_refresh:
        cached = await _try_env_params_cache(signature)
        if cached:
            return cached

    async def _do_fetch() -> dict:
        activity_id, body = await fg.submit_and_wait("env_params", payload)
        result = body.get("data", {}).get("result", {})
        metadata = result.get("metadata", {})
        locations_result = result.get("locations", [])

        await _record_activity(activity_id, "env_params", payload, signature, "Completed")
        pool = get_pool()
        await pool.execute(
            "INSERT INTO environmental_parameters (activity_id, metadata, locations) VALUES ($1, $2, $3)",
            activity_id, json.dumps(metadata), json.dumps(locations_result),
        )

        # Phase 5: derived-features population — only on a genuine new
        # completion (never on a cache hit, which returns earlier above).
        await location_features.record_env_params_result(payload, locations_result)

        return {
            "activity_id": activity_id,
            "cached": False,
            "metadata": metadata,
            "locations": locations_result,
        }

    if force_refresh:
        return await _do_fetch()
    return await request_coordination.coordinated_fetch(
        "env_params", signature, lambda: _try_env_params_cache(signature), _do_fetch
    )


async def _try_satellite_cache(signature: str) -> dict | None:
    cached_id = await _find_cached_activity("satellite", signature)
    if not cached_id:
        return None
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT coordinates, original_image, image_year, segmentation "
        "FROM satellite_segmentations WHERE activity_id = $1",
        cached_id,
    )
    if not row:
        return None
    return {
        "activity_id": cached_id,
        "cached": True,
        "coordinates": json.loads(row["coordinates"]),
        "original_image": json.loads(row["original_image"]) if row["original_image"] else [],
        "image_year": row["image_year"],
        "segmentation": json.loads(row["segmentation"]),
    }


async def get_satellite(payload: dict, force_refresh: bool = False) -> dict:
    signature = fg.request_signature("satellite", payload)
    if not force_refresh:
        cached = await _try_satellite_cache(signature)
        if cached:
            return cached

    async def _do_fetch() -> dict:
        activity_id, body = await fg.submit_and_wait("satellite", payload)
        result = body.get("data", {}).get("result", {})
        coordinates = result.get("coordinates", {})
        # FortyGuard's own field name has a typo ("orignal_image") — that's
        # their literal JSON key, not ours; we read it as-is here and
        # expose it under a correctly-spelled name in our own API.
        original_image = result.get("orignal_image", [])
        image_year = result.get("image_year")
        segmentation = result.get("segmentation", {})

        await _record_activity(activity_id, "satellite", payload, signature, "Completed")
        pool = get_pool()
        await pool.execute(
            "INSERT INTO satellite_segmentations (activity_id, coordinates, original_image, image_year, segmentation) "
            "VALUES ($1, $2, $3, $4, $5)",
            activity_id, json.dumps(coordinates), json.dumps(original_image), image_year, json.dumps(segmentation),
        )

        return {
            "activity_id": activity_id,
            "cached": False,
            "coordinates": coordinates,
            "original_image": original_image,
            "image_year": image_year,
            "segmentation": segmentation,
        }

    if force_refresh:
        return await _do_fetch()
    return await request_coordination.coordinated_fetch(
        "satellite", signature, lambda: _try_satellite_cache(signature), _do_fetch
    )


async def _try_streetview_cache(signature: str) -> dict | None:
    cached_id = await _find_cached_activity("streetview", signature)
    if not cached_id:
        return None
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT coordinates, front FROM streetview_segmentations WHERE activity_id = $1", cached_id
    )
    if not row:
        return None
    return {
        "activity_id": cached_id,
        "cached": True,
        "coordinates": json.loads(row["coordinates"]),
        "front": json.loads(row["front"]),
    }


async def get_streetview(payload: dict, force_refresh: bool = False) -> dict:
    signature = fg.request_signature("streetview", payload)
    if not force_refresh:
        cached = await _try_streetview_cache(signature)
        if cached:
            return cached

    async def _do_fetch() -> dict:
        activity_id, body = await fg.submit_and_wait("streetview", payload)
        result = body.get("data", {}).get("result", {})
        coordinates = result.get("coordinates", {})
        front = result.get("front", {})

        await _record_activity(activity_id, "streetview", payload, signature, "Completed")
        pool = get_pool()
        await pool.execute(
            "INSERT INTO streetview_segmentations (activity_id, coordinates, front) VALUES ($1, $2, $3)",
            activity_id, json.dumps(coordinates), json.dumps(front),
        )

        return {
            "activity_id": activity_id,
            "cached": False,
            "coordinates": coordinates,
            "front": front,
        }

    if force_refresh:
        return await _do_fetch()
    return await request_coordination.coordinated_fetch(
        "streetview", signature, lambda: _try_streetview_cache(signature), _do_fetch
    )


async def get_heat_intelligence_by_activity(activity_id: str) -> dict | None:
    """Reads a completed Heat Intelligence report's file_path directly by
    activity_id — used by the download route, which already has the id
    from a prior start_heat_intelligence()/status call and doesn't need
    to re-derive a signature."""
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT file_path FROM heat_intelligence_reports WHERE activity_id = $1", activity_id
    )
    return {"file_path": row["file_path"]} if row else None


async def _heat_intelligence_job(activity_id: str, signature: str) -> None:
    """Background task: this is the part that used to block the original
    HTTP request. It polls FortyGuard to completion, downloads the PDF,
    and records the outcome in Postgres — the original request that
    kicked this off already returned long before this finishes; the
    frontend finds out what happened by polling
    GET /api/heat-intelligence/{activity_id}/status, which just reads
    Postgres (see get_heat_intelligence_status below), never FortyGuard
    directly. This is what Phase 3's own spec asked for and what the
    previous blocking-call version didn't actually implement."""
    import os
    import uuid

    try:
        body = await fg.poll_until_done(activity_id)
    except fg.FortyGuardError as exc:
        log_err("Heat Intelligence polling failed", {"activity_id": activity_id, "error": str(exc)})
        await _record_activity(activity_id, "heat_intelligence", {}, signature, "Failed", str(exc))
        return

    result = body.get("data", {}).get("result", {})
    download_link = result.get("download_link")
    if not download_link:
        await _record_activity(activity_id, "heat_intelligence", {}, signature,
                                "Failed", "Heat Intelligence completed without a download_link")
        return

    reports_dir = os.path.join(os.path.dirname(__file__), "..", "storage", "heat_intelligence")
    os.makedirs(reports_dir, exist_ok=True)
    file_path = os.path.join(reports_dir, f"{uuid.uuid4().hex}.pdf")
    try:
        await fg.download_heat_intelligence_pdf(download_link, file_path)
    except Exception as exc:  # noqa: BLE001 — this runs unattended; nothing upstream can catch it
        log_err("Heat Intelligence PDF download failed", {"activity_id": activity_id, "error": str(exc)})
        await _record_activity(activity_id, "heat_intelligence", {}, signature,
                                "Failed", f"PDF download failed: {exc}")
        return

    pool = get_pool()
    await pool.execute(
        "INSERT INTO heat_intelligence_reports (activity_id, file_path) VALUES ($1, $2)",
        activity_id, file_path,
    )
    await _record_activity(activity_id, "heat_intelligence", {}, signature, "Completed")
    log_db(f"Heat Intelligence job {activity_id} completed")


async def start_heat_intelligence(payload: dict, force_refresh: bool = False) -> dict:
    """Starts (or reuses) a Heat Intelligence job and returns IMMEDIATELY —
    never blocks on FortyGuard's own processing time, which the docs
    describe as potentially several minutes. Matches the roadmap's actual
    Phase 3 spec: 'Slow endpoints (Heat Intelligence) return a job id;
    frontend polls our status, backed by Postgres.'"""
    signature = fg.request_signature("heat_intelligence", payload)
    pool = get_pool()

    async def _already_completed() -> dict | None:
        cached_id = await _find_cached_activity("heat_intelligence", signature)
        if not cached_id:
            return None
        row = await pool.fetchrow(
            "SELECT file_path FROM heat_intelligence_reports WHERE activity_id = $1", cached_id
        )
        if not row:
            return None
        return {"activity_id": cached_id, "status": "Completed",
                "download_url": f"/api/heat-intelligence/{cached_id}/download"}

    async def _already_in_flight() -> dict | None:
        row = await pool.fetchrow(
            """
            SELECT activity_id FROM fortyguard_activities
            WHERE endpoint_type = 'heat_intelligence' AND request_signature = $1 AND status = 'Processing'
            ORDER BY submitted_at DESC LIMIT 1
            """,
            signature,
        )
        return {"activity_id": row["activity_id"], "status": "Processing"} if row else None

    if not force_refresh:
        done = await _already_completed()
        if done:
            return done
        in_flight = await _already_in_flight()
        if in_flight:
            return in_flight

    # Two near-simultaneous requests for the same signature must share this
    # one submission instead of each starting their own FortyGuard job.
    # This claim is only held for the brief "decide whether to submit"
    # window — once submitted, fortyguard_activities itself (shared via
    # Postgres) is the real cross-process signal that a job is in flight,
    # so the claim doesn't need to be held for the full multi-minute job.
    won = await request_coordination.try_claim("heat_intelligence_submit", signature)
    if not won:
        # Someone else — possibly in a different worker process — is
        # deciding right now. Give them a moment to record their
        # in-flight/completed activity, then report that instead of
        # racing to submit our own.
        for _ in range(10):
            await asyncio.sleep(0.3)
            in_flight = await _already_in_flight()
            if in_flight:
                return in_flight
            done = await _already_completed()
            if done:
                return done
        # Pathological case (the other claimant vanished without ever
        # recording anything) — proceed as if we'd won rather than leaving
        # the caller with neither a job nor a result.

    try:
        if not force_refresh:
            done = await _already_completed()
            if done:
                return done
            in_flight = await _already_in_flight()
            if in_flight:
                return in_flight

        activity_id = await fg.submit_only("heat_intelligence", payload)
        await _record_activity(activity_id, "heat_intelligence", payload, signature, "Processing")
        # Fire-and-forget: this task keeps running after this function
        # (and the HTTP request that called it) returns.
        asyncio.create_task(_heat_intelligence_job(activity_id, signature))
        return {"activity_id": activity_id, "status": "Processing"}
    finally:
        await request_coordination.release_claim("heat_intelligence_submit", signature)


async def get_heat_intelligence_status(activity_id: str) -> dict:
    """What the frontend actually polls. Reads Postgres only — never
    touches FortyGuard directly; _heat_intelligence_job's background task
    is the only thing that does that, separately, on its own schedule."""
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT status, error FROM fortyguard_activities WHERE activity_id = $1", activity_id
    )
    if not row:
        raise KeyError(activity_id)
    if row["status"] == "Completed":
        return {"activity_id": activity_id, "status": "Completed",
                "download_url": f"/api/heat-intelligence/{activity_id}/download"}
    if row["status"] == "Failed":
        return {"activity_id": activity_id, "status": "Failed", "error": row["error"]}
    return {"activity_id": activity_id, "status": "Processing"}


async def recover_orphaned_heat_intelligence_jobs() -> None:
    """Call once at startup, after init_db(). A Heat Intelligence job's
    Postgres row (fortyguard_activities.status) is durable across a
    restart, but the asyncio.create_task() actually polling FortyGuard for
    it is NOT — that task dies with the process. Without this sweep, a job
    that was 'Processing' when the backend restarted (deploy, crash, PDF-
    save-triggers-reload during dev, etc.) would sit at 'Processing'
    forever: nothing would ever move it to Completed or Failed, and the
    frontend would poll get_heat_intelligence_status indefinitely with no
    resolution. This isn't the exact failure mode raised (a 404 — that
    would actually require the row to be missing, which it isn't; the row
    survives fine), but a stuck-forever 'Processing' status is a real gap
    in its own right, so it's worth closing regardless of how it was
    originally described.
    On restart, anything still 'Processing' can only be orphaned — this
    process just started, so it cannot possibly have a live task tracking
    it (no in-memory task survives a restart). Mark those honestly as
    Failed with a clear reason, rather than leaving them stuck; the
    frontend already has error-state UI for a Failed status, so the user
    sees a real, actionable outcome instead of an infinite spinner. If
    FortyGuard actually did finish that job, the client can just click
    "Generate report" again — force_refresh submits fresh."""
    pool = get_pool()
    rows = await pool.fetch(
        "SELECT activity_id FROM fortyguard_activities WHERE endpoint_type = 'heat_intelligence' AND status = 'Processing'"
    )
    if not rows:
        return
    ids = [r["activity_id"] for r in rows]
    await pool.execute(
        """
        UPDATE fortyguard_activities
        SET status = 'Failed', error = 'Backend restarted while this job was processing — please try again'
        WHERE activity_id = ANY($1::text[])
        """,
        ids,
    )
    log_err("Marked orphaned Heat Intelligence jobs as Failed on startup", {"activity_ids": ids})


def _centroid_from_polygon_aoi(polygon_aoi: dict) -> tuple[float, float] | None:
    try:
        coords = polygon_aoi["features"][0]["geometry"]["coordinates"][0]
    except (KeyError, IndexError, TypeError):
        return None
    pts = coords[:-1] if len(coords) > 1 and coords[0] == coords[-1] else coords
    if not pts:
        return None
    lat = sum(p[1] for p in pts) / len(pts)
    lon = sum(p[0] for p in pts) / len(pts)
    return lat, lon


async def get_heatmap_history(city_id: str, limit: int = 10) -> list[dict]:
    """Real, Postgres-backed 'recently viewed' list for a city — reads
    directly from fortyguard_activities instead of a client-side cache, so
    it always reflects what's actually stored in the database (and goes
    empty if the database does, rather than surviving a wipe via
    localStorage the way the old browser-only history did)."""
    pool = get_pool()
    # Activities aren't tagged with a city_id at write time (they only
    # carry raw AOI coordinates) — over-fetch recent completed heatmap
    # activities and match each one's centroid back to a monitored city
    # after the fact, same approach as location_features population.
    rows = await pool.fetch(
        """
        SELECT activity_id, request_payload, completed_at
        FROM fortyguard_activities
        WHERE endpoint_type = 'heatmap' AND status = 'Completed'
        ORDER BY completed_at DESC
        LIMIT 200
        """
    )
    city = locations.get_city(city_id)
    if not city:
        return []

    seen: set[str] = set()
    out: list[dict] = []
    for row in rows:
        payload = json.loads(row["request_payload"])
        centroid = _centroid_from_polygon_aoi(payload.get("polygon_aoi", {}))
        if not centroid:
            continue
        matched = locations.nearest_city(*centroid)
        if not matched or matched["id"] != city_id:
            continue

        date_time = payload.get("date_time", {})
        entry = {
            "activity_id": row["activity_id"],
            "date": date_time.get("start_date"),
            "filter_type": date_time.get("filter_type"),
            "start_time": date_time.get("start_time"),
            "end_time": date_time.get("end_time"),
            "end_date": date_time.get("end_date"),
            "analytic_type": payload.get("analytic_type"),
            "granularity": payload.get("granularity"),
            "threshold": payload.get("threshold"),
            "direction": payload.get("direction"),
            "purpose": payload.get("purpose"),
            "completed_at": row["completed_at"].isoformat() if row["completed_at"] else None,
        }
        # Collapse near-duplicate entries (e.g. Apply clicked twice with
        # nothing changed) down to the single most recent copy.
        dedupe_key = json.dumps({k: v for k, v in entry.items() if k not in ("activity_id", "completed_at")}, sort_keys=True)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        out.append(entry)
        if len(out) >= limit:
            break
    return out