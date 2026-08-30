import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen, RefreshCw, AlertTriangle, CloudSun, ThermometerSun, Sparkles,
  Info, X, Loader2, Clock, ChevronLeft, ChevronRight, Droplets, Wind,
} from 'lucide-react';
import {
  fetchHeatStory, postHeatStoryNarrate, postFetchMissingHours, postFetchForecastHours,
  postRecordForecast, fetchRecordedForecast, fetchHeatmapStatus,
} from '../api/thermoraApi';
import { formatTemp, cToF } from '../lib/thermalFormat';

// Mirrors heat_story.py's own START_HOUR/END_HOUR (full calendar day,
// 00:00-23:00 — was previously 6-20) — only used client-side to propose
// forecast-hour candidates and to explain a zero-expected-hours state to
// the user; the expected/missing-hours computation itself always stays
// the backend's (see GET /api/heat-story/{city_id}).
const START_HOUR = 1;
const END_HOUR = 23;
const MAX_FORECAST_HOURS = 4;

// FortyGuard's own forecast product is only valid up to 12 hours ahead of
// "now" — anything requested further out than that isn't a real forecast,
// it's noise. forecastCandidates below never proposes an hour past this
// horizon, and the horizon itself is anchored to the CITY's local current
// hour (not the browser's), same reasoning as heat_story.py's
// expected_hours() on the backend.
const FORTYGUARD_FORECAST_HORIZON_HOURS = 12;

const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // ~3 minutes per job, same ceiling as backend

function hourStr(h) {
  return `${String(h).padStart(2, '0')}:00`;
}

// The CITY's own current local calendar date (YYYY-MM-DD) — NOT the
// browser's/UTC's. This used to be `new Date().toISOString().slice(0,10)`,
// which is always UTC: every monitored city is hours BEHIND UTC, so
// during that city's own evening (roughly 19:00–23:59 local, depending on
// its UTC offset), UTC has already rolled over to the next calendar date
// while the city hasn't. That mismatch meant this could request/compare
// against "tomorrow" from the backend's (correctly city-local) point of
// view while it was still today, this file's own evening, in the city —
// the exact class of bug heat_story.py's own top-of-file comment already
// documents having hit and fixed server-side; this was the same bug,
// just reintroduced client-side. Same Intl.DateTimeFormat approach as
// cityLocalHour above, so there's exactly one technique for "what does
// the city's wall clock say right now" instead of two that can drift.
function todayISO(city) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: city.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const y = get('year'), m = get('month'), d = get('day');
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // fall through to browser-local below
  }
  return new Date().toISOString().slice(0, 10);
}

// The city's own current local hour (0-23) — NOT the browser's. Every
// monitored city is hours behind UTC, so "now" for drawing the
// observed/forecast boundary has to mean the city's wall clock, same as
// heat_story.py's city_local_now() on the backend. Falls back to the
// browser's local hour only if the timezone is somehow missing/invalid.
function cityLocalHour(city) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: city.timezone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = hourPart ? parseInt(hourPart.value, 10) : NaN;
    return Number.isNaN(hour) ? new Date().getHours() : hour % 24;
  } catch {
    return new Date().getHours();
  }
}

// Plain calendar-date arithmetic on the YYYY-MM-DD string the backend
// already gave us — feature_date is a plain date column with no timezone
// component, so this doesn't need (and shouldn't use) the city's tz.
function addDaysISO(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// Polls a single job's signature until it settles, reusing the exact same
// GET /api/heatmap/status Heat Map already polls.
async function pollJob(signature) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const result = await fetchHeatmapStatus(signature);
    if (result.status === 'Completed' || result.status === 'Failed') return result;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: 'Failed', error: 'Timed out waiting for this hour to complete.' };
}

