import { useEffect, useMemo, useState, useCallback } from 'react';
import { todayISO, lastCompletedHourHHMM, lastCompletedHourDateISO } from '../lib/queryWindow';
import { loadCityData, getCached, subscribe, buildSignature, getLoadingStartedAt } from '../lib/liveDataStore';

// Default is now a single, already-elapsed hour — NOT an unscoped "Single
// Day" (filterType 3) request. A Single Day request with no start_time
// asks FortyGuard for the full 00:00–23:59 span; when `date` resolves to
// today, that span includes hours later today that haven't happened yet.
// FortyGuard's own guidance is that requests must stay within their valid
// date/time range (today, or up to 12h forecast) — an unscoped full-day
// request for "today" silently straddles that boundary, which is a
// plausible cause of the empty-tiles/500 failures seen in practice.
//
// Users can still explicitly choose Single Day, Range of Hours, or Range
// of Days from the Heat Map view's filter controls — nothing about those
// options changed. This only changes what fires automatically (Dashboard,
// Research, and anywhere else that doesn't pass its own filterType/time).
export const DEFAULT_QUERY = {
  analyticType: 'tcm',
  granularity: 60, // finest tiles by default — see queryWindow.js
  filterType: 1, // single hour — see comment above for why not "single day"
  date: null, // resolved to lastCompletedHourDateISO() at call time
  time: null, // resolved to lastCompletedHourHHMM() at call time
  endTime: null,
  endDate: null,
  threshold: 30, // only used by exceedance/persistence
  direction: 'above',
};

// Fetches live heatmap + live environmental parameters (current hour,
// city-center point) for the given city. `query` controls exactly what
// window/resolution the heatmap request asks FortyGuard for — every field
// in `query` requires a real network round-trip when it changes, since
// FortyGuard computes the result server-side. Anything NOT in `query`
// (color scheme, units, class count, opacity, ...) is a pure display
// concern and should live in the component instead, applied instantly to
// whatever `heatmap` already holds with no refetch.
//
// Backed by `lib/liveDataStore`: identical city+query requests from
// different components (e.g. Dashboard and a Locations card both showing
// Houston) share one cached result and one in-flight request, and the
// whole app shares one small concurrency queue — so mounting many cards at
// once (Locations, Compare) queues politely instead of firing a burst of
// simultaneous cold requests at FortyGuard.
// Module-scope, not component-scope: a useRef alone resets on every real
// unmount/remount (App.jsx renders tabs conditionally — switching tabs
// away and back is a genuine unmount, not a hide/show), which would only
// half-fix the problem below. Keyed by city id.
const pinnedNowByCity = new Map(); // cityId -> { date, time }

// Bug fix — this used to take just `cityId` (a string) and call
// lastCompletedHourDateISO()/lastCompletedHourHHMM() with NO city
// argument, silently falling back to the BROWSER's local timezone. That
// directly conflicted with locations.py's city_local_now/local_today,
// which every backend module (Risk, Impact, Emergency, Heat Story,
// scheduler) was deliberately centralized on for exactly this reason —
// see that function's own docstring. A person viewing Phoenix from a
// browser set to Eastern time would get "today's last completed hour"
// computed in EASTERN time here, then send that clock string to
// FortyGuard as if it were Phoenix's own local hour — FortyGuard has no
// way to know it's wrong, so it just returns real data for the WRONG
// moment in Phoenix's day (up to several hours off, and in the
// occasionally-actually-future direction, not just "different"). That
// value then gets persisted into location_features as if it were a
// normal completed observation, silently contaminating the exact
// "observed" data Heat Story's whole persist=False/forecast split (see
// repository.py's get_heatmap) was built to keep clean. Needs the full
// `city` object now, not just its id, since that's what carries
// `.timezone`.
function getPinnedNow(city) {
  if (!pinnedNowByCity.has(city.id)) {
    pinnedNowByCity.set(city.id, { date: lastCompletedHourDateISO(city), time: lastCompletedHourHHMM(city) });
  }
  return pinnedNowByCity.get(city.id);
}

