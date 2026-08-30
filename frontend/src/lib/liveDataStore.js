// Shared live-data layer for FortyGuard-backed city queries.
//
// The bug this fixes: `useLiveCityData` used to fire its own independent
// fetch on every mount. Locations and Compare each render one card per city,
// so visiting either view fired N simultaneous COLD requests at FortyGuard.
// Whichever city happened to already be cached (usually the active
// dashboard city) rendered instantly; the rest went out concurrently,
// uncached, and could stall or trip FortyGuard's rate limit — so only one
// city ever appeared to work.
//
// This module gives every caller, in every view, one shared:
//   - cache          (same city+query => instant reuse, no refetch)
//   - in-flight map  (same city+query requested twice at once => one
//                      network round trip, both callers await it)
//   - concurrency queue (at most MAX_CONCURRENT_REQUESTS FortyGuard round
//                      trips run app-wide at any moment; everything else
//                      queues politely instead of piling on at once)
import { fetchHeatmap, fetchHeatmapStatus, fetchEnvParams } from '../api/thermoraApi';
import { defaultBBoxForCity } from '../data/cities';
import { LONG_POLL_INTERVAL_MS, LONG_POLL_MAX_ATTEMPTS } from './pollConfig';

const MAX_CONCURRENT_REQUESTS = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST /api/heatmap now returns immediately (status 'Completed' or
// 'Processing') instead of blocking until FortyGuard finishes — see
// routers/heatmap.py. Previously this function just returned that POST's
// response directly, which meant a 'Processing' response (the normal
// case for anything not already cached) would get treated as if it were
// the final heatmap result — empty map_data, no error, just wrong. This
// submits, then polls status until it settles, matching the pattern
// TileInsights.jsx already uses for Heat Intelligence.
//
// The give-up point below (LONG_POLL_MAX_ATTEMPTS * LONG_POLL_INTERVAL_MS)
// is deliberately shared with TileInsights.jsx and kept comfortably past
// the backend's own real ceiling — see pollConfig.js for why: giving up
// here any sooner than the backend genuinely would is what used to show
// "Retry" for a request that the backend then went on to actually
// complete a little later.
async function submitAndPollHeatmap(request) {
  const started = await fetchHeatmap(request);
  if (started.status === 'Completed') return started;
  if (started.status === 'Failed') throw new Error(started.error || 'Heatmap generation failed');

  // 'Processing' — poll our own backend's Postgres-backed status route,
  // never FortyGuard directly.
  for (let attempt = 1; attempt <= LONG_POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(LONG_POLL_INTERVAL_MS);
    const status = await fetchHeatmapStatus(started.signature);
    if (status.status === 'Completed') return status;
    if (status.status === 'Failed') throw new Error(status.error || 'Heatmap generation failed');
    // else 'Processing' — keep polling
  }
  throw new Error('Still processing after several minutes — try again shortly.');
}

let activeCount = 0;
const queue = [];
const cache = new Map(); // signature -> entry
const inflight = new Map(); // signature -> Promise<entry>
const listeners = new Map(); // signature -> Set<fn>

// When a fetch for a given signature started — module scope, same reason
// viewStateByCity in HeatMapView.jsx lives at module scope: switching tabs
// away from Heat Map and back is a genuine unmount/remount (App.jsx renders
// tabs conditionally), not a hide/show. The actual FortyGuard request/poll
// loop already survives that fine (it lives in `inflight`, not in any
// component). But useLiveCityData used to stamp `loadingStartedAt` fresh on
// every mount, so the "Fetching… Xs" counter it drives would silently reset
// to 0/1s on every tab switch even though the real request underneath had
// already been running for a while. Tracking the start time here — keyed by
// signature, cleared only when that signature's fetch actually finishes or
// fails — lets any mount of useLiveCityData recover the true elapsed time
// instead of restarting it.
const startedAtBySignature = new Map(); // signature -> Date

export function getLoadingStartedAt(signature) {
  return startedAtBySignature.get(signature) || null;
}

export function buildSignature(city, q) {
  return [
    city.id, q.date, q.filterType, q.time || '', q.endTime || '', q.endDate || '',
    q.granularity, q.analyticType, q.threshold ?? '', q.direction ?? '',
  ].join('|');
}

function runQueue() {
  while (activeCount < MAX_CONCURRENT_REQUESTS && queue.length) {
    const job = queue.shift();
    activeCount += 1;
    job().finally(() => {
      activeCount -= 1;
      runQueue();
    });
  }
}

function enqueue(job) {
  return new Promise((resolve, reject) => {
    queue.push(() => job().then(resolve, reject));
    runQueue();
  });
}

export function getCached(signature) {
  return cache.get(signature) || null;
}

// Dashboard's own request. Whatever was most recently loaded for this
// city — from Dashboard itself, from Heat Map view, from Time Compare,
// wherever — is what Dashboard shows. Not a separate fetch, not a
// database lookup: this reads the exact same in-memory cache every other
// view already writes to, and just picks the newest entry for this city.
//
// Only considers analyticType === 'tcm' entries. Dashboard's headline
// card is explicitly labeled "Area Mean Temperature" and reads
// heatmap.stats_data.temperature_stats directly — but FortyGuard reuses
// that same temperature_stats container for every analytic type: an
// 'exceedance' or 'persistence' fetch (e.g. from switching Heat Map
// view's Analytic Type and clicking Apply, or from the Risk Score
// checkbox there priming those factors) returns real numbers in that
// same shape, just measuring hours-above-threshold or longest run, not
// temperature. Without this filter, whichever analytic type was fetched
// most recently — regardless of what it actually measured — would win
// here and get shown as "Area Mean Temperature", mislabeled.
export function getMostRecentForCity(cityId) {
  let best = null;
  for (const entry of cache.values()) {
    if (entry.cityId !== cityId) continue;
    if (entry.appliedQuery?.analyticType !== 'tcm') continue;
    if (!best || entry.fetchedAt > best.fetchedAt) best = entry;
  }
  return best;
}

export function isCached(city, query) {
  return !!cache.get(buildSignature(city, query));
}

// NOTE: this used to also maintain a "recently viewed" history, persisted
// to localStorage. That's gone — it was pure browser-local state with no
// connection to the database, so it never emptied out when the database
// was wiped (it was never reading from the database in the first place).
// History is now backed by GET /api/heatmap/history — see HistoryPanel in
// HeatMapView.jsx — which reads real, live data straight from Postgres.

const cityListeners = new Map(); // cityId -> Set<fn>

export function subscribeCity(cityId, fn) {
  if (!cityListeners.has(cityId)) cityListeners.set(cityId, new Set());
  cityListeners.get(cityId).add(fn);
  return () => cityListeners.get(cityId)?.delete(fn);
}

function notifyCity(cityId, entry) {
  cityListeners.get(cityId)?.forEach((fn) => fn(entry));
}

// Cross-view signal for "this city's location_features may have just
// changed" — specifically, riskBoost completing an exceedance/persistence
// fetch. Distinct from cityListeners above (which fire on every ordinary
// heatmap fetch, for cache-display purposes) because RiskScoreCard reads
// a SEPARATE endpoint (Postgres-computed risk-score, not the heatmap
// itself), and lives on a completely different tab/component tree than
// HeatMapView, where riskBoost actually runs — a plain useState counter
// in HeatMapView (as this used to be) is invisible to Dashboard's own
// mounted RiskScoreCard instance, so a riskBoost fetch would complete and
// write real data, but the already-mounted Dashboard card would just
// never find out and keep showing "Missing: Exceedance, Persistence"
// forever, since nothing about its OWN city/date props ever changed to
// trigger a re-fetch.
const riskFactorListeners = new Map(); // cityId -> Set<fn>

export function notifyRiskFactorsUpdated(cityId) {
  riskFactorListeners.get(cityId)?.forEach((fn) => fn());
}

export function subscribeRiskFactorsUpdated(cityId, fn) {
  if (!riskFactorListeners.has(cityId)) riskFactorListeners.set(cityId, new Set());
  riskFactorListeners.get(cityId).add(fn);
  return () => riskFactorListeners.get(cityId)?.delete(fn);
}

export function subscribe(signature, fn) {
  if (!listeners.has(signature)) listeners.set(signature, new Set());
  listeners.get(signature).add(fn);
  return () => listeners.get(signature)?.delete(fn);
}

function notify(signature, entry) {
  listeners.get(signature)?.forEach((fn) => fn(entry));
}

// Loads heatmap + env params for a city/query pair (cached, deduped, queued).
// Pass { force: true } for an explicit user-triggered "Refresh" — this both
// bypasses the frontend cache AND tells the backend to bypass its own
// Postgres cache (force_refresh), so it's a real new FortyGuard read.
export async function loadCityData(city, query, { force = false } = {}) {
  const signature = buildSignature(city, query);

  if (!force) {
    const cached = cache.get(signature);
    if (cached) return cached;
    const pending = inflight.get(signature);
    if (pending) return pending;
  }

  // Stamp the start time once per signature (an already-in-flight follower
  // call, or a remounted component picking this same fetch back up, reuses
  // the original stamp). A `force` refresh is a genuinely new request, so it
  // always gets its own fresh stamp.
  if (force || !startedAtBySignature.has(signature)) {
    startedAtBySignature.set(signature, new Date());
  }

  const promise = enqueue(async () => {
    const bbox = defaultBBoxForCity(city);
    const heatmapResult = await submitAndPollHeatmap({
      minLat: bbox.min_lat,
      minLng: bbox.min_lng,
      maxLat: bbox.max_lat,
      maxLng: bbox.max_lng,
      date: query.date,
      time: query.time || undefined,
      endTime: query.endTime || undefined,
      endDate: query.endDate || undefined,
      filterType: query.filterType,
      granularity: query.granularity,
      analyticType: query.analyticType,
      threshold: query.threshold,
      direction: query.direction,
      forceRefresh: force,
    });

    // Env params needs a temperature input; use the heatmap's mean once
    // it's back — FortyGuard's schema requires some number here even
    // though it also returns independently-measured parameters.
    //
    // time/date here MUST reuse the exact same window the heatmap request
    // was resolved for (query.time/query.date — already pinned by
    // useLiveCityData, not recomputed here), not "whatever hour it
    // happens to be right now". This used to call currentHourHHMM()
    // instead, which meant the heatmap and env-params halves of the same
    // card could silently describe two different hours (heatmap: the
    // pinned hour from when the user clicked Load; env-params: whatever
    // hour it happened to be by the time this specific request went out,
    // possibly minutes or tab-switches later). Both are shown together in
    // one card, so they need to describe the same moment.
    const meanTemp = heatmapResult?.stats_data?.temperature_stats?.mean ?? 25;
    const envResult = await fetchEnvParams({
      latitude: city.lat,
      longitude: city.lon,
      temperature: meanTemp,
      date: query.date,
      time: query.time || undefined,
      forceRefresh: force,
    });

    const entry = {
      cityId: city.id,
      heatmap: heatmapResult,
      envParams: envResult,
      appliedQuery: query,
      fetchedAt: new Date(),
    };
    cache.set(signature, entry);
    inflight.delete(signature);
    startedAtBySignature.delete(signature);
    notify(signature, entry);
    notifyCity(city.id, entry);
    return entry;
  });

  inflight.set(signature, promise);
  promise.catch(() => {
    inflight.delete(signature);
    startedAtBySignature.delete(signature);
  });
  return promise;
}

// Fires a heatmap request purely to populate the backend's derived
// location_features table (see location_features.py) — e.g. Heat Map
// view's "Also fetch Exceedance & Persistence" checkbox uses this to feed
// the Risk Score without changing what's on the map. Reuses the same
// submit/poll/queue machinery as loadCityData (so it still politely waits
// its turn behind MAX_CONCURRENT_REQUESTS and still benefits from the
// backend's own Postgres cache).
//
// DOES write into `cache`, under its OWN filterType:3/granularity:100
// signature (never the caller's original signature, so it can't collide
// with or overwrite a real single-hour entry) — that's what lets
// isCached()/getCached() find it afterwards, which is exactly what the
// Display section's "Now Showing" buttons check to unlock, and what lets
// switching the preview hit the cache instantly instead of re-fetching
// live. This used to skip `cache` entirely, which meant those buttons
// stayed disabled forever even after a fully successful background
// fetch, since isCached() reading this same cache is the only thing they
// check.
//
// Deliberately does NOT call notifyCity() — that's the one thing that
// feeds getMostRecentForCity()/DashboardView's "headline" temperature
// card, and an exceedance/persistence result (an hours-above-threshold
// count, not a temperature) must never become what that card displays.
// notify(signature, ...) IS still called — that's scoped to this one
// signature, not city-wide, so it only reaches a component already
// subscribed to this exact preview (e.g. Display already switched to it
// before the fetch finished) and still can't leak into the headline card.
//
// filterType and granularity are UNCONDITIONALLY forced below, regardless
// of what's in `query` — this isn't a default, it's a correctness
// requirement:
//   - filterType 3 (single day): FortyGuard's exceedance/persistence
//     metrics ARE hours-above-threshold / longest-run over a WINDOW.
//     Passing through the caller's own filterType (e.g. 1, single hour —
//     Heat Map's own default) would ask for "hours above threshold"
//     within a single hour, which is structurally near-meaningless (max
//     possible value: 1) and produces a Risk Score component that looks
//     present but tells you almost nothing. risk_score.py's own curves
//     are calibrated assuming a 0–24 single-day range.
//   - granularity 100 (coarsest): location_features.record_heatmap_result
//     only ever reads stats_data.temperature_stats (the pre-aggregated
//     mean/min/max FortyGuard already computes) — it never touches
//     map_data, the per-tile grid. Fetching this at 60m (Heat Map's own
//     "most detail" default) computes a tile grid nobody reads, for
//     several times the FortyGuard-side cost of 100m, for identical
//     accuracy on the one number this call actually needs.
export function primeRiskScoreFactor(city, query) {
  const bbox = defaultBBoxForCity(city);
  const resolvedQuery = {
    ...query,
    time: undefined,
    endTime: undefined,
    endDate: undefined,
    filterType: 3,
    granularity: 100,
  };
  const signature = buildSignature(city, resolvedQuery);

  const cached = cache.get(signature);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(signature);
  if (pending) return pending;

  const promise = enqueue(async () => {
    const heatmapResult = await submitAndPollHeatmap({
      minLat: bbox.min_lat,
      minLng: bbox.min_lng,
      maxLat: bbox.max_lat,
      maxLng: bbox.max_lng,
      date: resolvedQuery.date,
      time: resolvedQuery.time,
      endTime: resolvedQuery.endTime,
      endDate: resolvedQuery.endDate,
      filterType: resolvedQuery.filterType,
      granularity: resolvedQuery.granularity,
      analyticType: resolvedQuery.analyticType,
      threshold: resolvedQuery.threshold,
      direction: resolvedQuery.direction,
      forceRefresh: false,
      // Tags this request in fortyguard_activities' stored payload (never
      // sent to FortyGuard itself, never affects caching — see
      // repository.py's get_heatmap) so History can show it distinctly
      // from something the user actually looked at on screen. See
      // HistoryPanel.
      purpose: 'risk_factor_background',
    });

    const entry = {
      cityId: city.id,
      heatmap: heatmapResult,
      envParams: null, // this path never fetches env-params — only the heatmap side is needed for exceedance/persistence
      appliedQuery: resolvedQuery,
      fetchedAt: new Date(),
    };
    cache.set(signature, entry);
    inflight.delete(signature);
    notify(signature, entry); // signature-scoped only — see comment above for why notifyCity is skipped
    return entry;
  });

  inflight.set(signature, promise);
  promise.catch(() => inflight.delete(signature));
  return promise;
}