// Shared shape for both consent modals — the whole point is the person
// sees exactly how many real FortyGuard requests they're about to trigger
// before confirming, never a silent background fetch.
function ConsentModal({ title, hours, requestNote, onCancel, onConfirm, confirming }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-3xl border border-border shadow-2xl max-w-sm w-full p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-ink">{title}</h3>
          <button onClick={onCancel} className="text-inkfaint hover:text-ink cursor-pointer shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {hours.map((h) => (
            <span key={h} className="px-2 py-1 rounded-lg bg-app/70 border border-border text-[11px] font-mono text-inksoft">
              {h}
            </span>
          ))}
        </div>
        <p className="text-xs text-inkmuted mt-4 leading-relaxed">
          This will make <strong className="text-ink">{hours.length}</strong> FortyGuard heatmap
          request{hours.length === 1 ? '' : 's'} — {requestNote} May take a few minutes; already
          cached hours won't be requested again.
        </p>
        <div className="flex gap-2 mt-5">
          <button
            onClick={onCancel}
            disabled={confirming}
            className="flex-1 px-4 py-2.5 rounded-xl border border-border text-inksoft hover:bg-surface2/60 text-xs font-semibold cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="flex-1 px-4 py-2.5 rounded-xl bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/30 text-orange-300 text-xs font-semibold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {confirming && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {confirming ? 'Fetching…' : `Fetch ${hours.length} Hour${hours.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// A single hour in the Coverage carousel. Every field on it is a real
// column from location_features (or, for a forecast hour, a real
// FortyGuard response the user explicitly requested) — there is no
// "solar"/"feels-like milestone note" fabricated field here; anything the
// backend didn't return for this hour is simply omitted from the card
// instead of being invented.
function HourCard({ time, exists, isForecast, temperature, heatIndex, isPeak, isSelected, tempUnit, onClick }) {
  if (!exists && !isForecast) {
    return (
      <div className="shrink-0 w-[104px] snap-start p-3 rounded-2xl border-2 border-dashed border-red-500/30 bg-app/40 flex flex-col items-center justify-center gap-1.5 text-center">
        <AlertTriangle className="w-3.5 h-3.5 text-red-400/70" />
        <span className="text-[9px] font-mono text-inkfaint">{time}</span>
        <span className="text-[9px] text-red-400/70 leading-tight">No reading</span>
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      className={`shrink-0 w-[104px] snap-start p-3 rounded-2xl border text-left transition-all cursor-pointer relative ${
        isSelected
          ? isForecast
            ? 'bg-sky-500/15 border-sky-400/60 shadow-lg shadow-sky-500/10'
            : 'bg-orange-500/20 border-orange-500/60 shadow-lg shadow-orange-500/10'
          : isForecast
            ? 'bg-app/40 border-dashed border-sky-400/40 hover:border-sky-400/70'
            : 'bg-app/60 border-border/80 hover:border-borderstrong'
      }`}
    >
      {isPeak && (
        <span className="absolute -top-2 right-2 z-10 px-2 py-0.5 rounded-full bg-red-500 text-white font-black text-[9px] font-mono shadow-sm">
          PEAK
        </span>
      )}
      <div className="flex items-center justify-between text-[10px] font-mono text-inkmuted">
        <span>{time}</span>
        <Clock className="w-3 h-3 text-inkfaint" />
      </div>
      <div className={`text-xl font-black font-mono my-1 ${isForecast ? 'text-sky-300' : 'text-ink'}`}>
        {formatTemp(temperature, tempUnit, 0)}
      </div>
      {heatIndex != null ? (
        <div className="text-[10px] text-orange-400 font-semibold">
          Feels {formatTemp(heatIndex, tempUnit, 0)}
        </div>
      ) : (
        <div className="text-[10px] text-inkfaint">Feels —</div>
      )}
      {isForecast && <div className="text-[9px] text-sky-400/80 font-mono mt-1">forecast</div>}
    </button>
  );
}

const STORY_SECTIONS = [
  { key: 'what_happened', label: 'What happened', icon: ThermometerSun },
  { key: 'whats_happening', label: "What's happening", icon: CloudSun },
  { key: 'whats_expected', label: "What's expected", icon: Sparkles, forecastAware: true },
  { key: 'why_it_matters', label: 'Why it matters', icon: Info },
];

// A visual read of the same data the hour carousel already shows, not a
// second data source — every point plotted here comes straight from
// `observed`/`forecastList`, nothing interpolated or estimated. Custom
// inline SVG rather than pulling in a charting library: this app has no
// chart dependency installed anywhere else (EmergencyModeView's gauges
// are hand-built the same way), and a day's worth of hourly points is
// simple enough not to need one.
//
// Deliberately does NOT connect across a missing hour — a straight line
// from 11:00 to 13:00 through a hole at 12:00 would visually claim to
// know what 12:00 looked like, which is exactly the "never estimate a
// missing hour" rule this whole feature is built around. A gap in the
// line is the honest way to show a gap in the data.
function TempCurveChart({ observed, forecastList, peak, warningThresholdF, tempUnit, selected, onSelectObserved, onSelectForecast, nowHour }) {
  const W = 720, H = 150, PAD_X = 28, PAD_Y = 20;

  const obsPoints = observed
    .filter((o) => o.exists && o.temperature != null)
    .map((o) => ({ hour: parseInt(o.hour.slice(0, 2), 10), temp: o.temperature, entry: o, kind: 'observed' }));
  const fcPoints = forecastList
    .filter((f) => f.temperature != null)
    .map((f) => ({ hour: parseInt(f.hour.slice(0, 2), 10), temp: f.temperature, entry: f, kind: 'forecast' }));
  const allPoints = [...obsPoints, ...fcPoints];
  if (allPoints.length < 2) return null; // not enough real points to draw a meaningful curve yet

  const warningC = warningThresholdF != null ? (warningThresholdF - 32) / 1.8 : null;
  const temps = allPoints.map((p) => p.temp).concat(warningC != null ? [warningC] : []);
  const minT = Math.min(...temps), maxT = Math.max(...temps);
  const tempSpan = Math.max(maxT - minT, 1);

  const xOf = (hour) => PAD_X + ((hour - START_HOUR) / (END_HOUR - START_HOUR)) * (W - PAD_X * 2);
  const yOf = (t) => H - PAD_Y - ((t - minT) / tempSpan) * (H - PAD_Y * 2);

  // Break the observed line at every gap (missing hour) instead of one
  // path across all of them — see function comment above.
  const obsSegments = [];
  let current = [];
  observed.forEach((o) => {
    if (o.exists && o.temperature != null) {
      current.push({ hour: parseInt(o.hour.slice(0, 2), 10), temp: o.temperature });
    } else if (current.length) {
      obsSegments.push(current);
      current = [];
    }
  });
  if (current.length) obsSegments.push(current);

  const toPath = (pts) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.hour)} ${yOf(p.temp)}`).join(' ');

  // Forecast path picks up from the last real observed point (if any) so
  // the dashed line visibly continues from where reality left off,
  // rather than floating disconnected on the right.
  const lastObs = obsPoints[obsPoints.length - 1];
  const forecastPath = fcPoints.length
    ? toPath([...(lastObs ? [{ hour: lastObs.hour, temp: lastObs.temp }] : []), ...fcPoints.map((p) => ({ hour: p.hour, temp: p.temp }))])
    : '';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" preserveAspectRatio="none">
      {warningC != null && (
        <>
          <line x1={PAD_X} x2={W - PAD_X} y1={yOf(warningC)} y2={yOf(warningC)}
                stroke="currentColor" className="text-red-400/40" strokeWidth="1" strokeDasharray="3 3" />
          <text x={W - PAD_X} y={yOf(warningC) - 4} textAnchor="end" className="fill-red-400/70 text-[8px] font-mono">
            {warningThresholdF}°F warning
          </text>
        </>
      )}
      {nowHour != null && nowHour >= START_HOUR && nowHour <= END_HOUR && (
        <line x1={xOf(nowHour)} x2={xOf(nowHour)} y1={PAD_Y} y2={H - PAD_Y}
              stroke="currentColor" className="text-borderstrong" strokeWidth="1" strokeDasharray="2 3" />
      )}
      {obsSegments.map((seg, i) => (
        <path key={i} d={toPath(seg)} fill="none" stroke="currentColor" className="text-orange-400" strokeWidth="2" />
      ))}
      {forecastPath && (
        <path d={forecastPath} fill="none" stroke="currentColor" className="text-sky-400" strokeWidth="2" strokeDasharray="5 4" />
      )}
      {obsPoints.map((p) => {
        const isSelected = selected?.type === 'observed' && selected.entry.hour === p.entry.hour;
        const isPeak = peak && peak.time === p.entry.hour;
        return (
          <circle
            key={`o-${p.entry.hour}`} cx={xOf(p.hour)} cy={yOf(p.temp)}
            r={isPeak ? 5 : isSelected ? 4.5 : 3}
            className={`cursor-pointer ${isPeak ? 'fill-red-500' : 'fill-orange-400'} ${isSelected ? 'stroke-ink stroke-2' : ''}`}
            onClick={() => onSelectObserved(p.entry)}
          />
        );
      })}
      {fcPoints.map((p) => {
        const isSelected = selected?.type === 'forecast' && selected.entry.hour === p.entry.hour;
        const isPeak = peak && peak.time === p.entry.hour;
        return (
          <circle
            key={`f-${p.entry.hour}`} cx={xOf(p.hour)} cy={yOf(p.temp)}
            r={isPeak ? 5 : isSelected ? 4.5 : 3}
            className={`cursor-pointer fill-app ${isPeak ? 'stroke-red-500' : 'stroke-sky-400'} stroke-2`}
            onClick={() => onSelectForecast(p.entry)}
          />
        );
      })}
    </svg>
  );
}

