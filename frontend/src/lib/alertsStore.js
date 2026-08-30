// Shared "manually refreshed alerts" layer, mirroring the pattern in
// liveDataStore.js.
//
// The bug this fixes: AlertsCard is mounted twice — once on the Overview
// (Dashboard) tab, once on Emergency Mode — each as its own React
// component instance. Before this store existed, "manually refreshed"
// alerts lived in that component's own useState, so clicking "Check now"
// on Overview only updated Overview's instance; Emergency Mode's instance
// knew nothing about it until the background scheduler happened to catch
// up (up to SCHEDULER_INTERVAL_MINUTES later) and both independently
// re-read the same new value from /latest.
//
// This module gives every AlertsCard instance, for a given city, one
// shared manual-refresh result and one set of subscribers — so a "Check
// now" click anywhere is reflected everywhere immediately.
import { fetchCityAlerts } from '../api/thermoraApi';

const manualByCity = new Map(); // cityId -> { alerts, fetchedAt }
const inflight = new Map(); // cityId -> Promise
const listeners = new Map(); // cityId -> Set<fn>

export function getManualAlerts(cityId) {
  return manualByCity.get(cityId) || null;
}

export function subscribeManualAlerts(cityId, fn) {
  if (!listeners.has(cityId)) listeners.set(cityId, new Set());
  listeners.get(cityId).add(fn);
  return () => listeners.get(cityId)?.delete(fn);
}

function notify(cityId, entry) {
  listeners.get(cityId)?.forEach((fn) => fn(entry));
}

// Triggers a real NWS refresh (force_refresh=true) and broadcasts the
// result to every subscribed AlertsCard instance for this city. Concurrent
// "Check now" clicks (e.g. from two open instances at once) share one
// in-flight request rather than firing two.
export async function refreshAlerts(cityId) {
  const pending = inflight.get(cityId);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const result = await fetchCityAlerts(cityId, true);
      const entry = { alerts: result.alerts || [], fetchedAt: result.fetched_at };
      manualByCity.set(cityId, entry);
      notify(cityId, entry);
      return entry;
    } finally {
      inflight.delete(cityId);
    }
  })();

  inflight.set(cityId, promise);
  return promise;
}
