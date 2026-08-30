import { useEffect, useState, useCallback } from 'react';
import { fetchCities } from '../api/thermoraApi';

// Used before the real backend list arrives (first paint) or if the
// backend is briefly unreachable — so the app never regresses to showing
// fewer locations than actually exist. Mirrors backend/app/locations.py
// exactly; if a city is added there, add it here too so the UI never
// looks like it "lost" a location during a slow/failed fetch.
const BOOT_FALLBACK = [
  { id: 'dfw', name: 'Dallas–Fort Worth', state: 'Texas', lat: 32.7767, lon: -96.7970 },
  { id: 'houston', name: 'Houston', state: 'Texas', lat: 29.7604, lon: -95.3698 },
  { id: 'austin', name: 'Austin', state: 'Texas', lat: 30.2672, lon: -97.7431 },
  { id: 'san-antonio', name: 'San Antonio', state: 'Texas', lat: 29.4241, lon: -98.4936 },
  { id: 'phoenix', name: 'Phoenix', state: 'Arizona', lat: 33.4484, lon: -112.0740 },
  { id: 'miami', name: 'Miami', state: 'Florida', lat: 25.7617, lon: -80.1918 },
];

export function useCities() {
  const [cities, setCities] = useState(BOOT_FALLBACK);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return fetchCities()
      .then((list) => {
        // Only replace the fallback with a shorter list if the backend
        // explicitly says so — a failed/empty response should never make
        // the visible location count go DOWN from what we already have.
        if (list.length) setCities((prev) => (list.length >= prev.length ? list : prev));
      })
      .catch((err) => {
        setError(err.message || String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().then(() => {
      // One quiet retry if the first attempt failed (e.g. backend was
      // still starting up) — common right after a fresh `uvicorn` boot.
      if (!cancelled) {
        setTimeout(() => { if (!cancelled) load(); }, 4000);
      }
    });
    return () => { cancelled = true; };
  }, [load]);

  return { cities, loading, error, refresh: load };
}