// One deterministic sentence pulling together the two most notable REAL
// facts already computed elsewhere on this page (peak reading, delta vs
// yesterday) — plain string composition, no LLM call, so it's free and
// instant even before "Generate Story" has ever been clicked. Gives the
// page an immediate takeaway instead of making someone scan the coverage
// carousel to find the number that actually matters.
function Headline({ city, peak, comparison, tempUnit }) {
  if (!peak) return null;
  const peakRow = comparison?.find((r) => r.key === 'peak_temp');
  let deltaPhrase = null;
  if (peakRow) {
    const rawDelta = peakRow.today - peakRow.yesterday;
    if (Math.abs(rawDelta) >= 0.3) {
      const displayDelta = Math.abs(tempUnit === 'F' ? rawDelta * 1.8 : rawDelta).toFixed(1);
      deltaPhrase = `${rawDelta > 0 ? 'hotter' : 'cooler'} than yesterday's peak by ${displayDelta}°${tempUnit}`;
    } else {
      deltaPhrase = 'about the same as yesterday\'s peak';
    }
  }
  return (
    <div className="flex items-start gap-3 p-4 rounded-2xl bg-gradient-to-r from-orange-500/10 via-transparent to-transparent border border-orange-500/20">
      <ThermometerSun className="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
      <p className="text-sm text-inksoft leading-relaxed">
        <strong className="text-ink">{city.name}</strong> peaked at{' '}
        <strong className="text-orange-300 font-mono">{formatTemp(peak.temperature, tempUnit, 0)}</strong> around{' '}
        <strong className="text-ink">{peak.time}</strong>
        {deltaPhrase && <> — <span className="text-inksoft">{deltaPhrase}</span></>}.
      </p>
    </div>
  );
}

