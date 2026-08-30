import { fetchExposure } from '../api/thermoraApi';

// Cache by rounded AOI so trivially-different bboxes still hit the same
// entry — mirrors the backend's own aoi_signature() rounding.
const cache = new Map();
const inflight = new Map();

function signature({ minLat, minLng, maxLat, maxLng }) {
  const r = (v) => Math.round(v * 1e5) / 1e5;
  return [r(minLat), r(minLng), r(maxLat), r(maxLng)].join(',');
}

export async function loadExposure(bbox, { force = false } = {}) {
  const sig = signature(bbox);
  if (!force) {
    const cached = cache.get(sig);
    if (cached) return cached;
    const pending = inflight.get(sig);
    if (pending) return pending;
  }

  const promise = fetchExposure({ ...bbox, forceRefresh: force }).then((result) => {
    cache.set(sig, result);
    inflight.delete(sig);
    return result;
  });
  inflight.set(sig, promise);
  promise.catch(() => inflight.delete(sig));
  return promise;
}

export function getCachedExposure(bbox) {
  return cache.get(signature(bbox)) || null;
}
