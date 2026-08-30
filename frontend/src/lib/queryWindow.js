// Mirrors FortyGuard's date_time.filter_type + granularity options so the
// UI can (a) build valid requests and (b) show the user, in plain language,
// exactly what temporal window and spatial resolution they're looking at.

export const FILTER_TYPES = [
  { value: 1, label: 'Single Hour', needs: ['time'] },
  { value: 2, label: 'Range of Hours', needs: ['time', 'endTime'] },
  { value: 3, label: 'Single Day', needs: [] },
  { value: 4, label: 'Range of Days (≤ 1 month)', needs: ['endDate'] },
];

// Tile size in meters. Smaller = smaller, more numerous tiles = more detail.
export const GRANULARITY_OPTIONS = [
  { value: 60, label: 'Fine', hint: '60m tiles — most detail' },
  { value: 80, label: 'Medium', hint: '80m tiles — balanced' },
  { value: 100, label: 'Coarse', hint: '100m tiles — fastest' },
];

// FortyGuard's analytic types — shared by HeatMapView and TimeCompareView
// so both pick from (and format/label) the exact same set rather than
// each keeping its own copy that could quietly drift apart. `unit`
// drives display formatting — see thermalFormat.js's formatAnalyticValue.
export const ANALYTIC_MODES = [
  { key: 'tcm', label: 'Temperature', unit: 'temp' },
  { key: 'exceedance', label: 'Exceedance (hrs > threshold)', unit: 'hrs' },
  { key: 'persistence', label: 'Longest Continuous Run', unit: 'hrs' },
  { key: 'time_of_measure', label: 'Diurnal Peak Hour (UTC)', unit: 'hour' },
];

// exceedance/persistence are the only two modes FortyGuard scores against
// a threshold+direction — tcm and time_of_measure ignore both fields.
export const THRESHOLD_MODES = new Set(['exceedance', 'persistence']);

// Returns { year, month, day, hour } as the CITY's own local wall-clock
// values, or null if no city/timezone is available (callers fall back to
// browser-local time in that case). Matches the backend's
// locations.py:city_local_now(city) — same Intl.DateTimeFormat technique
// as HeatStoryView.jsx already used for exactly this reason, now shared
// here so every OTHER caller (HeatMapView, TimeCompareView,
// useLiveCityData) can stop defaulting to the browser's own timezone,
// which used to silently disagree with what the backend considers "today"
// for that city whenever the two timezones differ even slightly.
function cityLocalParts(city) {
  if (!city?.timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: city.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const year = get('year'), month = get('day') && get('month'), day = get('day'), hour = get('hour');
    if (!year || !month || !day || hour === undefined) return null;
    return { year, month, day, hour };
  } catch {
    return null;
  }
}

// `city` is optional — pass it whenever one is in scope (matches the
// backend's local_today(city)); omitted, this falls back to the
// browser's own local date exactly as before.
export function todayISO(city) {
  const p = cityLocalParts(city);
  if (p) return `${p.year}-${p.month}-${p.day}`;
  return new Date().toISOString().slice(0, 10);
}

export function currentHourHHMM(city) {
  const p = cityLocalParts(city);
  const hour = p ? parseInt(p.hour, 10) : new Date().getHours();
  return `${String(hour).padStart(2, '0')}:00`;
}

// The most recent hour that has actually fully elapsed — e.g. at 09:14 this
// is "08:00", not "09:00" (which is still in progress and may not have
// complete data yet). Used as the default single-hour request so an
// unscoped fetch never accidentally asks FortyGuard for a day that
// includes hours later today that haven't happened yet (their API treats
// "today" requests with no start_time as a full 00:00–23:59 span, which
// can reach into not-yet-elapsed hours and come back empty or fail — see
// DEFAULT_QUERY below).
export function lastCompletedHourHHMM(city) {
  const p = cityLocalParts(city);
  const hour = p ? parseInt(p.hour, 10) : new Date().getHours();
  const h = hour === 0 ? 23 : hour - 1;
  return `${String(h).padStart(2, '0')}:00`;
}

// The date that lastCompletedHourHHMM() actually falls on — normally
// today, but at 00:xx the "last completed hour" (23:00) belongs to
// yesterday, not today. Keeping this paired with lastCompletedHourHHMM()
// avoids a subtle bug where the default request asks for "today at 23:00"
// right after midnight, which hasn't happened yet.
export function lastCompletedHourDateISO(city) {
  const p = cityLocalParts(city);
  const hour = p ? parseInt(p.hour, 10) : new Date().getHours();
  if (hour === 0) {
    return addDaysISO(todayISO(city), -1);
  }
  return todayISO(city);
}

// Human-readable summary of exactly what window is/will be queried —
// shown in the UI so "what data is it collecting" is never a mystery.
export function describeWindow({ filterType, date, time, endTime, endDate }) {
  switch (filterType) {
    case 1:
      return `${date} at ${time || '—'} (single hour)`;
    case 2:
      return `${date}, ${time || '—'}–${endTime || '—'} (hour range)`;
    case 4:
      return `${date} → ${endDate || '—'} (day range)`;
    case 3:
    default:
      return `${date}, full day (00:00–23:59)`;
  }
}

export function describeGranularity(value) {
  const opt = GRANULARITY_OPTIONS.find((g) => g.value === value);
  return opt ? `${opt.hint}` : `${value}m tiles`;
}

// --- Playback helpers ---------------------------------------------------
// Used to let the user "scrub" a fetched window: a range-of-days result can
// be browsed day by day, a single-day result can be browsed hour by hour,
// a range-of-hours result hour by hour within that range. Each step here
// issues its own single-hour/single-day FortyGuard request (cached), since
// a single range request only returns an aggregate, not a per-day/hour
// breakdown.

export function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Inclusive list of YYYY-MM-DD strings from start to end (capped so a
// mis-set range can't generate an unbounded list).
export function daysBetween(startISO, endISO, maxDays = 31) {
  if (!startISO) return [];
  const end = endISO || startISO;
  const days = [];
  let cursor = startISO;
  for (let i = 0; i <= maxDays; i++) {
    days.push(cursor);
    if (cursor >= end) break;
    cursor = addDaysISO(cursor, 1);
  }
  return days;
}

// Inclusive list of hour numbers (0-23) between two HH:MM strings.
export function hoursBetween(startHHMM, endHHMM) {
  const startH = parseInt((startHHMM || '00:00').split(':')[0], 10);
  const endH = parseInt((endHHMM || '23:00').split(':')[0], 10);
  const hours = [];
  for (let h = Math.min(startH, endH); h <= Math.max(startH, endH); h++) hours.push(h);
  return hours;
}

export function hourToHHMM(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

// Evenly-spaced sample of at most `maxCount` items from `list`, always
// including both endpoints. Used to cap how many frames "Build Timeline"
// will actually pre-fetch — scrubbing a full month or 24 hours by hand is
// fine (each click is one explicit request), but auto-play pre-building
// every single one is not: it must stay a small, bounded, explicit batch.
export function evenSample(list, maxCount) {
  if (list.length <= maxCount) return list;
  const out = [];
  for (let i = 0; i < maxCount; i++) {
    out.push(list[Math.round((i / (maxCount - 1)) * (list.length - 1))]);
  }
  return [...new Set(out)];
}