// TileInsights (satellite / street view / Heat Intelligence) used to keep
// its loaded state in local useState, remounted via `key={tile_id}`
// whenever the selected tile changed. That correctly cleared state when
// switching to a DIFFERENT tile — but it also cleared state when you went
// BACK to the same tile, because closing the drawer / deselecting a tile
// unmounts the component entirely, and a fresh mount has no memory of
// what was already loaded, even for a tile it's shown before.
//
// Fix: keep the actual result data here, at module scope, keyed by the
// tile's real coordinates (not FortyGuard's tile_id, which may not be
// stable across different queries/granularities for the same physical
// spot). This survives unmount/remount and persists for the rest of the
// browser session — a tile loaded once stays loaded, full stop, until the
// page reloads.

const satelliteCache = new Map();
const streetviewCache = new Map();
const reportCache = new Map();

function roundCoord(n) {
  return Math.round(n * 1e5) / 1e5; // ~1m precision — plenty for "same tile"
}

// Satellite depends on date/time (FortyGuard's own recommendation is that
// it match the heatmap query), so a genuinely different date/time is a
// genuinely different request and gets its own cache entry.
export function satelliteKey(lat, lon, date, time) {
  return `${roundCoord(lat)},${roundCoord(lon)},${date || ''},${time || 'default'}`;
}

// Street View has no date/time parameter at all — pure location.
export function streetviewKey(lat, lon) {
  return `${roundCoord(lat)},${roundCoord(lon)}`;
}

// Heat Intelligence is keyed by location + date (temperature is derived
// from the tile automatically, not something the user varies directly).
export function reportKey(lat, lon, date) {
  return `${roundCoord(lat)},${roundCoord(lon)},${date || ''}`;
}

export function getCachedSatellite(key) { return satelliteCache.get(key) ?? null; }
export function setCachedSatellite(key, value) { satelliteCache.set(key, value); }

export function getCachedStreetview(key) { return streetviewCache.get(key) ?? null; }
export function setCachedStreetview(key, value) { streetviewCache.set(key, value); }

export function getCachedReport(key) { return reportCache.get(key) ?? null; }
export function setCachedReport(key, value) { reportCache.set(key, value); }