export const HeatStoryView = ({ city, userSettings, onNavigateTab, onOpenAIAgent }) => {
  const tempUnit = userSettings?.tempUnit || 'F';
  const warningThresholdF = userSettings?.warningThreshold ?? 98;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Yesterday is fetched purely for the real "Yesterday vs Today"
  // comparison below — same read-only /api/heat-story call as today's,
  // just for feature_date - 1. Failing to load it (or it genuinely having
  // no observed hours) just hides that section; it never blocks the page.
  const [yesterdayData, setYesterdayData] = useState(null);

  const [forecast, setForecast] = useState([]); // [{hour, temperature}], populated only after an explicit fetch
  const [modal, setModal] = useState(null); // 'missing' | 'forecast' | null
  const [confirming, setConfirming] = useState(false);
  const [jobError, setJobError] = useState(null);

  const [story, setStory] = useState(null);
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError, setStoryError] = useState(null);

  const [selected, setSelected] = useState(null); // {type: 'observed'|'forecast', entry}

  const dateRef = useRef(todayISO(city));
  const carouselRef = useRef(null);

  // Opening Heat Story is Postgres-only — no FortyGuard call happens just
  // from loading this tab.
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchHeatStory(city.id, dateRef.current)
      .then((r) => {
        setData(r);
        dateRef.current = r.date;
        // Best-effort — a failure here just means no comparison card.
        fetchHeatStory(city.id, addDaysISO(r.date, -1))
          .then(setYesterdayData)
          .catch(() => setYesterdayData(null));
        // Restores any forecast the user already fetched for this exact
        // city/date on a previous visit — heat_story_forecasts (see
        // postRecordForecast) is the durable record of it; `forecast`
        // state itself is just this component's own in-memory mirror of
        // that, which resets to [] on every remount (switching tabs
        // unmounts Heat Story). Without this read-back, an already-
        // fetched forecast looked like it had never been requested the
        // moment you navigated away and back. Best-effort, same as
        // yesterdayData above — a failure here just means forecast
        // starts empty, exactly like before this existed.
        fetchRecordedForecast(city.id, r.date)
          .then((res) => setForecast((res.hours || []).filter((h) => h.temperature != null)))
          .catch(() => {});
      })
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }, [city.id]);

  useEffect(() => {
    setData(null);
    setYesterdayData(null);
    setForecast([]);
    setStory(null);
    setStoryError(null);
    setSelected(null);
    dateRef.current = todayISO(city);
    load();
  }, [city.id, load]);

  const missingHours = data?.coverage?.temperature?.missing_hours || [];

  // Once an hour fully passes, a forecast fetched for it earlier (this
  // session, or restored from heat_story_forecasts on a previous visit —
  // see load()'s fetchRecordedForecast call) is stale: it was a
  // prediction for a time that hadn't happened yet AT THE TIME it was
  // fetched, but if the tab stays open (or is reopened) past that hour,
  // it keeps rendering to the right of the NOW divider looking like a
  // still-upcoming prediction for an hour that has, in reality, already
  // gone by. Filtering here — not deleting from `forecast` state itself —
  // is what keeps every display/decision below in sync with the wall
  // clock without discarding the underlying fetched data. The current
  // in-progress hour is deliberately KEPT (>=, not >): it has no observed
  // reading yet either (see expected_hours' own comment), so it's still
  // legitimately the one hour where "forecast" is the only real answer.
  const visibleForecast = useMemo(() => {
    const nowHour = cityLocalHour(city);
    return forecast.filter((f) => parseInt(f.hour.slice(0, 2), 10) >= nowHour);
  }, [forecast, city]);

  // Forecast candidates now start AT the city's current local hour
  // (inclusive), not strictly after it — matches heat_story.py's
  // is_within_forecast_horizon, which was fixed for the same reason: the
  // current in-progress hour has no observed reading yet (that requires
  // the hour to have fully elapsed — see expected_hours' own comment) but
  // used to also be excluded from forecast candidates for being "the
  // present, not the future". That left it with neither an observed
  // value nor a forecast option — a visible gap for exactly one hour,
  // every hour, all day. lastObservedHour is normally nowHour-1 already
  // (expected_hours stops one hour short of "now" on purpose), so
  // lastObservedHour+1 naturally lands back on nowHour once this
  // includes it — Math.max is just a guard against that drifting.
  // Never reaches further than FortyGuard's own 12-hour forecast horizon,
  // whichever is tighter than the day's END_HOUR.
  const forecastCandidates = useMemo(() => {
    if (!data) return [];
    const nowHour = cityLocalHour(city);
    const lastObserved = data.observed[data.observed.length - 1];
    const lastObservedHour = lastObserved ? parseInt(lastObserved.hour.slice(0, 2), 10) : null;
    const startHour = lastObservedHour != null ? Math.max(nowHour, lastObservedHour + 1) : nowHour;
    const horizonHour = Math.min(END_HOUR, nowHour + FORTYGUARD_FORECAST_HORIZON_HOURS);
    const already = new Set(visibleForecast.map((f) => f.hour));
    const out = [];
    for (let h = startHour; h <= horizonHour && out.length < MAX_FORECAST_HOURS; h++) {
      const hs = hourStr(h);
      if (!already.has(hs)) out.push(hs);
    }
    return out;
  }, [data, visibleForecast, city]);

  // The only "peak" this view ever shows — computed live from whatever
  // real observed/forecast temperatures are actually loaded right now.
  // No fallback value: if nothing has a reading yet, there is no peak.
  const peak = useMemo(() => {
    const candidates = [
      ...(data?.observed || []).filter((o) => o.exists).map((o) => ({ time: o.hour, temperature: o.temperature })),
      ...visibleForecast.filter((f) => f.temperature != null).map((f) => ({ time: f.hour, temperature: f.temperature })),
    ];
    if (!candidates.length) return null;
    return candidates.reduce((max, c) => (c.temperature > max.temperature ? c : max), candidates[0]);
  }, [data, visibleForecast]);

  // Auto-select the peak hour (or the most recent observed reading) once
  // data first arrives, so the detail panel isn't empty by default.
  useEffect(() => {
    if (selected || !data) return;
    if (peak) {
      const obs = data.observed.find((o) => o.hour === peak.time && o.exists);
      if (obs) { setSelected({ type: 'observed', entry: obs }); return; }
      const fc = visibleForecast.find((f) => f.hour === peak.time);
      if (fc) { setSelected({ type: 'forecast', entry: fc }); return; }
    }
  }, [data, peak, visibleForecast, selected]);

  // Real "yesterday vs today" — every number below comes from the two
  // fetchHeatStory() calls above, not an invented delta. If either day
  // has no observed hours yet, the comparison is simply not shown.
  const comparison = useMemo(() => {
    if (!data || !yesterdayData) return null;
    const todayObs = data.observed.filter((o) => o.exists);
    const yestObs = yesterdayData.observed.filter((o) => o.exists);
    if (!todayObs.length || !yestObs.length) return null;

    const maxOf = (rows, key) => {
      const vals = rows.map((r) => r[key]).filter((v) => v != null);
      return vals.length ? Math.max(...vals) : null;
    };
    const countAboveWarning = (rows) =>
      rows.filter((r) => r.temperature != null && cToF(r.temperature) >= warningThresholdF).length;

    const rows = [
      { key: 'peak_temp', metric: 'Peak Temperature', today: maxOf(todayObs, 'temperature'), yesterday: maxOf(yestObs, 'temperature'), isTemp: true },
      { key: 'peak_heat_index', metric: 'Peak Heat Index', today: maxOf(todayObs, 'heat_index'), yesterday: maxOf(yestObs, 'heat_index'), isTemp: true },
      { key: 'hours_above_warning', metric: `Hours ≥ ${warningThresholdF}°F`, today: countAboveWarning(todayObs), yesterday: countAboveWarning(yestObs), isTemp: false },
    ].filter((r) => r.today != null && r.yesterday != null);

    return rows.length ? rows : null;
  }, [data, yesterdayData, warningThresholdF]);

  const runFetch = async (hours, { persist }) => {
    setConfirming(true);
    setJobError(null);
    try {
      const submit = persist ? postFetchMissingHours : postFetchForecastHours;
      const { jobs } = await submit(city.id, dateRef.current, hours);
      const settled = await Promise.all(
        jobs.map(async (job) => {
          if (job.status === 'Completed') return job;
          return { ...job, ...(await pollJob(job.signature)) };
        })
      );
      const failed = settled.filter((j) => j.status === 'Failed');
      if (failed.length) {
        setJobError(`${failed.length} hour(s) failed: ${failed.map((f) => f.hour).join(', ')}`);
      }
      if (persist) {
        load(); // re-read observed/coverage from Postgres now that new rows exist
      } else {
        const resolved = settled
          .filter((j) => j.status === 'Completed')
          .map((j) => ({
            hour: j.hour,
            temperature: j.stats_data?.temperature_stats?.mean ?? null,
          }));
        setForecast((prev) => [...prev, ...resolved].sort((a, b) => a.hour.localeCompare(b.hour)));
        // Log what was just fetched into heat_story_forecasts — fire and
        // forget-ish: a logging failure shouldn't take the forecast off
        // the screen (it already rendered from `resolved` above), so this
        // is deliberately not awaited into the try/catch that surrounds
        // the actual fetch, and errors here are swallowed silently (the
        // backend already logs its own failures — see
        // routers/heat_story.py's record_forecast).
        if (resolved.length) {
          postRecordForecast(city.id, dateRef.current, resolved).catch(() => {});
        }
      }
    } catch (err) {
      setJobError(err.message || String(err));
    } finally {
      setConfirming(false);
      setModal(null);
    }
  };

  const generateStory = () => {
    setStoryLoading(true);
    setStoryError(null);
    postHeatStoryNarrate(city.id, dateRef.current, visibleForecast)
      .then((r) => {
        if (r.story?.available) setStory(r.story);
        else setStoryError(r.story?.reason || 'Story unavailable.');
      })
      .catch((err) => setStoryError(err.message || String(err)))
      .finally(() => setStoryLoading(false));
  };

  // Auto-generate once real observed data actually exists — the person
  // shouldn't have to remember to click "Generate Story" every time they
  // open a city that already has something to narrate. Guarded to fire
  // AT MOST once per city+date: `data.observed.some(exists)` is the exact
  // same check the empty-state message above already uses for "is there
  // really nothing to narrate yet" (see the 0-expected-hours explanation
  // higher up this file) — before 6am local, or before any hour's been
  // fetched, this correctly stays silent rather than generating a story
  // from nothing. Never re-fires just because `story` gets cleared by a
  // city/date change; the ref key includes both so a genuinely new
  // city+date can auto-fire again on its own.
  const autoStoryFiredForRef = useRef(null);
  useEffect(() => {
    if (!data || story || storyLoading) return;
    if (!data.observed.some((o) => o.exists)) return;
    const key = `${city.id}:${data.date}`;
    if (autoStoryFiredForRef.current === key) return;
    autoStoryFiredForRef.current = key;
    generateStory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, story, storyLoading, city.id]);

  const scrollCarousel = (dir) => {
    carouselRef.current?.scrollBy({ left: dir * 260, behavior: 'smooth' });
  };

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6 text-ink font-sans">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center">
              <BookOpen className="w-4 h-4 text-orange-400" />
            </div>
            <h2 className="text-2xl font-bold text-ink tracking-tight">Heat Story: {city.name}</h2>
          </div>
          <p className="text-xs text-inkmuted mt-1">
            Observed thermal record for {dateRef.current} — read directly from stored FortyGuard readings
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {onOpenAIAgent && (
            <button
              onClick={() => onOpenAIAgent(`Why is today's heat in ${city.name} developing the way it is?`)}
              className="px-4 py-2 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-orange-400" />
              <span>Ask AI</span>
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-2 rounded-xl border border-border hover:bg-surface2/60 text-inkfaint hover:text-ink transition-all cursor-pointer disabled:opacity-50 flex items-center gap-1.5 text-xs font-semibold shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-2xl bg-red-500/10 border border-red-500/30 text-xs text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center gap-2 text-xs text-inkmuted font-mono">
          <Loader2 className="w-4 h-4 animate-spin" /> Reading observed data for {dateRef.current}…
        </div>
      )}

      {data && (
        <>
          {/* Coverage — an honest picture of how complete today's observed
              record is, never silently treated as complete. Carousel
              (rather than a wrapping grid) so 24h of cards never fight
              for space, whatever the viewport. */}
          <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-2xl">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
              <div>
                <h3 className="text-base font-bold text-ink tracking-tight">Observed Coverage — {data.date}</h3>
                <p className="text-xs text-inkmuted mt-0.5">
                  {data.coverage.temperature.available_hours} of {data.coverage.temperature.expected_hours} expected
                  hours have a real reading ({data.coverage.temperature.coverage_percent}%)
                </p>
              </div>
              {peak ? (
                <span className="text-xs font-mono text-orange-400 font-bold bg-orange-500/10 px-3 py-1 rounded-full border border-orange-500/20">
                  Peak: {peak.time} ({formatTemp(peak.temperature, tempUnit, 0)})
                </span>
              ) : (
                <span className="text-xs font-mono text-inkfaint bg-app/50 px-3 py-1 rounded-full border border-border">
                  No readings yet
                </span>
              )}
            </div>

            {/* Chart overview above the carousel below — same click-to-
                select behavior on both, driven by the same `selected`
                state, so clicking a point here highlights its card below
                and vice versa. Genuinely was dead code until now: defined
                but never rendered anywhere in this file. */}
            {(data.observed.length + visibleForecast.length) >= 2 && (
              <div className="mb-3 p-3 rounded-xl bg-app/40 border border-border/60">
                <TempCurveChart
                  observed={data.observed}
                  forecastList={visibleForecast}
                  peak={peak}
                  warningThresholdF={warningThresholdF}
                  tempUnit={tempUnit}
                  selected={selected}
                  onSelectObserved={(entry) => setSelected({ type: 'observed', entry })}
                  onSelectForecast={(entry) => setSelected({ type: 'forecast', entry })}
                  nowHour={cityLocalHour(city)}
                />
                <div className="flex items-center justify-center gap-4 mt-2 pt-2 border-t border-border/40">
                  <span className="flex items-center gap-1.5 text-[9px] font-mono text-inkfaint">
                    <span className="w-2.5 h-0.5 bg-orange-400 inline-block" /> Observed
                  </span>
                  {visibleForecast.length > 0 && (
                    <span className="flex items-center gap-1.5 text-[9px] font-mono text-inkfaint">
                      <span className="w-2.5 h-0.5 bg-sky-400 inline-block" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #38bdf8 0 3px, transparent 3px 6px)' }} /> Forecast
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Carousel. pt-3 (not just pb-2) matters here: pairing
                overflow-x-auto with no explicit overflow-y makes the
                browser compute overflow-y as auto too, which was clipping
                the PEAK badge's -top-2 offset against the container's own
                edge — the badge rendered but was cut off/hidden right at
                the top of the row. The top padding gives that badge room
                to sit fully inside the scrollable box instead. */}
            <div className="relative">
              <div ref={carouselRef} className="flex gap-3 overflow-x-auto snap-x snap-mandatory pt-3 pb-2 scroll-smooth [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {data.observed.map((o) => (
                  <HourCard
                    key={o.hour}
                    time={o.hour}
                    exists={o.exists}
                    isForecast={false}
                    temperature={o.temperature}
                    heatIndex={o.heat_index}
                    isPeak={!!peak && peak.time === o.hour && o.exists}
                    isSelected={selected?.type === 'observed' && selected.entry.hour === o.hour}
                    tempUnit={tempUnit}
                    onClick={() => setSelected({ type: 'observed', entry: o })}
                  />
                ))}
                {/* NOW divider — the actual observed/forecast boundary.
                    Only meaningful for today's date: data.observed already
                    stops at the city's current local hour (see
                    heat_story.py's expected_hours), so everything to the
                    left of this marker is a real reading and everything to
                    the right is a forecast the user explicitly requested —
                    and, since visibleForecast already drops any hour that
                    has since passed (see its own comment above), never a
                    stale prediction for an hour that's actually already
                    gone by. */}
                {data.date === todayISO(city) && data.observed.length > 0 && (
                  <div className="shrink-0 w-8 flex flex-col items-center justify-center gap-1 snap-start" aria-hidden="true">
                    <div className="w-px flex-1 bg-gradient-to-b from-transparent via-borderstrong to-transparent" />
                    <span className="text-[8px] font-black tracking-widest text-inkfaint [writing-mode:vertical-rl]">NOW</span>
                    <div className="w-px flex-1 bg-gradient-to-b from-transparent via-borderstrong to-transparent" />
                  </div>
                )}
                {visibleForecast.map((f) => (
                  <HourCard
                    key={`fc-${f.hour}`}
                    time={f.hour}
                    exists
                    isForecast
                    temperature={f.temperature}
                    heatIndex={null}
                    isPeak={!!peak && peak.time === f.hour}
                    isSelected={selected?.type === 'forecast' && selected.entry.hour === f.hour}
                    tempUnit={tempUnit}
                    onClick={() => setSelected({ type: 'forecast', entry: f })}
                  />
                ))}
              </div>
              {(data.observed.length + visibleForecast.length) > 4 && (
                <>
                  <button
                    onClick={() => scrollCarousel(-1)}
                    className="hidden sm:flex absolute -left-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-surface border border-border items-center justify-center text-inkfaint hover:text-ink cursor-pointer shadow-md"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => scrollCarousel(1)}
                    className="hidden sm:flex absolute -right-3 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-surface border border-border items-center justify-center text-inkfaint hover:text-ink cursor-pointer shadow-md"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>

            {/* Active hour detail — only the real fields this hour actually
                has; nothing here is invented per-hour narrative copy. */}
            {selected && (
              <div className="mt-4 p-4 bg-app/50 rounded-xl border border-border/80 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
                <span className="text-inksoft flex items-center gap-2 font-semibold">
                  <span className={`w-2 h-2 rounded-full ${selected.type === 'forecast' ? 'bg-sky-400' : 'bg-orange-400'} shadow-[0_0_8px_rgba(249,115,22,0.6)]`}></span>
                  {selected.entry.hour}
                </span>
                <span className="text-inkmuted">Temp {formatTemp(selected.entry.temperature, tempUnit)}</span>
                {selected.entry.heat_index != null && (
                  <span className="text-inkmuted flex items-center gap-1"><ThermometerSun className="w-3 h-3" /> Feels {formatTemp(selected.entry.heat_index, tempUnit)}</span>
                )}
                {selected.entry.humidity != null && (
                  <span className="text-inkmuted flex items-center gap-1"><Droplets className="w-3 h-3" /> {selected.entry.humidity}% humidity</span>
                )}
                {selected.entry.wet_bulb != null && (
                  <span className="text-inkmuted flex items-center gap-1"><Wind className="w-3 h-3" /> Wet bulb {formatTemp(selected.entry.wet_bulb, tempUnit)}</span>
                )}
                {selected.entry.aqi != null && (
                  <span className="text-inkmuted">AQI {selected.entry.aqi}</span>
                )}
                <span className="ml-auto text-[10px] font-mono text-inkfaint">
                  {selected.type === 'forecast' ? 'Forecast — logged for reference, not an observation' : 'FortyGuard observation'}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 mt-4">
              {missingHours.length > 0 && (
                <button
                  onClick={() => setModal('missing')}
                  className="px-3.5 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-semibold cursor-pointer flex items-center gap-1.5"
                >
                  <AlertTriangle className="w-3.5 h-3.5" /> Fetch {missingHours.length} Missing Hour
                  {missingHours.length === 1 ? '' : 's'}
                </button>
              )}
              {forecastCandidates.length > 0 && (
                <button
                  onClick={() => setModal('forecast')}
                  className="px-3.5 py-2 rounded-xl bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 text-xs font-semibold cursor-pointer flex items-center gap-1.5"
                >
                  <CloudSun className="w-3.5 h-3.5" /> Fetch Forecast ({forecastCandidates.length}h)
                </button>
              )}
            </div>
            {jobError && (
              <p className="text-[11px] text-red-400 font-mono mt-2 flex items-center gap-1.5">
                <AlertTriangle className="w-3 h-3" /> {jobError}
              </p>
            )}

            {data.exposure_summary && (
              <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border/40 text-[11px] text-inksoft">
                <Info className="w-3.5 h-3.5 text-inkfaint shrink-0" />
                <span>
                  {data.exposure_summary.schools} school(s), {data.exposure_summary.hospitals} hospital(s)/clinic(s)
                  in this area — feeds the narrative below.
                </span>
              </div>
            )}
          </div>

          {/* Yesterday vs Today — only rendered when BOTH days actually
              have observed hours; every value is read straight from the
              two fetchHeatStory() calls, nothing here is estimated. */}
          {comparison ? (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-[0.2em] text-inkmuted mb-3">
                Today vs. Yesterday
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {comparison.map((row) => {
                  // Delta is computed in the SAME unit the two raw values
                  // are already in (Celsius for temp rows, hours for the
                  // threshold row). For display, a temperature delta needs
                  // its own scale-only conversion (°C diff * 9/5) — NOT
                  // formatTemp/cToF, which adds the +32 offset that's only
                  // valid for an absolute reading, not a difference.
                  const rawDelta = row.today - row.yesterday;
                  const isWorse = rawDelta > 0;
                  const displayDelta = row.isTemp
                    ? Math.abs(tempUnit === 'F' ? rawDelta * 1.8 : rawDelta).toFixed(1)
                    : Math.abs(rawDelta);
                  const unitLabel = row.isTemp ? `°${tempUnit}` : 'h';
                  return (
                    <div key={row.key} className="bg-surface/80 rounded-2xl p-5 border border-border">
                      <div className="text-xs text-inkmuted font-semibold">{row.metric}</div>
                      <div className={`text-2xl font-black mt-1 flex items-center gap-1 font-mono ${isWorse ? 'text-red-400' : rawDelta < 0 ? 'text-emerald-400' : 'text-inkmuted'}`}>
                        {rawDelta === 0 ? '—' : isWorse ? '↑' : '↓'} {rawDelta === 0 ? '' : `${displayDelta}${unitLabel}`}
                      </div>
                      <div className="text-[10px] text-inkfaint mt-1">
                        {row.isTemp ? `${formatTemp(row.yesterday, tempUnit, 0)} → ${formatTemp(row.today, tempUnit, 0)}` : `${row.yesterday}h → ${row.today}h`}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-xs text-inkmuted">
              Not enough observed data yet to compare with yesterday.
            </p>
          )}

          {/* Narrative — the one place in Thermora an LLM writes prose.
              Never generated automatically; always an explicit action,
              since it costs a real Groq call. Sections below are exactly
              what Groq returned, not fabricated driver copy. */}
          <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
            <div className="flex items-center justify-between pb-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-orange-400" />
                <h3 className="text-base font-bold text-ink">Why did the heat develop this way?</h3>
              </div>
              <button
                onClick={generateStory}
                disabled={storyLoading || !data.observed.some((o) => o.exists)}
                className="px-3.5 py-2 rounded-xl bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 shrink-0"
              >
                {storyLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {story ? 'Regenerate' : 'Generate Story'}
              </button>
            </div>

            {!data.observed.some((o) => o.exists) && (
              <p className="text-xs text-inkmuted mt-4">
                {data.coverage.temperature.expected_hours === 0 ? (
                  <>
                    It's just past midnight in {city.name} — the local 00:00 hour hasn't
                    fully elapsed yet, so there's no completed hour to observe or narrate.
                    This isn't missing data, the day just hasn't started.
                    {yesterdayData?.coverage?.temperature?.available_hours > 0 && ' Check the comparison card above for how yesterday looked.'}
                  </>
                ) : (
                  'No observed hours yet today — nothing to narrate. Fetch some missing hours above first, or check back later.'
                )}
              </p>
            )}
            {storyError && (
              <p className="text-xs text-red-400 font-mono mt-4 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {storyError}
              </p>
            )}
            {story && (
              <div className="space-y-3 mt-5">
                {/* Whether THIS narrative was generated with any real
                    forecast hours mixed in — story.includes_forecast is
                    the backend-confirmed source of truth (set at
                    generation time in groq_client.py); the visibleForecast
                    fallback only covers a narrative cached before this
                    field existed, using what's currently loaded (and
                    still genuinely in the future) as a best-effort
                    estimate (a "Regenerate" gets the precise
                    backend-confirmed value). */}
                {(story.includes_forecast ?? visibleForecast.length > 0) && (
                  <div className="flex items-start gap-2.5 p-3 rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-300 text-[11px] font-mono">
                    <CloudSun className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      This story includes {story.forecast_hour_count ?? visibleForecast.length} forecasted hour
                      {(story.forecast_hour_count ?? visibleForecast.length) === 1 ? '' : 's'} — predicted conditions
                      that haven't happened yet, not confirmed readings. Sections below say so explicitly
                      wherever they draw on it.
                    </span>
                  </div>
                )}
                {STORY_SECTIONS.map(({ key, label, icon: Icon, forecastAware }) => {
                  // Only "What's expected" is inherently forecast-driven
                  // (see groq_client.py's SYSTEM_PROMPT) — flagging every
                  // section as "may include forecast" would be both
                  // inaccurate (What happened/Why it matters are written
                  // from observed data and exposure counts only) and
                  // would dilute the one tag that's actually meaningful.
                  const sectionIsForecastBased = forecastAware && (story.includes_forecast ?? visibleForecast.length > 0);
                  return (
                    <div key={key} className="p-4 rounded-2xl bg-app/60 border border-border/80 flex items-start gap-3.5">
                      <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 border ${
                        sectionIsForecastBased ? 'bg-sky-500/15 border-sky-500/30 text-sky-400' : 'bg-orange-500/15 border-orange-500/30 text-orange-400'
                      }`}>
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-ink flex items-center gap-1.5">
                          {label}
                          {sectionIsForecastBased && (
                            <span className="px-1.5 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-300 text-[9px] font-mono uppercase tracking-wide">
                              forecast-based
                            </span>
                          )}
                        </h4>
                        <p className="text-xs text-inksoft mt-1 leading-relaxed">{story[key]}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {modal === 'missing' && (
        <ConsentModal
          title="Fetch missing observed hours?"
          hours={missingHours}
          requestNote="each one is written back as a real observation."
          confirming={confirming}
          onCancel={() => setModal(null)}
          onConfirm={() => runFetch(missingHours, { persist: true })}
        />
      )}
      {modal === 'forecast' && (
        <ConsentModal
          title="Fetch forecast hours?"
          hours={forecastCandidates}
          requestNote="results are shown here but never saved as observations."
          confirming={confirming}
          onCancel={() => setModal(null)}
          onConfirm={() => runFetch(forecastCandidates, { persist: false })}
        />
      )}
    </div>
  );
};