// Recomputes and overwrites this city's pinned "now" from the real clock,
// then returns the new value. Called from exactly two places by design:
// (1) Heat Map view's own hour-boundary watcher, ONLY while that view is
// in "live" mode (see HeatMapView.jsx's `isLive`) — a manually-queried
// past date/hour must never be silently swapped out from under the user;
// (2) an explicit "Back to live" action. Never called just because a
// component remounted or a tab was revisited — that's exactly the
// silent-refetch-on-tab-switch behavior getPinnedNow above exists to
// prevent, and this function bypasses that guard on purpose, so it must
// stay opt-in and explicit.
export function advancePinnedNow(city) {
  const next = { date: lastCompletedHourDateISO(city), time: lastCompletedHourHHMM(city) };
  pinnedNowByCity.set(city.id, next);
  return next;
}

// Read-only peek at the current pinned value (or what it WOULD be if
// nothing has pinned yet) without pinning anything — used by HeatMapView
// to detect "the real-world hour has moved past what's pinned" without
// that check itself causing a pin.
export function peekLiveNow(city) {
  return { date: lastCompletedHourDateISO(city), time: lastCompletedHourHHMM(city) };
}

export function useLiveCityData(city, query = DEFAULT_QUERY) {
  // "Last completed hour" is pinned once per city (module scope, above —
  // not per-render, not per-mount) rather than recomputed every time this
  // resolves. Otherwise a remount (e.g. switching tabs away from
  // Dashboard and back) at a later wall-clock hour resolves to a NEW
  // date/time, which is a NEW cache signature, which looks like a cache
  // miss even though the user already loaded this exact city moments
  // ago. That produced a real, needless live re-fetch on every tab
  // switch once enough wall-clock time had passed — silently defeating
  // the "already loaded, don't fetch again" gate (requestedGateStore) at
  // the hook level, one layer below where that gate could see it.
  //
  // Keyed by city.id so switching to a genuinely different city still
  // resolves a fresh "now" for that city, as it should. A city's pinned
  // hour only ever moves forward via an explicit "Refresh" click
  // (useLiveCityData's own DEFAULT_QUERY resolution doesn't re-pin —
  // refresh() below passes resolvedQuery, which already carries whatever
  // was pinned, so a refresh re-fetches the SAME hour's data fresh from
  // FortyGuard rather than jumping to a new hour on its own; the user
  // gets a new hour by navigating away and back after enough real time
  // has passed, or by picking one explicitly in Heat Map view).
  const resolvedQuery = useMemo(() => {
    const merged = { ...DEFAULT_QUERY, ...query };
    // Only fall back to "last completed hour" when the caller is using the
    // default single-hour shape (no explicit date/time of their own) —
    // an explicit Single Day / Range of Hours / Range of Days request
    // (filterType 2/3/4, chosen deliberately via the Heat Map view's
    // filter controls) keeps its own date/time exactly as given.
    const usingDefaultSingleHour = merged.filterType === 1 && !query.date && !query.time;
    const pinned = city ? getPinnedNow(city) : null;
    const date = query.date || (usingDefaultSingleHour && pinned ? pinned.date : todayISO(city));
    const time = query.time || (usingDefaultSingleHour && pinned ? pinned.time : merged.time);
    return { ...merged, date, time };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    query.analyticType,
    query.granularity,
    query.filterType,
    query.date,
    query.time,
    query.endTime,
    query.endDate,
    query.threshold,
    query.direction,
    city?.id,
  ]);

  const signature = city ? buildSignature(city, resolvedQuery) : null;

  const [entry, setEntry] = useState(() => (signature ? getCached(signature) : null));
  const [loading, setLoading] = useState(!entry);
  const [error, setError] = useState(null);
  // Sourced from liveDataStore's own module-scope stamp (keyed by
  // signature), not stamped fresh here. Switching tabs away from Heat Map
  // and back is a real unmount/remount of this hook — a plain `new Date()`
  // on every mount would restart the "Fetching… Xs" counter at 0/1s even
  // though the actual request (which lives in liveDataStore, not in this
  // component) has been running the whole time. Reading the store's stamp
  // instead means the counter keeps counting through a tab switch, whether
  // this is the very first mount to ask for this signature or the third.
  const [loadingStartedAt, setLoadingStartedAt] = useState(() => (
    !entry && signature ? getLoadingStartedAt(signature) : null
  ));

  useEffect(() => {
    if (!city || !signature) return undefined;
    let cancelled = false;

    const cached = getCached(signature);
    if (cached) {
      setEntry(cached);
      setLoading(false);
      setLoadingStartedAt(null);
    } else {
      setEntry(null);
      setLoading(true);
      setError(null);
    }

    const unsubscribe = subscribe(signature, (next) => {
      if (cancelled) return;
      setEntry(next);
      setLoading(false);
      setLoadingStartedAt(null);
      setError(null);
    });

    if (!cached) {
      loadCityData(city, resolvedQuery).catch((err) => {
        if (cancelled) return;
        setError(err.message || String(err));
        setLoading(false);
        setLoadingStartedAt(null);
      });
      // loadCityData stamps liveDataStore's start-time map synchronously
      // (before any await) if it isn't already stamped for this signature,
      // so reading it right after the call above always sees the correct
      // value — whichever mount/component first kicked this fetch off.
      setLoadingStartedAt(getLoadingStartedAt(signature));
    }

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [city?.id, signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    if (!city) return Promise.resolve();
    setLoading(true);
    setError(null);
    const promise = loadCityData(city, resolvedQuery, { force: true });
    // force: true always re-stamps a fresh start time in the store (see
    // liveDataStore.js), so this reflects the new request, not a stale one.
    setLoadingStartedAt(getLoadingStartedAt(signature));
    return promise
      .then((next) => setEntry(next))
      .catch((err) => setError(err.message || String(err)))
      .finally(() => { setLoading(false); setLoadingStartedAt(null); });
  }, [city, resolvedQuery, signature]);

  return {
    heatmap: entry?.heatmap ?? null,
    envParams: entry?.envParams ?? null,
    loading,
    loadingStartedAt,
    error,
    fetchedAt: entry?.fetchedAt ?? null,
    appliedQuery: entry?.appliedQuery ?? null,
    refresh,
  };
}

// Wrapper for call sites that must not fetch anything until the user has
// explicitly asked for a specific window (e.g. TimeCompareView's two
// panes, idle until "Request Data" is clicked). Passing `query: null`
// disables the fetch entirely — useLiveCityData's own effect already
// no-ops when `city` is falsy, so this reuses that guard rather than
// duplicating fetch logic. Once `query` is set, this behaves exactly
// like useLiveCityData(city, query).
export function useLiveCityDataIfRequested(city, query) {
  return useLiveCityData(query ? city : null, query || DEFAULT_QUERY);
}

// Watches the real clock for this city and calls `onAdvance(next)` the
// moment its local hour genuinely moves past whatever is currently
// pinned — e.g. 2:00pm becomes 3:00pm, so "last completed hour" changes
// from 1:00pm to 2:00pm. Does nothing while `enabled` is false, which is
// how Heat Map view keeps a manually-picked past date/hour from being
// silently swapped out: pass `isLive` as `enabled`, and this only ever
// fires while the view is actually showing "now", never while it's
// showing something the user explicitly asked for.
//
// A plain interval polling a cheap local Intl.DateTimeFormat call (no
// network) — checked every 60s, which is frequent enough that an hour
// boundary is never missed by more than a minute, and cheap enough to
// leave running for an entire session.
export function useAutoAdvanceLive(city, enabled, onAdvance) {
  useEffect(() => {
    if (!city || !enabled) return undefined;
    const tick = () => {
      const pinned = getPinnedNow(city);
      const fresh = peekLiveNow(city);
      if (fresh.date !== pinned.date || fresh.time !== pinned.time) {
        advancePinnedNow(city);
        onAdvance(fresh);
      }
    };
    // Also check immediately on setup, not just on the next 60s tick.
    // This effect re-runs whenever `enabled` flips true or `city`
    // changes — including when HeatMapView itself just remounted after
    // being away (see the view-state persistence in HeatMapView.jsx,
    // which restores `isLive` across tab switches). Without this
    // immediate check, a view that was live before being unmounted for,
    // say, two real hours would sit on the stale pinned hour until the
    // FIRST new interval tick fired up to 60s later — silently not
    // "live" for that window even though isLive said it was. Real drift
    // accumulated while unmounted (pinnedNowByCity doesn't advance on
    // its own) is exactly what this catches up on the spot.
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city?.id, enabled]);
}