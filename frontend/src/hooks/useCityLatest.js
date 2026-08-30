import { useEffect, useState, useCallback } from 'react';
import { fetchCityLatest } from '../api/thermoraApi';

// Short-TTL shared cache across ALL mounts of this hook, for ALL
// components (AlertsCard, CompareView, ...). Without this, switching tabs
// back and forth (which unmounts/remounts whichever component uses this
// hook) re-fetched the SAME already-loaded city over and over — every
// remount looked identical to "never loaded before" even a few seconds
// after it genuinely had been. This does NOT fetch anything for a city
// nobody has viewed; it only avoids re-fetching a city that was just
// loaded a moment ago.
const CACHE_TTL_MS = 45_000;
const cache = new Map(); // cityId -> { data, fetchedAt }
const inflight = new Map(); // cityId -> Promise

function getFresh(cityId) {
  const entry = cache.get(cityId);
  if (!entry) return null;
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS ? entry.data : null;
}

async function loadCached(cityId, { force = false } = {}) {
  if (!force) {
    const fresh = getFresh(cityId);
    if (fresh) return fresh;
    const pending = inflight.get(cityId);
    if (pending) return pending;
  }
  const promise = fetchCityLatest(cityId).then((data) => {
    cache.set(cityId, { data, fetchedAt: Date.now() });
    inflight.delete(cityId);
    return data;
  });
  inflight.set(cityId, promise);
  promise.catch(() => inflight.delete(cityId));
  return promise;
}

// Loads ONE city's summary (mean temp + env params + alerts), lazily and
// on-demand — this hook mounting is exactly what triggers the backend to
// load that specific city if it hasn't been loaded recently (see
// routers/cities.py's /latest, which fetches live on a cache miss rather
// than relying on a background job). Nothing is fetched for a city this
// hook was never asked to render, and a city fetched within the last
// CACHE_TTL_MS is served from the shared cache above instead of hitting
// the backend again. Call `refresh()` to force a real re-check.
export function useCityLatest(cityId) {
  const [data, setData] = useState(() => getFresh(cityId));
  const [loading, setLoading] = useState(!getFresh(cityId));
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fresh = getFresh(cityId);
    if (fresh) {
      setData(fresh);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError(null);
    loadCached(cityId)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cityId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadCached(cityId, { force: true });
      setData(result);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [cityId]);

  return {
    heatmap: data?.heatmap ?? null,
    envParams: data?.envParams ?? null,
    alerts: data?.alerts ?? [],
    updatedAt: data?.updatedAt ?? null,
    pending: false, // /latest now always resolves to real data or an error — nothing "waits on a scheduler" anymore
    loading,
    error,
    refresh,
  };
}
