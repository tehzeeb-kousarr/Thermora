import { useEffect, useState, useCallback } from 'react';
import { loadExposure, getCachedExposure } from '../lib/exposureStore';

// Schools/hospitals/density for a given AOI (usually defaultBBoxForCity).
// This is "just structured retrieval" (Phase 6) — raw counts and points,
// no scoring. Cached ~30 days on the backend since OSM data barely
// changes, so repeat visits are typically instant.
export function useExposure(bbox) {
  const [data, setData] = useState(() => (bbox ? getCachedExposure(bbox) : null));
  const [loading, setLoading] = useState(!data);
  const [error, setError] = useState(null);

  const sig = bbox ? `${bbox.min_lat}|${bbox.min_lng}|${bbox.max_lat}|${bbox.max_lng}` : null;

  useEffect(() => {
    if (!bbox) return undefined;
    let cancelled = false;
    const mapped = { minLat: bbox.min_lat, minLng: bbox.min_lng, maxLat: bbox.max_lat, maxLng: bbox.max_lng };
    const cached = getCachedExposure(mapped);
    if (cached) {
      setData(cached);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setError(null);
    loadExposure(mapped)
      .then((result) => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message || String(err)); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const refresh = useCallback(() => {
    if (!bbox) return Promise.resolve();
    const mapped = { minLat: bbox.min_lat, minLng: bbox.min_lng, maxLat: bbox.max_lat, maxLng: bbox.max_lng };
    setLoading(true);
    return loadExposure(mapped, { force: true })
      .then((result) => setData(result))
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }, [bbox]);

  return {
    points: data?.points ?? [],
    density: data?.density ?? null,
    fetchedAt: data?.fetched_at ?? null,
    source: data?.source ?? null,
    stale: data?.stale ?? false,
    loading,
    error,
    refresh,
  };
}
