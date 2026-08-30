// Thin client for the Thermora backend. All calls are real, live requests —
// the backend itself talks to FortyGuard and returns actual results.
import { apiUrl } from '../config/api';

async function postJSON(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function getJSON(path) {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

export function fetchHeatmap({
  minLat, minLng, maxLat, maxLng, date, time, endTime, endDate,
  filterType, granularity = 60, analyticType = 'tcm', threshold, direction,
  forceRefresh = false, purpose,
}) {
  return postJSON('/api/heatmap', {
    min_lat: minLat,
    min_lng: minLng,
    max_lat: maxLat,
    max_lng: maxLng,
    granularity,
    date,
    time,
    end_time: endTime,
    end_date: endDate,
    filter_type: filterType ?? (time ? 1 : 3),
    analytic_type: analyticType,
    ...(threshold != null ? { threshold } : {}),
    ...(direction != null ? { direction } : {}),
    force_refresh: forceRefresh,
    ...(purpose ? { purpose } : {}),
  });
}

// The POST above returns immediately (status 'Completed' or 'Processing')
// instead of blocking until FortyGuard finishes — see routers/heatmap.py.
// Poll this until status settles. Pure Postgres read on the backend, never
// touches FortyGuard directly.
export async function fetchHeatmapStatus(signature) {
  const res = await fetch(apiUrl(`/api/heatmap/status?signature=${encodeURIComponent(signature)}`));
  if (!res.ok) throw new Error(`fetchHeatmapStatus failed (${res.status})`);
  return res.json();
}

export function fetchEnvParams({ latitude, longitude, temperature, date, time, forceRefresh = false }) {
  return postJSON('/api/env-params', {
    latitude,
    longitude,
    temperature,
    date,
    time,
    filter_type: time ? 1 : 3,
    force_refresh: forceRefresh,
  });
}

export function fetchSatellite({ latitude, longitude, date, time }) {
  return postJSON('/api/satellite', { latitude, longitude, date, time, filter_type: time ? 1 : 3 });
}

export function fetchStreetview({ latitude, longitude, verticalAngle = 10, horizontalAngle = 90, backView = false }) {
  return postJSON('/api/streetview', {
    latitude,
    longitude,
    vertical_angle: verticalAngle,
    horizontal_angle: horizontalAngle,
    back_view: backView,
  });
}

// Returns immediately with {activity_id, status: 'Processing'} (or
// 'Completed' + download_url on a cache hit) — never blocks on
// FortyGuard's own processing time. Poll fetchHeatIntelligenceStatus()
// below until status is 'Completed' or 'Failed'.
export function fetchHeatIntelligence({ latitude, longitude, temperature, date, analysis = ['environmental'], forceRefresh = false }) {
  return postJSON('/api/heat-intelligence', { latitude, longitude, temperature, date, analysis, force_refresh: forceRefresh });
}

// Pure Postgres read on the backend — never touches FortyGuard directly.
export async function fetchHeatIntelligenceStatus(activityId) {
  const res = await fetch(apiUrl(`/api/heat-intelligence/${activityId}/status`));
  if (!res.ok) throw new Error(`fetchHeatIntelligenceStatus failed (${res.status})`);
  return res.json();
}

export async function fetchStatus() {
  const res = await fetch(apiUrl('/api/status'));
  if (!res.ok) throw new Error(`status check failed (${res.status})`);
  return res.json();
}

// Cheap, memory-only read — no FortyGuard call happens on the backend for
// this one. Populated in the background by the scheduler on a fixed
// cadence. Used by views that show many cities at once (Locations,
// Compare) so opening them never triggers a burst of live fetches.
export async function fetchCityLatest(cityId) {
  const res = await fetch(apiUrl(`/api/cities/${cityId}/latest`));
  if (res.status === 404) return null; // scheduler hasn't warmed this city yet
  if (!res.ok) throw new Error(`fetchCityLatest failed (${res.status})`);
  return res.json();
}

// The list of monitored cities — single source of truth is the backend
// (locations.py). The frontend used to keep its own hardcoded copy in
// data/cities.js; that's gone now specifically so the two can't drift.
export async function fetchCities() {
  const res = await fetch(apiUrl('/api/cities'));
  if (!res.ok) throw new Error(`fetchCities failed (${res.status})`);
  const body = await res.json();
  return body.cities || [];
}

// Phase 6 — OSM exposure points + density for an AOI. Cached ~30 days on
// the backend since this data barely changes; a live Overpass call only
// happens on a genuine cache miss or an explicit forceRefresh.
export function fetchExposure({ minLat, minLng, maxLat, maxLng, forceRefresh = false }) {
  return postJSON('/api/exposure', {
    min_lat: minLat, min_lng: minLng, max_lat: maxLat, max_lng: maxLng,
    force_refresh: forceRefresh,
  });
}

// Phase 7 — NWS/NOAA active alerts for a monitored city. Cheap: usually
// served from the scheduler-refreshed live_cache via fetchCityLatest;
// this direct endpoint exists for an explicit "check now" bypassing that
// cadence (forceRefresh=true always does a real live NWS call).
export async function fetchCityAlerts(cityId, forceRefresh = false) {
  const res = await fetch(apiUrl(`/api/cities/${cityId}/alerts${forceRefresh ? '?force_refresh=true' : ''}`));
  if (!res.ok) throw new Error(`fetchCityAlerts failed (${res.status})`);
  return res.json();
}

// Real, database-backed "recently viewed" heatmap queries for a city —
// reads directly from Postgres (fortyguard_activities), NOT localStorage.
// Reflects exactly what's actually cached server-side; empties out if the
// database does.
export async function fetchHeatmapHistory(cityId, limit = 10) {
  const res = await fetch(apiUrl(`/api/heatmap/history?city_id=${encodeURIComponent(cityId)}&limit=${limit}`));
  if (!res.ok) throw new Error(`fetchHeatmapHistory failed (${res.status})`);
  const body = await res.json();
  return body.entries || [];
}

// Phase 8 — deterministic Heat Risk Score. Pure computation over
// location_features already in Postgres; no FortyGuard call happens here
// at all, so this is cheap to call whenever there's a date worth scoring.
export async function fetchRiskScore(cityId, date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(apiUrl(`/api/cities/${cityId}/risk-score${qs}`));
  if (!res.ok) throw new Error(`fetchRiskScore failed (${res.status})`);
  return res.json();
}

// Phase 13 — Local Heat Advisor. Pure presentation-layer transform of the
// exact same risk-score call above, reframed per audience server-side —
// this makes no separate FortyGuard/exposure call of its own.
export async function fetchAdvisorPersonas() {
  const res = await fetch(apiUrl('/api/advisor/personas'));
  if (!res.ok) throw new Error(`fetchAdvisorPersonas failed (${res.status})`);
  return res.json();
}

export async function fetchAdvisor(cityId, persona, date) {
  const params = new URLSearchParams({ persona });
  if (date) params.set('date', date);
  const res = await fetch(apiUrl(`/api/cities/${cityId}/advisor?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchAdvisor failed (${res.status})`);
  return res.json();
}

// Phase 9 — People Impact Score. Combines Phase 8's Risk Score with
// Phase 6's OSM exposure (schools/hospitals/density) for the same city.
// Reads Postgres on both sides (location_features + exposure cache); a
// live Overpass/Geoapify call only happens on a genuine exposure cache
// miss, same as fetchExposure.
export async function fetchImpactScore(cityId, date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(apiUrl(`/api/cities/${cityId}/impact-score${qs}`));
  if (!res.ok) throw new Error(`fetchImpactScore failed (${res.status})`);
  return res.json();
}

// Phase 10 — deterministic Emergency Mode trigger. Combines Phase 7's NWS
// alerts with Phase 8/9's Risk and Impact Scores server-side; a live
// Overpass/NWS/FortyGuard call only happens on a genuine cache miss on
// the backend, same as fetchImpactScore.
export async function fetchEmergencyStatus(cityId, date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(apiUrl(`/api/cities/${cityId}/emergency-status${qs}`));
  if (!res.ok) throw new Error(`fetchEmergencyStatus failed (${res.status})`);
  return res.json();
}

// Cross-city ranking for Emergency Mode's Priority panel — see
// routers/emergency.py's get_emergency_status_all for why this is always
// "today" per city rather than each city's own last-viewed date.
export async function fetchAllCitiesEmergencyStatus() {
  const res = await fetch(apiUrl('/api/cities/emergency-status-all'));
  if (!res.ok) throw new Error(`fetchAllCitiesEmergencyStatus failed (${res.status})`);
  return res.json();
}

// Phase 11 — Heat Story. Postgres-only, never triggers a FortyGuard
// request (see routers/heat_story.py's own docstring) — safe to call the
// moment the tab opens.
export async function fetchHeatStory(cityId, date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(apiUrl(`/api/heat-story/${cityId}${qs}`));
  if (!res.ok) throw new Error(`fetchHeatStory failed (${res.status})`);
  return res.json();
}

// `forecast` is the array of {hour, temperature} the frontend already
// fetched itself via postFetchForecastHours + polling — the backend never
// persists forecast anywhere it could read it back from, so this is the
// only way a forecast value reaches the narrative (see
// routers/heat_story.py's NarrateRequest).
export function postHeatStoryNarrate(cityId, date, forecast = []) {
  return postJSON(`/api/heat-story/${cityId}/narrate`, { date, forecast });
}

// Both below are consent-gated on the frontend (show the "this will make
// N FortyGuard requests" modal BEFORE calling these) and return
// {jobs: [{hour, status, signature, ...}]} — poll each job's `signature`
// via the existing fetchHeatmapStatus, same as Heat Map already does.
export function postFetchMissingHours(cityId, date, hours) {
  return postJSON(`/api/heat-story/${cityId}/fetch-missing`, { date, hours });
}

export function postFetchForecastHours(cityId, date, hours) {
  return postJSON(`/api/heat-story/${cityId}/fetch-forecast`, { date, hours });
}

// Logs a forecast fetch into heat_story_forecasts once its job(s) above
// actually complete — `hours` is [{hour, temperature}], the exact values
// HeatStoryView already read off the completed job. Purely a log; never
// affects location_features or the observed/coverage read. Failures here
// are non-fatal by design (see routers/heat_story.py's record_forecast),
// so this is normally fired without blocking on its result.
export function postRecordForecast(cityId, date, hours) {
  return postJSON(`/api/heat-story/${cityId}/forecast/record`, { date, hours });
}

// Read-back counterpart to postRecordForecast above — whatever's already
// been logged into heat_story_forecasts for this city/date. Called on
// load (and on city/date change) so a forecast the user already fetched
// keeps showing after navigating away and back to Heat Story, instead of
// only ever living in HeatStoryView's own state and disappearing the
// moment it unmounts. Postgres-only, same as fetchHeatStory — never
// triggers a FortyGuard request.
export async function fetchRecordedForecast(cityId, date) {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  const res = await fetch(apiUrl(`/api/heat-story/${cityId}/forecast${qs}`));
  if (!res.ok) throw new Error(`fetchRecordedForecast failed (${res.status})`);
  return res.json();
}

// TimeCompareView — call once BOTH Window A and Window B have a completed
// FortyGuard fetch (see that component's gating). No FortyGuard call on
// the backend side, only Groq, fed the temperature_stats numbers the
// frontend already has from those two fetches. Returns
// {story: {available, ...}} — `available: false` is a normal, displayable
// outcome (see routers/cities.py's get_time_comparison), never a thrown
// error from this function on that path.
export function postTimeComparison(cityId, windowA, windowB) {
  return postJSON(`/api/cities/${cityId}/time-comparison`, { window_a: windowA, window_b: windowB });
}

// ResearchView — Postgres-only, safe to call the moment the tab opens or
// the range changes (same "opening never triggers FortyGuard" contract as
// fetchHeatStory). Defaults server-side to the last 7 days ending on the
// city's own local today when startDate/endDate are omitted.
export async function fetchResearchHistory(cityId, startDate, endDate) {
  const params = new URLSearchParams();
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await fetch(apiUrl(`/api/research/${cityId}/history${qs}`));
  if (!res.ok) throw new Error(`fetchResearchHistory failed (${res.status})`);
  return res.json();
}

// Groq research summary over the same range — no FortyGuard call, only
// Groq, re-reading the range fresh server-side. Returns
// {summary: {available, ...}} — `available: false` is a normal,
// displayable outcome, never a thrown error from this function on that path.
export function postResearchSummary(cityId, startDate, endDate) {
  return postJSON(`/api/research/${cityId}/summary`, { start_date: startDate, end_date: endDate });
}

// Dashboard's "Fetch Environmental Factors" button (Environmental
// Parameters card) — calls the existing POST /api/env-params endpoint
// directly, standalone from the lazy city-summary bundle scheduler.py's
// refresh_city_summary fetches automatically. Backend already caches by
// request signature (repository.get_env_params → environmental_parameters
// table) and derives location_features from every genuine completion, so
// repeat clicks for the same city/date/hour cost nothing further.
export function postEnvParams(payload) {
  return postJSON('/api/env-params', payload);
}

// Phase 14 — City-to-City Comparison. Pure Postgres reads over
// historical_heat_data (populated offline by seed_historical.py +
// scripts/migrate_historical_from_neon.py) — never touches FortyGuard,
// safe to call as often as the UI wants.
export async function fetchHistoricalAvailableMonths() {
  const res = await fetch(apiUrl('/api/historical/available-months'));
  if (!res.ok) throw new Error(`fetchHistoricalAvailableMonths failed (${res.status})`);
  return res.json();
}

// `range` is either { months: 1..12 } ("last N months back from now") or
// { monthsList: ['2026-03', '2026-06', '2026-07'] } (exact, possibly
// non-consecutive months) — monthsList wins when both are present.
export async function fetchHistoricalComparison(cityIds, analyticType = 'tcm', range = {}) {
  const { months = 12, monthsList = null } = range;
  const params = new URLSearchParams({
    city_ids: cityIds.join(','),
    analytic_type: analyticType,
  });
  if (monthsList && monthsList.length > 0) {
    params.set('months_list', monthsList.join(','));
  } else {
    params.set('months', String(months));
  }
  const res = await fetch(apiUrl(`/api/historical/comparison?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchHistoricalComparison failed (${res.status})`);
  return res.json();
}

// Mean/Max/Min/StdDev monthly trend — replaces the old snapshot cards
// with a proper graph. Same range shape as fetchHistoricalComparison.
export async function fetchTemperatureProfile(cityIds, range = {}) {
  const { months = 12, monthsList = null } = range;
  const params = new URLSearchParams({ city_ids: cityIds.join(',') });
  if (monthsList && monthsList.length > 0) {
    params.set('months_list', monthsList.join(','));
  } else {
    params.set('months', String(months));
  }
  const res = await fetch(apiUrl(`/api/historical/temperature-profile?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchTemperatureProfile failed (${res.status})`);
  return res.json();
}

// Table counterpart of fetchTemperatureProfile for one exact date.
export async function fetchTemperatureProfileByDate(cityIds, date) {
  const params = new URLSearchParams({ city_ids: cityIds.join(','), date });
  const res = await fetch(apiUrl(`/api/historical/temperature-profile-by-date?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchTemperatureProfileByDate failed (${res.status})`);
  return res.json();
}

// Distinct feature_dates that actually have stored data, optionally
// narrowed to one YYYY-MM month — powers the exact-date picker for
// fetchHistoricalByDate below.
export async function fetchHistoricalAvailableDates(month) {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  const res = await fetch(apiUrl(`/api/historical/available-dates${qs}`));
  if (!res.ok) throw new Error(`fetchHistoricalAvailableDates failed (${res.status})`);
  return res.json();
}

// Most recent stored TCM reading per city — pure Postgres read, replaces
// the old live-FortyGuard snapshot cards.
export async function fetchHistoricalLatest(cityIds) {
  const params = new URLSearchParams({ city_ids: cityIds.join(',') });
  const res = await fetch(apiUrl(`/api/historical/latest?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchHistoricalLatest failed (${res.status})`);
  return res.json();
}

// One exact calendar date, every requested city's tcm/exceedance/persistence
// side by side — a cross-section rather than a trend line.
export async function fetchHistoricalByDate(cityIds, date) {
  const params = new URLSearchParams({ city_ids: cityIds.join(','), date });
  const res = await fetch(apiUrl(`/api/historical/by-date?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchHistoricalByDate failed (${res.status})`);
  return res.json();
}

// Per requested city, the single hottest + single coolest stored day
// (by tcm) within the same range as fetchHistoricalComparison — same
// `range` shape ({ months } or { monthsList }).
export async function fetchHistoricalExtremes(cityIds, range = {}) {
  const { months = 12, monthsList = null } = range;
  const params = new URLSearchParams({ city_ids: cityIds.join(',') });
  if (monthsList && monthsList.length > 0) {
    params.set('months_list', monthsList.join(','));
  } else {
    params.set('months', String(months));
  }
  const res = await fetch(apiUrl(`/api/historical/extremes?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchHistoricalExtremes failed (${res.status})`);
  return res.json();
}

// Optional enrichment — live rainfall + sky condition for one city/date
// from Open-Meteo (not stored data). `available: false` means Open-Meteo
// didn't answer this time, not that anything is broken; callers should
// just skip rendering that line rather than surfacing it as an error.
export async function fetchWeatherContext(cityId, date) {
  const params = new URLSearchParams({ city_id: cityId, date });
  const res = await fetch(apiUrl(`/api/historical/weather-context?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchWeatherContext failed (${res.status})`);
  return res.json();
}

// All requested cities' weather context for one date in a single round
// trip. Prefer this over calling fetchWeatherContext once per city —
// firing one request per selected city both hits the browser's
// per-origin concurrent-connection cap and, since each city fetch is 2
// upstream Open-Meteo calls, can trip Open-Meteo's own rate limiting
// once several cities are selected at once, silently dropping some of
// them. Returns { [cityId]: { available, ...fields } }.
export async function fetchWeatherContextBatch(cityIds, date) {
  const params = new URLSearchParams({ city_ids: cityIds.join(','), date });
  const res = await fetch(apiUrl(`/api/historical/weather-context-batch?${params.toString()}`));
  if (!res.ok) throw new Error(`fetchWeatherContextBatch failed (${res.status})`);
  const { results } = await res.json();
  return results || {};
}

// "Fetch missing data" for a Research range — consent-gated on the
// frontend (same "this will make N FortyGuard requests" modal pattern as
// postFetchMissingHours) before ever calling this. Returns
// {jobs: [{date, hour, status, signature, ...}], remaining_missing,
// total_missing_before} — poll each job's `signature` via the existing
// fetchHeatmapStatus, exactly as Heat Story's own fetch-missing does.
// `remaining_missing > 0` means the range had more missing hours than
// one batch covers — call again to continue.
export function postResearchFillGaps(cityId, startDate, endDate) {
  return postJSON(`/api/research/${cityId}/fill-gaps`, { start_date: startDate, end_date: endDate });
}

// Phase 12.5b — every request must now be scoped to one city (see
// schemas.RouteRequest's docstring): the backend validates both origin
// and destination fall inside that city's cached boundary polygon and
// filters out candidate routes that mostly leave it.
export function fetchRoutes({ cityId, origin, destination, departureTime }) {
  return postJSON('/api/routes', {
    city_id: cityId,
    origin_lat: origin.lat,
    origin_lon: origin.lon,
    destination_lat: destination.lat,
    destination_lon: destination.lon,
    ...(departureTime ? { departure_time: departureTime } : {}),
  });
}

// Phase 12.5b — the same boundary polygon routing.py enforces server-side,
// exposed so the map can actually draw it. Cached ~90 days server-side
// (city boundaries don't change), so this is cheap to call on every
// RouteHeatView mount. Returns {city_id, geojson, cached}.
export async function fetchCityBoundary(cityId) {
  return getJSON(`/api/cities/${cityId}/boundary`);
}

// Phase 12.5d — type-ahead address search (AddressSearch.jsx), scoped
// server-side to the city's own boundary — every result returned is
// already guaranteed usable as a routing origin/destination. Returns
// {city_id, query, results: [{label, lat, lon}]}.
export async function geocodeAddress(cityId, query) {
  return getJSON(`/api/cities/${cityId}/geocode?q=${encodeURIComponent(query)}`);
}

// Phase 12.5d — nearest hospitals/schools/pharmacies/fire stations
// inside the city's boundary (PoiPicker.jsx's destination shortcuts).
// `near` is an optional {lat, lon} to sort by distance from (usually
// the trip's origin); omitted, results sort from the city's own center.
export async function fetchNearbyPOIs(cityId, category, near) {
  const params = new URLSearchParams({ category });
  if (near) {
    params.set('near_lat', near.lat);
    params.set('near_lon', near.lon);
  }
  return getJSON(`/api/cities/${cityId}/pois?${params.toString()}`);
}

// Phase 12.5d — best-effort reverse geocode for a raw point (labeling a
// "my location" pin, building a readable share-location message).
// `label` can come back null if Nominatim was unreachable — never throws
// over that, since a coordinate is still perfectly usable without one.
export async function reverseGeocode(cityId, lat, lon) {
  return getJSON(`/api/cities/${cityId}/reverse?lat=${lat}&lon=${lon}`);
}

// Phase 12.5e — "best hours to travel": the next ROUTE_FORECAST_HORIZON_HOURS
// hours (usually 12) for one point, each labeled safe/moderate/risk with
// the same breakpoints a route's own heat_category badge uses. `point` is
// optional ({lat, lon}, usually the trip's origin); omitted, the backend
// uses the city's own center. Returns
// {hours: [{hour, local_hour_label, temperature_c, category, color}],
//  recommended_hour}.
export async function fetchBestHours(cityId, point) {
  const params = new URLSearchParams();
  if (point) {
    params.set('lat', point.lat);
    params.set('lon', point.lon);
  }
  const qs = params.toString();
  return getJSON(`/api/cities/${cityId}/best-hours${qs ? `?${qs}` : ''}`);
}