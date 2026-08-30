// Shared polling timing for any "submit, then poll our own status" flow
// (heatmap generation, Heat Intelligence report generation — see
// liveDataStore.js and TileInsights.jsx).
//
// The bug this fixes: both call sites used to hardcode their own copy of
// "90 attempts * 5000ms = 7.5 min" and give up with a hard error after
// that. But the BACKEND's own real ceiling for a single FortyGuard
// activity is POLL_MAX_ATTEMPTS * POLL_INTERVAL_SECONDS = 120 * 5s = 10
// minutes (see backend/app/config.py), and request_coordination.py's
// cross-process claim can legitimately keep a caller waiting up to
// DEFAULT_STALE_AFTER_SECONDS = 660s (11 min) on top of that in the
// coordinated (non-force) path.
//
// Because the frontend's 7.5-minute give-up point was SHORTER than the
// backend's ~10-11 minute one, any request that genuinely took between
// 7.5 and 11 minutes — well within FortyGuard's own "may take several
// minutes" territory, especially wide date ranges / fine granularity
// heatmaps, or Heat Intelligence — would show up here as a hard failure
// ("Retry") while the backend was still legitimately working and went on
// to log a real success moments later. Clicking "Retry" then made it
// worse: it passes force_refresh, which skips the cache the
// about-to-land background job was about to populate and starts a
// second, fully redundant multi-minute FortyGuard submission.
//
// The fix is to never give up before the backend legitimately would.
// LONG_POLL_MAX_ATTEMPTS * LONG_POLL_INTERVAL_MS is set comfortably past
// the backend's worst realistic ceiling, so by the time the frontend
// would give up, the backend has already either completed the job or
// itself marked it 'Failed' (which polling surfaces as a real, accurate
// error — not a false one racing a still-succeeding background job).
export const LONG_POLL_INTERVAL_MS = 5000;
export const LONG_POLL_MAX_ATTEMPTS = 150; // 150 * 5s = 12.5 min
