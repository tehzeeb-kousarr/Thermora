"""
Cross-process request coordination.

The previous version of this (an in-process asyncio.Lock keyed by
signature) only coordinated within a single backend worker. Correct for
this app's actual single-worker deployment, but it silently stops
protecting anything the moment this ever runs behind multiple Uvicorn
workers or replicas — the exact race it was built to prevent (two
near-simultaneous callers for the same signature both submitting to
FortyGuard) comes right back, just harder to reproduce.

This replaces it with a real Postgres row as the claim: an
INSERT ... ON CONFLICT DO NOTHING is atomic across any number of
processes hitting the same database, so exactly one caller "wins" and
becomes responsible for doing the actual FortyGuard call; everyone else
polls until either a completed result shows up (the normal case) or the
claim goes stale — meaning the claimant crashed or was killed mid-fetch
without cleaning up — at which point a waiter is allowed to steal it and
try again, rather than every future request for that signature being
stuck behind a claim nobody will ever release.
"""
import asyncio

from .db import get_pool
from .logger import log_db, log_err

# Deliberately generous: this must be at least as long as the worst-case
# legitimate processing time (FortyGuard's own submit_and_wait ceiling —
# POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS, currently up to ~10 minutes),
# plus a safety margin. Too short and a waiter "steals" the claim from a
# process that's still genuinely working, causing a duplicate submission —
# exactly the bug this exists to prevent, just moved to a different
# trigger. Too long just means a genuinely crashed claimant blocks that
# one signature a bit longer before recovery, which is the safe direction
# to err in.
DEFAULT_STALE_AFTER_SECONDS = 660
POLL_INTERVAL_SECONDS = 1.5


async def try_claim(endpoint_type: str, signature: str) -> bool:
    pool = get_pool()
    row = await pool.fetchrow(
        """
        INSERT INTO in_progress_requests (endpoint_type, request_signature)
        VALUES ($1, $2)
        ON CONFLICT (endpoint_type, request_signature) DO NOTHING
        RETURNING 1
        """,
        endpoint_type, signature,
    )
    return row is not None


async def release_claim(endpoint_type: str, signature: str) -> None:
    pool = get_pool()
    await pool.execute(
        "DELETE FROM in_progress_requests WHERE endpoint_type = $1 AND request_signature = $2",
        endpoint_type, signature,
    )


async def claim_status(endpoint_type: str, signature: str, stale_after_seconds: float) -> str:
    """Returns 'released' (no claim row — safe to check the cache now),
    'stale' (claim row exists but is older than stale_after_seconds — the
    claimant likely crashed, safe to attempt stealing it), or 'waiting'
    (someone else is actively working on it)."""
    pool = get_pool()
    row = await pool.fetchrow(
        """
        SELECT (now() - claimed_at) > make_interval(secs => $3) AS is_stale
        FROM in_progress_requests
        WHERE endpoint_type = $1 AND request_signature = $2
        """,
        endpoint_type, signature, stale_after_seconds,
    )
    if row is None:
        return "released"
    return "stale" if row["is_stale"] else "waiting"


async def steal_stale_claim(endpoint_type: str, signature: str, stale_after_seconds: float) -> bool:
    """Atomically deletes the claim ONLY if it's still stale at the
    instant of deletion (the staleness re-checked inside the same query,
    not trusted from an earlier claim_status() call a moment ago — avoids
    a race where the original claimant finishes and releases normally
    in between). Returns True if a stale row was actually removed, so the
    caller can immediately retry try_claim() on a now-clean slate instead
    of repeatedly detecting the same staleness forever without ever
    resolving it."""
    pool = get_pool()
    row = await pool.fetchrow(
        """
        DELETE FROM in_progress_requests
        WHERE endpoint_type = $1 AND request_signature = $2
          AND (now() - claimed_at) > make_interval(secs => $3)
        RETURNING 1
        """,
        endpoint_type, signature, stale_after_seconds,
    )
    return row is not None


async def coordinated_fetch(endpoint_type: str, signature: str, check_cache, do_fetch,
                             stale_after_seconds: float = DEFAULT_STALE_AFTER_SECONDS,
                             max_wait_seconds: float | None = None, _depth: int = 0):
    """Runs `do_fetch()` if this caller wins the claim for
    (endpoint_type, signature); otherwise waits for whoever DID win to
    finish, then calls `check_cache()` to pick up their result.

    check_cache: async () -> dict | None — should look for an already-
      completed result (e.g. _find_cached_activity's usual query).
    do_fetch: async () -> dict — does the actual FortyGuard submit/store
      and returns the same shape check_cache would.
    """
    if max_wait_seconds is None:
        max_wait_seconds = stale_after_seconds + 30

    won = await try_claim(endpoint_type, signature)
    if won:
        try:
            return await do_fetch()
        finally:
            await release_claim(endpoint_type, signature)

    log_db(f"Waiting on in-progress {endpoint_type} request", {"signature": signature})
    waited = 0.0
    while waited < max_wait_seconds:
        status = await claim_status(endpoint_type, signature, stale_after_seconds)
        if status == "released":
            cached = await check_cache()
            if cached is not None:
                return cached
            # Claimant released without ever producing a cached result
            # (e.g. it errored after claiming but the caller there didn't
            # crash badly enough to leave a stale row) — bounded retry by
            # trying to claim it ourselves, rather than looping forever.
            break
        if status == "stale":
            log_err(f"Stale claim on {endpoint_type} — attempting to take over", {"signature": signature})
            break
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        waited += POLL_INTERVAL_SECONDS

    if _depth >= 2:
        # Already retried twice — stop recursing and just do the fetch
        # ourselves rather than looping indefinitely in a pathological case.
        return await do_fetch()
    return await coordinated_fetch(endpoint_type, signature, check_cache, do_fetch,
                                    stale_after_seconds, max_wait_seconds, _depth + 1)