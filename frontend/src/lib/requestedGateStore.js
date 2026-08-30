// A component's own useState resets to its initial value every time React
// unmounts and remounts it — which is exactly what happens on every tab
// switch, since App.jsx renders tabs conditionally
// (`activeTab === 'dashboard' && <DashboardView .../>`), not via
// CSS-hiding. DashboardView, ResearchView, and TimeCompareView all gate
// their first FortyGuard fetch behind a "Load live data" / "Request Data"
// click, tracked in a local `useState(false)` — so switching away and
// back made that button reappear and required clicking again, even
// though the actual data was still sitting untouched in liveDataStore's
// cache the whole time.
//
// This doesn't fix a wasted network request — useLiveCityData already
// checks its own cache before fetching, so re-showing the button and
// re-clicking it was never a duplicate FortyGuard call, just an
// unnecessary extra click and a moment of "wait, didn't I already load
// this?" confusion. Fixed by moving the "was this already requested"
// flag out of component state and into module scope, same pattern as
// tileInsightsCache.js uses for tile data itself — keyed by whatever the
// caller considers the identity of "this same request" (usually a city
// id, sometimes combined with a query shape for callers with more than
// one independent gate, like TimeCompareView's two panes).
const requested = new Set();
const requestedValues = new Map();

export function wasRequested(key) {
  return requested.has(key);
}

export function markRequested(key) {
  requested.add(key);
}

// For callers whose "requested" state is more than a boolean — e.g.
// TimeCompareView's requestedA/requestedB, which store the actual query
// object that was submitted (compared against the live draft to detect
// unsaved edits), not just "was something ever requested". Same
// module-scope survival as the boolean flag above, for the same reason:
// switching tabs away and back unmounts the component, and a plain
// useState would forget which window was actually last requested.
export function getRequestedValue(key) {
  return requestedValues.get(key) ?? null;
}

export function setRequestedValue(key, value) {
  requestedValues.set(key, value);
}

// Only meaningful for an explicit "start over" action (none exist in the
// UI today) — included for completeness, not currently called anywhere.
export function clearRequested(key) {
  requested.delete(key);
}
