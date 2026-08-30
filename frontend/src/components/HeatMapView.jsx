import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  Flame, Layers, ShieldAlert, BookOpen, RefreshCw, AlertTriangle,
  Palette, X, Clock, CheckCircle2, SlidersHorizontal, Ruler, Film, Play, Pause,
  Scale as ScaleIcon, Thermometer, History, Crosshair, Info, ChevronDown, Users, Gauge,
} from 'lucide-react';
import { useLiveCityData, DEFAULT_QUERY, useAutoAdvanceLive, peekLiveNow, advancePinnedNow } from '../hooks/useLiveCityData';
import { useExposure } from '../hooks/useExposure';
import { loadCityData, isCached, primeRiskScoreFactor, notifyRiskFactorsUpdated } from '../lib/liveDataStore';
import { fetchHeatmapHistory } from '../api/thermoraApi';
import { LeafletHeatmapMap } from './heatmap/LeafletHeatmapMap';
import { TileInsights } from './heatmap/TileInsights';
import { TileRiskBadge } from './heatmap/TileRiskBadge';
import { COLOR_SCHEMES, colorAtPosition, buildBreaks } from '../lib/heatmapColors';
import { formatTemp, formatNumber, formatAnalyticValue } from '../lib/thermalFormat';
import { defaultBBoxForCity } from '../data/cities';
import {
  FILTER_TYPES, GRANULARITY_OPTIONS, ANALYTIC_MODES, THRESHOLD_MODES, describeWindow, todayISO, lastCompletedHourHHMM,
  hoursBetween, hourToHHMM,
} from '../lib/queryWindow';

function timeAgo(date) {
  if (!date) return null;
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// Ticks once a second while `startedAt` is set, so a loading state can show
// honest elapsed time instead of a spinner that looks identical whether
// it's been 2 seconds or 5 minutes. Returns null when not loading.
function useElapsedSeconds(startedAt) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!startedAt) return undefined;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return null;
  return Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000));
}

// Lets the user genuinely revisit a previously fetched window instead of
// losing it — lists this city's recently completed heatmap queries.
// Reads directly from the backend (Postgres-backed, see
// GET /api/heatmap/history) rather than a browser-local cache, so this
// list always reflects what's actually stored server-side: it goes empty
// if the database does, and never shows anything that isn't really there.
function HistoryPanel({ city, onClose, onSelect }) {
  const [entries, setEntries] = useState(null); // null = loading
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchHeatmapHistory(city.id, 10)
      .then((list) => { if (!cancelled) setEntries(list); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); });
    return () => { cancelled = true; };
  }, [city.id]);

  const toQuery = (entry) => ({
    analyticType: entry.analytic_type,
    granularity: entry.granularity,
    filterType: entry.filter_type,
    date: entry.date,
    time: entry.start_time,
    endTime: entry.end_time,
    endDate: entry.end_date,
    threshold: entry.threshold ?? 30,
    direction: entry.direction ?? 'above',
  });

  return (
    <div className="p-3 bg-app/70 rounded-xl border border-border space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-inkmuted font-mono uppercase flex items-center gap-1.5"><History className="w-3 h-3" /> Recently Viewed</span>
        <button onClick={onClose} className="p-1 text-inkmuted hover:text-ink rounded hover:bg-surface2 cursor-pointer" aria-label="Close history">
          <X className="w-3 h-3" />
        </button>
      </div>
      {error && <p className="text-[10px] text-red-400 font-mono">Couldn't load history: {error}</p>}
      {entries === null && !error && <p className="text-[10px] text-inkfaint font-mono">Loading…</p>}
      {entries !== null && entries.length === 0 && (
        <p className="text-[10px] text-inkfaint font-mono">Nothing cached in the database yet for {city.name}.</p>
      )}
      {entries !== null && entries.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {entries.map((entry) => {
            const isBackground = entry.purpose === 'risk_factor_background';
            return (
              <button
                key={entry.activity_id}
                onClick={() => onSelect(toQuery(entry))}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg border text-[11px] cursor-pointer ${
                  isBackground
                    ? 'bg-surface/30 hover:bg-surface2/70 border-border/60 text-inkfaint'
                    : 'bg-surface/60 hover:bg-surface2 border-border text-inksoft'
                }`}
              >
                <div className={`flex items-center gap-1.5 font-semibold ${isBackground ? 'text-inkmuted' : 'text-ink'}`}>
                  {isBackground && (
                    <span
                      className="shrink-0 px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-[8px] font-mono uppercase tracking-wide text-inkfaint"
                      title="Fetched automatically to power the Risk Score panel — not something you explicitly viewed on the map."
                    >
                      Risk factor
                    </span>
                  )}
                  <span>{describeWindow(toQuery(entry))}</span>
                </div>
                <div className="text-[9px] text-inkfaint font-mono">{entry.completed_at ? timeAgo(new Date(entry.completed_at)) : '—'}</div>
              </button>
            );
          })}
        </div>
      )}
      <p className="text-[9px] text-inkfaint font-mono">Reopens the same query — instant if still cached in the database, otherwise a fresh fetch. Entries badged "Risk factor" ran silently in the background to power the Risk Score panel — not something shown on the map at the time.</p>
    </div>
  );
}

// Collapsible panel section — the sidebar was growing into one long
// unbroken scroll (Query, Playback, Range drill, Display, Legend, Stats
// all always expanded at once). Each major block now collapses under its
// own header so only what you're actually working on takes up space, and
// everything else is one click away instead of a long scroll away.
// `defaultOpen` reflects what's realistically needed right after landing
// on the map (Query settings), everything else starts collapsed.
// Module-scope, not component-scope — HeatMapView is conditionally
// rendered by App.jsx (`activeTab === 'heatmap' && <HeatMapView .../>`),
// so switching tabs away and back is a genuine unmount/remount, not a
// hide/show. Without this, draftQuery/appliedQuery/isLive all reset to
// their fresh useState initializers on every return trip — silently
// jumping back to "right now" even if the user had explicitly queried a
// past date/hour moments before switching tabs. Restored on mount (see
// the lazy useState initializers below) and written back on every
// change (see the persistence effect further down), keyed by city id so
// a different city's last-viewed window is never shown for THIS city.
const viewStateByCity = new Map(); // cityId -> { draftQuery, appliedQuery, isLive }

function Section({ icon: Icon, title, badge, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border pb-3 last:border-b-0 last:pb-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-1 cursor-pointer group"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 text-xs font-mono text-inkmuted font-semibold group-hover:text-ink transition-colors">
          <Icon className="w-3.5 h-3.5" /> {title}
          {badge && <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-orange-500/15 text-orange-300 text-[9px] font-bold uppercase">{badge}</span>}
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-inkfaint shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="pt-2.5 space-y-3">{children}</div>}
    </div>
  );
}

export const HeatMapView = ({ city, userSettings, onNavigateTab }) => {
  // --- Query settings: these require a real FortyGuard round-trip, so
  // they live as a "draft" and only take effect on Apply & Fetch. ---
  // Defaults to a single, already-elapsed hour (not an unscoped full day)
  // — same reasoning as useLiveCityData's DEFAULT_QUERY: a "Single Day"
  // request for today with no time bound can reach into hours later today
  // that haven't happened yet, which FortyGuard can return empty or error
  // for. The user can still explicitly switch to Single Day / Range of
  // Hours / Range of Days from the filter controls below at any time.
  // Bug fix — was todayISO()/lastCompletedHourHHMM() with no `city` arg
  // (browser-local time), while `city` is right here in props the whole
  // time. See useLiveCityData.js's getPinnedNow for the full explanation
  // of why that's a real bug, not just a cosmetic mismatch: it's the
  // exact same call, just duplicated here for Heat Map view's own
  // initial draft instead of going through the shared hook.
  const [draftQuery, setDraftQuery] = useState(() => {
    const saved = viewStateByCity.get(city.id);
    return saved?.draftQuery ?? { ...DEFAULT_QUERY, date: todayISO(city), filterType: 1, time: lastCompletedHourHHMM(city) };
  });
  const [appliedQuery, setAppliedQuery] = useState(() => {
    const saved = viewStateByCity.get(city.id);
    return saved?.appliedQuery ?? draftQuery;
  });
  const isDirty = JSON.stringify(draftQuery) !== JSON.stringify(appliedQuery);

  // Whether the view is currently showing "now" (auto-tracks the real
  // clock) vs a date/hour the user explicitly asked for. This is the
  // flag that decides everything about the "should this silently change
  // later" behavior:
  //   - true  → useAutoAdvanceLive below is allowed to move this forward
  //             the moment the city's real local hour advances, and
  //             switching tabs away/back never resets it off true.
  //   - false → nothing here EVER changes this view's query on its own;
  //             it stays exactly on whatever date/hour was requested
  //             until the user explicitly applies a new query or hits
  //             "Back to live" — a tab switch is not a reason to reset.
  // Starts true because the initial draft/applied query above IS the
  // live "last completed hour" for this city.
  const [isLive, setIsLive] = useState(() => {
    const saved = viewStateByCity.get(city.id);
    return saved?.isLive ?? true;
  });

  // Persists draftQuery/appliedQuery/isLive into the module-scope store
  // above so a later remount (tab away and back) restores exactly what
  // was on screen instead of resetting to "now". Guarded by
  // heatMapViewCityIdRef so a pure city switch (city.id changing with
  // this render's draftQuery/appliedQuery still holding the PREVIOUS
  // city's values, since nothing here resets them on city change) never
  // writes that stale pair into the NEW city's slot — only a genuine
  // change to one of these three for the city already current gets
  // persisted.
  const heatMapViewCityIdRef = useRef(city.id);
  useEffect(() => {
    if (heatMapViewCityIdRef.current === city.id) {
      viewStateByCity.set(city.id, { draftQuery, appliedQuery, isLive });
    }
    heatMapViewCityIdRef.current = city.id;
  }, [city.id, draftQuery, appliedQuery, isLive]);

  // True when `q` (filterType 1 only — the other filter types are
  // inherently custom ranges the user built by hand, never "live") is
  // exactly the city's current "last completed hour" at this instant.
  // Used right when a query is applied to decide whether this new
  // appliedQuery should be tracked as live going forward.
  const isLiveQuery = useCallback((q) => {
    if (q.filterType !== 1) return false;
    const fresh = peekLiveNow(city);
    return q.date === fresh.date && q.time === fresh.time;
  }, [city]);

  // See the checkbox below the Analytic Type selector — when on, Apply &
  // Fetch also fires the Exceedance/Persistence requests the Risk Score
  // needs, alongside whichever mode is actually being viewed.
  //
  // Defaults ON. It used to default off (opt-in), which meant the Risk
  // Score's Exceedance/Persistence factors stayed permanently "Missing"
  // for anyone who didn't know to check a box — a core, always-visible
  // feature silently starting broken is worse than the extra request
  // cost. The background city-summary loader (scheduler.py) ALSO
  // auto-populates these for TODAY specifically when a city is first
  // opened, but that's a best-effort, silent, backend-only path with no
  // visible failure state and no coverage for any OTHER date — this
  // toggle is the reliable, visible, user-facing guarantee: whatever
  // date you explicitly fetch, its risk factors come with it, with
  // actual status feedback (see riskBoostStatus below) instead of a
  // silent maybe.
  const [riskBoost, setRiskBoost] = useState(true);
  const [riskBoostStatus, setRiskBoostStatus] = useState({}); // { exceedance: 'fetching'|'done'|<error>, persistence: ... }
  // Deliberately resets to the default (true) on CITY change only (not on
  // every Apply — see the appliedQuery-keyed effect further down, which
  // must NOT touch this). A per-city override — someone deliberately
  // unchecking this once to save cost on one expensive query — shouldn't
  // silently carry over to a DIFFERENT city, in either direction: it
  // could mean tripling cost on a city they never meant to risk-score, or
  // just as easily mean a different city silently missing its risk
  // factors again. Resetting to the known-good default each time is the
  // predictable choice; it SHOULD stay however the user left it across
  // ordinary same-city exploration (switching hours, dates, analytic
  // type) — re-checking a box on every single Apply would defeat the
  // point of a "keep my risk data current while I look around this city"
  // toggle.
  useEffect(() => {
    setRiskBoost(true);
    setRiskBoostStatus('idle');
  }, [city.id]);
  // Bumped only once a riskBoost fetch genuinely completes — passed to
  // RiskScoreCard as refreshToken so it re-fetches exactly once per
  // completed boost, not also on the 'fetching' transition.
  const [riskFactorsVersion, setRiskFactorsVersion] = useState(0);

  // --- Display settings: purely client-side, applied instantly to
  // whatever data is already loaded — no network call. ---
  const [classCount, setClassCount] = useState(8);
  const [classification, setClassification] = useState('equal'); // 'equal' | 'quantile'
  const [scheme, setScheme] = useState('warm');
  const [unit, setUnit] = useState(userSettings?.tempUnit === 'C' ? 'C' : 'F');
  const [opacity, setOpacity] = useState(0.75);
  const [showFill, setShowFill] = useState(true);
  const [showBorders, setShowBorders] = useState(true);

  // Phase 6 — exposure points (schools/hospitals) as an optional overlay.
  // Fetched once per city's default AOI (cached ~30 days on the backend,
  // since this barely changes), independent of the heat query above.
  const [showExposure, setShowExposure] = useState(false);
  const exposureBbox = useMemo(() => defaultBBoxForCity(city), [city]);
  const { points: exposurePoints, density: exposureDensity, loading: exposureLoading } = useExposure(exposureBbox);

  const [selectedTile, setSelectedTile] = useState(null);
  // Defaults to closed on a narrow viewport — checked once, synchronously,
  // via lazy useState initializer so the very first paint already reflects
  // it (no open-then-immediately-slam-shut flash). At `lg` and wider this
  // panel is `lg:static` anyway (see the JSX below) and effectively always
  // visible, so starting it "open" there is irrelevant; at narrower
  // widths it's `fixed`, full-height, up to 85vw wide — defaulting that
  // OPEN meant the map itself was invisible behind it on every first load
  // on a phone/tablet, which is the core of what "not responsive" meant
  // here. Falls back to true (desktop's existing behavior) in any
  // environment without `window` (SSR/tests).
  const [showControls, setShowControls] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 1024
  );
  const [showDrawer, setShowDrawer] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const mapRef = useRef(null);

  // Which single day/hour chip is *currently* awaiting its own live fetch —
  // lets the UI show a spinner on just that one chip instead of a vague
  // full-panel "loading" state, so it's clear exactly what's happening: one
  // small request for one hour, not a re-fetch of everything.
  const [pendingStep, setPendingStep] = useState(null);

  // --- Playback: only meaningful for a window with more than one instant
  // to step through — a single day (24 hours) or a range of hours. A
  // single-hour query has nothing to scrub, so no playback UI at all.
  // Range of Days is handled separately below (direct date+time pick,
  // no scrubbing/auto-play — see rangeDrillDate/rangeDrillTime).
  const [playbackHour, setPlaybackHour] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Range of Days: FortyGuard's filter_type 4 only returns ONE aggregate
  // for the whole range, so "browsing" it means picking one specific
  // date+time inside the range and running a genuine single-hour query for
  // it — same explicit-request pattern as Time Compare. Draft fields are
  // purely local until "View This Hour" is clicked.
  const [rangeDrillDate, setRangeDrillDate] = useState(null);
  const [rangeDrillTime, setRangeDrillTime] = useState('14:00');
  const [rangeDrillApplied, setRangeDrillApplied] = useState(null); // null = show full-range aggregate

  // Auto-play does NOT fire a live FortyGuard request on every tick.
  // Instead, "Build Timeline" explicitly pre-fetches every hour in the
  // fetched window up front — one request per frame, awaited
  // sequentially (never concurrent, so this can't cause the
  // thundering-herd problem the rest of the app guards against). Only
  // once ALL of them are cached does Play become available — at that
  // point advancing frames is a pure cache read, no network call.
  const [timelineStatus, setTimelineStatus] = useState('idle'); // idle | building | ready | error
  const [timelineProgress, setTimelineProgress] = useState({ done: 0, total: 0 });
  const [timelineError, setTimelineError] = useState(null);

  useEffect(() => {
    setPlaybackHour(null);
    setIsPlaying(false);
    setRangeDrillDate(appliedQuery.date);
    setRangeDrillApplied(null);
    setTimelineStatus('idle');
    setTimelineProgress({ done: 0, total: 0 });
    setTimelineError(null);
  }, [appliedQuery]);

  // 24 hour marks for a Single Day, or just the hours within a Range of
  // Hours window — these are the only two filter types with an
  // hour-by-hour scrub + auto-play UI. Range of Days uses the direct
  // date+time picker instead (see below), not this list.
  const hourOptions = useMemo(() => {
    if (appliedQuery.filterType === 3) return Array.from({ length: 24 }, (_, h) => h);
    if (appliedQuery.filterType === 2) return hoursBetween(appliedQuery.time, appliedQuery.endTime);
    return [];
  }, [appliedQuery]);

  const playbackAvailable = (appliedQuery.filterType === 3 || appliedQuery.filterType === 2) && hourOptions.length > 0;
  const timelineList = hourOptions;

  const queryForHour = useCallback((hour) => (
    { ...appliedQuery, filterType: 1, time: hourToHHMM(hour), endTime: undefined, endDate: undefined }
  ), [appliedQuery]);

  const queryForRangeDrill = useCallback((date, time) => (
    { ...appliedQuery, filterType: 1, date, time, endDate: undefined, endTime: undefined }
  ), [appliedQuery]);

  // Manual scrub click: each one is a single, explicit, user-initiated
  // request (same trust level as clicking Apply). If that exact hour was
  // already fetched this session, it resolves from cache instantly —
  // otherwise this shows a spinner on JUST that chip while its own live
  // FortyGuard request runs, so it's visibly "this one small thing", not a
  // mysterious full re-fetch.
  const selectHour = useCallback(async (hour) => {
    setIsPlaying(false);
    setPlaybackHour(hour);
    const q = queryForHour(hour);
    if (!isCached(city, q)) {
      setPendingStep({ type: 'hour', value: hour });
      try { await loadCityData(city, q); } catch { /* surfaced via useLiveCityData's own error state */ }
      setPendingStep(null);
    }
  }, [city, queryForHour]);

  // Range of Days has no scrub/auto-play — this is the one explicit
  // "View This Hour" action for that filter type.
  const viewRangeDrill = useCallback(async () => {
    const q = queryForRangeDrill(rangeDrillDate, rangeDrillTime);
    setRangeDrillApplied({ date: rangeDrillDate, time: rangeDrillTime });
    if (!isCached(city, q)) {
      setPendingStep({ type: 'rangeDrill', value: `${rangeDrillDate} ${rangeDrillTime}` });
      try { await loadCityData(city, q); } catch { /* surfaced via useLiveCityData's own error state */ }
      setPendingStep(null);
    }
  }, [city, queryForRangeDrill, rangeDrillDate, rangeDrillTime]);

  const rangeDrillIsDirty = !rangeDrillApplied || rangeDrillApplied.date !== rangeDrillDate || rangeDrillApplied.time !== rangeDrillTime;

  // Sequential, explicit pre-fetch of every hour in `timelineList` — one
  // real FortyGuard request per frame, awaited one at a time (not blasted
  // concurrently), with visible progress. This is the ONLY place playback
  // touches the network; once it resolves, Play just flips through cache.
  const buildTimeline = useCallback(async () => {
    setTimelineStatus('building');
    setTimelineError(null);
    setTimelineProgress({ done: 0, total: timelineList.length });
    for (let i = 0; i < timelineList.length; i++) {
      const hour = timelineList[i];
      const q = queryForHour(hour);
      try {
        await loadCityData(city, q);
      } catch (err) {
        setTimelineError(`Failed building frame ${hourToHHMM(hour)}: ${err.message || err}`);
        setTimelineStatus('error');
        return;
      }
      setTimelineProgress({ done: i + 1, total: timelineList.length });
    }
    setTimelineStatus('ready');
  }, [city, timelineList, queryForHour]);

  const togglePlay = () => {
    if (isPlaying) { setIsPlaying(false); return; }
    if (timelineStatus === 'ready') { setIsPlaying(true); return; }
    buildTimeline().then(() => setIsPlaying(true));
  };

  // Instant Display-layer preview of whatever riskBoost already fetched —
  // NOT a Query change, no Apply, no live request: it just points the map
  // at the exact same (date, filterType:3, granularity:100) combination
  // primeRiskScoreFactor used, which is guaranteed cached the moment
  // riskBoostStatus reaches 'done'. Always the full day, regardless of
  // whatever the primary window is (single hour, range of hours, etc.) —
  // that's not a limitation of this preview, it's what
  // exceedance/persistence structurally ARE (see primeRiskScoreFactor's
  // own docstring in liveDataStore.js).
  const [factorPreview, setFactorPreview] = useState(null); // null | 'exceedance' | 'persistence'
  useEffect(() => { setFactorPreview(null); }, [city.id, appliedQuery]);

  const factorPreviewQuery = useMemo(() => {
    if (!factorPreview) return null;
    return {
      ...appliedQuery,
      analyticType: factorPreview,
      filterType: 3,
      time: undefined,
      endTime: undefined,
      endDate: undefined,
      granularity: 100,
    };
  }, [factorPreview, appliedQuery]);

  // What the map actually displays right now — a riskBoost factor
  // preview (highest precedence: it's an explicit, deliberate Display
  // choice), the base applied window, the hour the user scrubbed/played
  // to (Single Day / Range of Hours), or the specific date+time drilled
  // into (Range of Days). Falls back to the literal appliedQuery
  // reference when nothing's overriding it, so `displayQuery !==
  // appliedQuery` doubles as "is this something other than the plain
  // applied window".
  const displayQuery = useMemo(() => {
    if (factorPreviewQuery) return factorPreviewQuery;
    if (appliedQuery.filterType === 4 && rangeDrillApplied) {
      return queryForRangeDrill(rangeDrillApplied.date, rangeDrillApplied.time);
    }
    if ((appliedQuery.filterType === 3 || appliedQuery.filterType === 2) && playbackHour != null) {
      return queryForHour(playbackHour);
    }
    return appliedQuery;
  }, [appliedQuery, playbackHour, rangeDrillApplied, queryForHour, queryForRangeDrill, factorPreviewQuery]);

  // Auto-advance playback — steps through the PRE-BUILT (cached) hour list
  // only, so every tick is a synchronous cache read, never a live
  // FortyGuard call. Not used for Range of Days (no auto-play there).
  useEffect(() => {
    if (!isPlaying || timelineStatus !== 'ready') return undefined;
    const list = timelineList;
    if (!list.length) return undefined;
    const interval = setInterval(() => {
      setPlaybackHour((cur) => {
        const idx = cur == null ? -1 : list.indexOf(cur);
        return list[(idx + 1) % list.length];
      });
    }, 1600);
    return () => clearInterval(interval);
  }, [isPlaying, timelineStatus, timelineList]);

  const { heatmap, loading, loadingStartedAt, error, fetchedAt, refresh } = useLiveCityData(city, displayQuery);
  const elapsedSeconds = useElapsedSeconds(loading ? loadingStartedAt : null);
  // Keyed off displayQuery, NOT appliedQuery — this is what makes every
  // formatBucketValue() call (tile panel's Average/Min-Max, Area Stats,
  // the class-break legend) switch to "8.2 hrs" instead of staying stuck
  // showing temperature-formatted degrees while a Display-section
  // Exceedance/Persistence preview is active. appliedQuery only reflects
  // the last thing actually Applied in Query — it never changes just from
  // clicking a Display preview button, so keying this off it meant every
  // one of those readouts kept using activeMode.unit === 'temp' regardless
  // of what was actually on screen.
  const activeMode = ANALYTIC_MODES.find((m) => m.key === displayQuery.analyticType) || ANALYTIC_MODES[0];
  // tcm tiles carry their number as properties.average_temperature —
  // exceedance/persistence/time_of_measure tiles don't have that field at
  // all; per FortyGuard's actual response shape their tiles are just
  // {tile_id, value}. Reading .average_temperature off one of those tiles
  // (as every spot below used to, unconditionally) is always undefined,
  // not "the wrong number" — but combined with the stale-selectedTile bug
  // fixed above, what looked like "still showing Exceedance's data" was
  // really "a stale Exceedance tile object, which itself never had a real
  // average_temperature field either since IT was also value-only".
  const tileValueKey = activeMode.unit === 'temp' ? 'average_temperature' : 'value';

  useEffect(() => { setShowDrawer(!!selectedTile); }, [selectedTile]);

  // A tile clicked while viewing one dataset (e.g. Exceedance) kept its
  // captured properties forever — nothing cleared `selectedTile` when
  // `displayQuery` changed, so switching the Display preview to
  // Persistence (or back to Temperature) re-rendered the MAP with new
  // tile colors but left the drawer showing the stale tile object from
  // whatever was selected before, including its old numbers. Reset the
  // selection whenever the actual data source changes so the drawer
  // can't show one dataset's tile while the map shows another's.
  useEffect(() => { setSelectedTile(null); }, [displayQuery]);

  // Close tile drawer on Escape.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { setSelectedTile(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const stats = heatmap?.stats_data?.temperature_stats;
  const tileValues = useMemo(
    () => (heatmap?.map_data?.features || []).map((f) => f.properties[tileValueKey]).filter((v) => v != null),
    [heatmap, tileValueKey]
  );
  const dataMin = stats?.minimum ?? (tileValues.length ? Math.min(...tileValues) : 0);
  const dataMax = stats?.maximum ?? (tileValues.length ? Math.max(...tileValues) : 1);

  const breaks = useMemo(
    () => buildBreaks(tileValues, dataMin, dataMax, classCount, classification),
    [tileValues, dataMin, dataMax, classCount, classification]
  );

  const formatBucketValue = useCallback((v) => formatAnalyticValue(activeMode.unit, v, unit), [activeMode, unit]);

  const applyQuery = () => {
    setAppliedQuery(draftQuery);
    setIsLive(isLiveQuery(draftQuery));
  };

  // Explicit "Back to live" — the ONLY other way (besides the real hour
  // advancing while already live) that this view's query changes on its
  // own initiative. Re-reads the clock fresh rather than trusting
  // whatever might already be pinned, so this always genuinely jumps to
  // right now even if nothing had drifted yet.
  const goLive = () => {
    const fresh = advancePinnedNow(city);
    const liveQuery = { ...draftQuery, filterType: 1, time: fresh.time, date: fresh.date, endTime: null, endDate: null };
    setDraftQuery(liveQuery);
    setAppliedQuery(liveQuery);
    setIsLive(true);
    setRangeDrillApplied(null);
    setPlaybackHour(null);
  };

  // The only thing allowed to move this view's query without the user
  // clicking anything: once per real hour boundary, and only while
  // `isLive` is true (see its declaration above for why a manually
  // browsed date/hour is never touched by this).
  useAutoAdvanceLive(city, isLive && appliedQuery.filterType === 1, (fresh) => {
    setDraftQuery((q) => ({ ...q, date: fresh.date, time: fresh.time }));
    setAppliedQuery((q) => ({ ...q, date: fresh.date, time: fresh.time }));
  });

  // Fires the Exceedance/Persistence backfill for EVERY settled query —
  // including the very first automatic fetch on mount, which never goes
  // through applyQuery() at all (appliedQuery's useState initializer sets
  // it directly to the initial draftQuery, so useLiveCityData's own fetch
  // fires before the user has clicked anything). Keying this on
  // appliedQuery itself — rather than living inside the click handler —
  // is what makes it fire uniformly for that first load too, not just
  // for later manual Apply clicks. Also keyed on city.id so switching
  // cities (which re-fetches the SAME appliedQuery object for a new
  // city) triggers its own backfill too, and on riskBoost so flipping
  // the toggle on immediately backfills whatever's already on screen
  // instead of waiting for the next Apply.
  useEffect(() => {
    if (!riskBoost) return undefined;
    const boosts = ['exceedance', 'persistence'].filter((t) => t !== appliedQuery.analyticType);
    if (!boosts.length) { setRiskBoostStatus({}); return undefined; }
    let cancelled = false;
    setRiskBoostStatus(Object.fromEntries(boosts.map((t) => [t, 'fetching'])));

    const settled = Promise.allSettled(
      boosts.map((analyticType) =>
        primeRiskScoreFactor(city, { ...appliedQuery, analyticType }).then(
          () => { if (!cancelled) setRiskBoostStatus((s) => ({ ...s, [analyticType]: 'done' })); },
          (err) => {
            if (!cancelled) setRiskBoostStatus((s) => ({ ...s, [analyticType]: err.message || String(err) }));
            throw err; // keep this settlement 'rejected' for the allSettled check below
          },
        )
      )
    );

    settled.then((results) => {
      if (cancelled) return;
      // Notify on ANY success, not just if BOTH succeeded — this used to
      // be a plain Promise.all, so persistence failing (say, a transient
      // FortyGuard hiccup) meant exceedance's genuinely-successful write
      // to location_features never triggered a refresh anywhere, even
      // though the data was sitting right there in Postgres. Partial
      // credit matches how risk_score.py itself already treats a partial
      // set of factors — re-normalizing weights over whatever IS
      // available — so the refresh signal should too.
      if (results.some((r) => r.status === 'fulfilled')) {
        setRiskFactorsVersion((v) => v + 1);
        notifyRiskFactorsUpdated(city.id);
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.id, appliedQuery, riskBoost]);
  const patchDraft = (patch) => setDraftQuery((q) => ({ ...q, ...patch }));

  const filterTypeConfig = FILTER_TYPES.find((f) => f.value === draftQuery.filterType) || FILTER_TYPES[2];
  // Also show Threshold/Direction when riskBoost is on and viewing
  // Temperature — those controls apply to the exceedance/persistence
  // background fetches riskBoost triggers even though the primary mode
  // being displayed doesn't need them itself.
  const needsThreshold = THRESHOLD_MODES.has(draftQuery.analyticType) || riskBoost;

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col lg:flex-row bg-app text-ink overflow-hidden font-sans relative isolate">
      {/* Dims the map and closes whichever off-canvas panel is open on a
          tap outside it — only below `lg`, where Controls/Tile Details are
          `fixed` overlays rather than inline flex columns. Without this,
          a panel covering up to 85vw/100vw of the screen had no way to
          dismiss it besides finding its small X button, and the map
          underneath looked broken/unreachable rather than just covered. */}
      {(showControls || (showDrawer && selectedTile)) && (
        <div
          className="fixed inset-x-0 top-16 bottom-0 z-30 bg-black/60 lg:hidden"
          onClick={() => { setShowControls(false); setShowDrawer(false); }}
          aria-hidden="true"
        />
      )}
      {showControls && (
        <div className="fixed top-16 bottom-0 left-0 z-40 w-80 max-w-[85vw] lg:static lg:top-auto lg:bottom-auto lg:w-80 bg-surface/95 lg:bg-surface/90 border-r border-border p-4 shrink-0 flex flex-col gap-5 overflow-y-auto backdrop-blur-xl shadow-2xl">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-orange-500/20 border border-orange-500/30 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5 text-orange-400" />
              </div>
              <div>
                <h2 className="text-xs font-bold text-ink uppercase tracking-wider font-mono">Map Controls</h2>
                <span className="text-[10px] text-inkmuted font-mono">{city.name}</span>
              </div>
            </div>
            <button onClick={() => setShowControls(false)} className="p-1.5 text-inkmuted hover:text-ink rounded-lg hover:bg-surface2 cursor-pointer" aria-label="Close controls">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Data window summary — always visible so it's never a mystery
              what's actually being shown. When drilled into a specific
              day/hour, this shows explicit labeled Date/Time fields (that
              drill-down IS its own distinct fetch, worth calling out) —
              for the base window itself (incl. a plain single-hour query,
              which has nothing to drill into) it's just the one-line
              description, no extra breakout. */}
          <div className="p-3 bg-app/70 rounded-xl border border-border space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="text-[10px] text-inkmuted font-mono uppercase flex items-center gap-1.5"><Clock className="w-3 h-3" /> Currently Showing</div>
              <button
                onClick={() => setShowHistory(true)}
                className="text-[10px] text-inkfaint hover:text-orange-300 font-mono flex items-center gap-1 cursor-pointer"
                title="Revisit a previously fetched window"
              >
                <History className="w-3 h-3" /> History
              </button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs text-ink font-semibold">{describeWindow(displayQuery)}</div>
              {isLive ? (
                <span className="shrink-0 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Live
                </span>
              ) : (
                <button
                  onClick={goLive}
                  className="shrink-0 text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-surface2 text-inkfaint border border-border hover:text-orange-300 hover:border-orange-500/40 cursor-pointer transition-all"
                  title="Jump back to the current hour"
                >
                  ↺ Back to live
                </button>
              )}
            </div>
            {isLive && (
              <div className="text-[9.5px] text-inkfaint font-mono">
                Tracking the current hour — this updates on its own each time a new hour starts. Apply a different date/hour below to stop tracking it.
              </div>
            )}
            <div className="text-[10px] text-inkfaint font-mono">
              {GRANULARITY_OPTIONS.find((g) => g.value === appliedQuery.granularity)?.hint} · {activeMode.label}
              {fetchedAt && <> · updated {timeAgo(fetchedAt)}</>}
            </div>
            {displayQuery !== appliedQuery && (
              <div className="flex items-center gap-3 pt-1.5 mt-1 border-t border-border/60">
                <div>
                  <div className="text-[9px] text-inkfaint font-mono uppercase">Date</div>
                  <div className="text-[11px] font-bold text-orange-300 font-mono">{displayQuery.date}</div>
                </div>
                {displayQuery.time && (
                  <div>
                    <div className="text-[9px] text-inkfaint font-mono uppercase">Time</div>
                    <div className="text-[11px] font-bold text-orange-300 font-mono">{displayQuery.time}</div>
                  </div>
                )}
                <div className="text-[9px] text-inkfaint font-mono ml-auto">from base: {describeWindow(appliedQuery)}</div>
              </div>
            )}
          </div>

          {stats && (
            <div className="p-3 bg-app/70 rounded-xl border border-border space-y-1.5">
              {/* Was hardcoded to formatTemp() regardless of analytic mode, so
                  switching to Exceedance/Persistence/Diurnal Peak Hour showed
                  those hours/hour values mislabeled and formatted as if they
                  were temperatures (e.g. "68.5°F" for what is actually "6.5
                  hrs"). formatBucketValue already knows the right unit per
                  activeMode — reuse it here instead of assuming temp. */}
              <div className="text-[11px] text-inkmuted font-mono uppercase">Area Stats — {activeMode.label} (live)</div>
              <div className="flex justify-between text-xs"><span className="text-inksoft">Mean</span><span className="font-bold text-ink">{formatBucketValue(stats.mean)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-inksoft">Min</span><span className="font-bold text-ink">{formatBucketValue(stats.minimum)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-inksoft">Max</span><span className="font-bold text-ink">{formatBucketValue(stats.maximum)}</span></div>
              <div className="flex justify-between text-xs"><span className="text-inksoft">Std Dev</span><span className="font-bold text-ink">{formatNumber(stats.standard_deviation, 3)}</span></div>
            </div>
          )}

          {showHistory && (
            <HistoryPanel
              city={city}
              onClose={() => setShowHistory(false)}
              onSelect={(query) => {
                setDraftQuery(query);
                setAppliedQuery(query);
                setIsLive(isLiveQuery(query));
                setRangeDrillApplied(null);
                setPlaybackHour(null);
                setShowHistory(false);
              }}
            />
          )}

          <button
            onClick={() => onNavigateTab('timecompare')}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-bold bg-surface2 hover:bg-surface3 border border-borderstrong text-orange-300 transition-all cursor-pointer"
          >
            <ScaleIcon className="w-3.5 h-3.5" /> Compare Two Time Windows
          </button>

          {/* ---- QUERY SETTINGS (require Apply & Fetch) ---- */}
          <Section icon={SlidersHorizontal} title="Query (FortyGuard)" defaultOpen badge={isDirty ? 'unapplied' : null}>

            <div>
              <div className="text-[10px] text-inkfaint font-mono mb-1.5">Analytic Type</div>
              <div className="space-y-1.5">
                {ANALYTIC_MODES.map((m) => (
                  <button
                    key={m.key}
                    onClick={() => patchDraft({ analyticType: m.key })}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium transition-all text-left cursor-pointer ${
                      draftQuery.analyticType === m.key ? 'bg-orange-500/20 text-orange-300 font-bold border border-orange-500/40' : 'bg-surface/60 text-inksoft hover:bg-surface2 border border-border'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* The Risk Score (Dashboard, and now the panel below too) is
                deterministic over location_features — but exceedance_hours
                and persistence_hours only ever get populated by a heatmap
                fetch made WITH that specific analytic type (see
                location_features.py). Viewing "Temperature" and clicking
                Apply never touches those two columns, so the score sat
                permanently re-normalized with "Missing: Exceedance,
                Persistence" unless the user separately, manually, switched
                modes and re-applied twice more. This lets Apply & Fetch
                also fire those two as extra background requests — each is
                still its own real, separately billed FortyGuard call (same
                "nothing fires automatically without being asked" rule as
                everywhere else in this app), it just asks for both at once
                instead of one manual switch-and-apply at a time. It never
                changes what the map itself displays. */}
            <label className="flex items-start gap-2 px-3 py-2 rounded-xl bg-app/60 border border-border text-[11px] text-inksoft cursor-pointer">
              <input
                type="checkbox"
                checked={riskBoost}
                onChange={(e) => setRiskBoost(e.target.checked)}
                className="mt-0.5 cursor-pointer"
              />
              <span>
                <span className="font-semibold">Also fetch Exceedance &amp; Persistence</span>
                <span className="block text-[10px] text-inkfaint font-mono mt-0.5">
                  Feeds the Risk Score below. 2 extra FortyGuard requests, using this same Threshold/Data Window. Doesn't change the map.
                </span>
              </span>
            </label>

            {needsThreshold && (
              <div className="p-2.5 rounded-xl bg-app/60 border border-border space-y-2">
                <div className="text-[10px] text-inkfaint font-mono flex items-center gap-1"><Thermometer className="w-3 h-3" /> Threshold</div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={draftQuery.threshold}
                    onChange={(e) => patchDraft({ threshold: Number(e.target.value) })}
                    className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink"
                  />
                  <span className="text-[10px] text-inkfaint font-mono">°C</span>
                </div>
                <div className="flex gap-1.5">
                  {['above', 'below'].map((d) => (
                    <button
                      key={d}
                      onClick={() => patchDraft({ direction: d })}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-semibold capitalize cursor-pointer ${draftQuery.direction === d ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'}`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] text-inkfaint font-mono mb-1.5">Data Window</div>
              <select
                value={draftQuery.filterType}
                onChange={(e) => patchDraft({ filterType: Number(e.target.value) })}
                className="w-full bg-surface/60 border border-border rounded-lg px-2.5 py-1.5 text-xs text-ink cursor-pointer"
              >
                {FILTER_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>

              <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                <div>
                  <span className="text-[9px] text-inkfaint font-mono">Date</span>
                  <input type="date" value={draftQuery.date} onChange={(e) => patchDraft({ date: e.target.value })}
                    className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1 text-[11px] text-ink" />
                </div>
                {filterTypeConfig.needs.includes('endDate') && (
                  <div>
                    <span className="text-[9px] text-inkfaint font-mono">End Date</span>
                    <input type="date" value={draftQuery.endDate || ''} onChange={(e) => patchDraft({ endDate: e.target.value })}
                      className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1 text-[11px] text-ink" />
                  </div>
                )}
                {filterTypeConfig.needs.includes('time') && (
                  <div>
                    <span className="text-[9px] text-inkfaint font-mono">Start Time</span>
                    <input type="time" value={draftQuery.time || '14:00'} onChange={(e) => patchDraft({ time: e.target.value })}
                      className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1 text-[11px] text-ink" />
                  </div>
                )}
                {filterTypeConfig.needs.includes('endTime') && (
                  <div>
                    <span className="text-[9px] text-inkfaint font-mono">End Time</span>
                    <input type="time" value={draftQuery.endTime || '18:00'} onChange={(e) => patchDraft({ endTime: e.target.value })}
                      className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1 text-[11px] text-ink" />
                  </div>
                )}
              </div>
            </div>

            <div>
              <div className="text-[10px] text-inkfaint font-mono mb-1.5 flex items-center gap-1"><Ruler className="w-3 h-3" /> Tile Granularity</div>
              <div className="flex gap-1.5">
                {GRANULARITY_OPTIONS.map((g) => (
                  <button
                    key={g.value}
                    title={g.hint}
                    onClick={() => patchDraft({ granularity: g.value })}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer ${
                      draftQuery.granularity === g.value ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={applyQuery}
              disabled={loading}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer disabled:opacity-50 ${
                isDirty ? 'bg-orange-500 hover:bg-orange-400 text-zinc-950' : 'bg-surface2 text-inkmuted'
              }`}
            >
              {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              {loading ? 'Fetching from FortyGuard…' : isDirty ? 'Apply & Fetch New Data' : 'Up to date'}
            </button>
          </Section>

          {/* ---- HOUR-BY-HOUR PLAYBACK (Single Day / Range of Hours only).
              Manual scrub buttons below are each a single explicit click =
              one real FortyGuard request, same as clicking Apply.
              Auto-Play is different: it first explicitly pre-fetches every
              hour in this window ("Build Timeline"), and only cycles
              through those once they're cached — never a live call on a
              timer. ---- */}
          {playbackAvailable && (
            <Section icon={Film} title="Timeline Playback" badge={playbackHour != null ? `hour ${String(playbackHour).padStart(2, '0')}` : (isPlaying ? 'playing' : null)}>
              <div className="flex items-center justify-between text-xs font-mono text-inkmuted font-semibold -mt-1">
                <span>Play / pause</span>
                <button
                  onClick={togglePlay}
                  disabled={timelineStatus === 'building'}
                  className="p-1.5 rounded-lg bg-surface2 hover:bg-surface3 text-orange-300 cursor-pointer disabled:opacity-50"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  title={timelineStatus === 'ready' ? undefined : `Builds all ${timelineList.length} hours first (sequential), then plays`}
                >
                  {timelineStatus === 'building' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </button>
              </div>

              {timelineStatus === 'building' && (
                <div className="text-[10px] text-inkfaint font-mono">
                  Pre-fetching hour {timelineProgress.done}/{timelineProgress.total} from FortyGuard…
                </div>
              )}
              {timelineStatus === 'error' && (
                <div className="text-[10px] text-red-400 font-mono">{timelineError}</div>
              )}
              {timelineStatus === 'idle' && (
                <div className="text-[10px] text-inkfaint font-mono flex items-start gap-1.5">
                  <Info className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>
                    Press play to pre-fetch all {timelineList.length} hours one at a time (real FortyGuard requests, sequential — not concurrent), then loop through them with zero live calls.
                    {' '}FortyGuard's Single Day query only returns one aggregate for the whole day, not a per-hour breakdown — so this genuinely needs one request per hour the first time.
                  </span>
                </div>
              )}

              <div className="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                <button
                  onClick={() => { setIsPlaying(false); setPlaybackHour(null); }}
                  className={`shrink-0 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer ${playbackHour == null ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'}`}
                >
                  {appliedQuery.filterType === 3 ? 'Full day' : 'Full range'}
                </button>
                {hourOptions.map((h) => {
                  const cached = isCached(city, queryForHour(h));
                  const isPending = pendingStep?.type === 'hour' && pendingStep.value === h;
                  return (
                    <button
                      key={h}
                      onClick={() => selectHour(h)}
                      disabled={isPending}
                      title={cached ? 'Already fetched this session' : 'Will fetch a live single-hour read'}
                      className={`shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-mono font-semibold cursor-pointer disabled:opacity-60 ${playbackHour === h ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'}`}
                    >
                      {isPending ? <RefreshCw className="w-2.5 h-2.5 animate-spin" /> : cached && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />}
                      {hourToHHMM(h)}
                    </button>
                  );
                })}
              </div>
              <p className="text-[9px] text-inkfaint font-mono">
                Click any hour for a single live read of it (● = already cached). Auto-play uses a pre-fetched sequence instead.
              </p>
            </Section>
          )}

          {/* ---- RANGE OF DAYS: no scrubbing/auto-play — FortyGuard's
              filter_type 4 only returns one aggregate for the WHOLE
              range, so there's nothing meaningful to step through frame
              by frame. Instead: pick one specific date + time inside the
              range and view that single hour directly. Same
              explicit-request pattern as Time Compare — editing the
              fields below never fetches on its own. ---- */}
          {appliedQuery.filterType === 4 && (
            <Section icon={Clock} title="View a Specific Date & Time" badge={rangeDrillApplied ? 'drilled in' : null}>
              <p className="text-[10px] text-inkfaint font-mono flex items-start gap-1.5">
                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                The range aggregate above covers all of {appliedQuery.date} → {appliedQuery.endDate}. Pick one exact date + hour inside it to see that hour's own heatmap (a separate, single-hour request).
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                <div>
                  <span className="text-[9px] text-inkfaint font-mono">Date</span>
                  <input
                    type="date"
                    value={rangeDrillDate || appliedQuery.date}
                    min={appliedQuery.date}
                    max={appliedQuery.endDate}
                    onChange={(e) => setRangeDrillDate(e.target.value)}
                    className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1 text-[11px] text-ink"
                  />
                </div>
                <div>
                  <span className="text-[9px] text-inkfaint font-mono">Time</span>
                  <input
                    type="time"
                    value={rangeDrillTime}
                    onChange={(e) => setRangeDrillTime(e.target.value)}
                    className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1 text-[11px] text-ink"
                  />
                </div>
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={() => setRangeDrillApplied(null)}
                  disabled={!rangeDrillApplied}
                  className={`flex-1 py-2 rounded-xl text-[11px] font-semibold cursor-pointer disabled:opacity-40 ${!rangeDrillApplied ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'}`}
                >
                  Full Range Aggregate
                </button>
                <button
                  onClick={viewRangeDrill}
                  disabled={pendingStep?.type === 'rangeDrill' || !rangeDrillIsDirty}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[11px] font-bold cursor-pointer disabled:opacity-50 ${
                    rangeDrillIsDirty ? 'bg-orange-500 hover:bg-orange-400 text-zinc-950' : 'bg-surface2 text-inkfaint'
                  }`}
                >
                  {pendingStep?.type === 'rangeDrill' ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                  {pendingStep?.type === 'rangeDrill' ? 'Fetching…' : rangeDrillIsDirty ? 'View This Hour' : 'Currently Shown'}
                </button>
              </div>
            </Section>
          )}

          {/* ---- DISPLAY SETTINGS (instant, client-side, no refetch) ---- */}
          <Section icon={Palette} title="Display" badge={`${classCount} classes · ${scheme}`}>

            {/* What the map/tile drawer is actually SHOWING among data
                that's already been fetched — not a Query change, no
                Apply, no live request. Reuses factorPreview (already
                wired into displayQuery above) for Exceedance/Persistence;
                selecting "Temperature" just clears that preview to fall
                back to the plain appliedQuery. Only meaningful once
                riskBoost has actually completed at least once for this
                city+date (see the checkbox in Query) — before that,
                Exceedance/Persistence were never fetched at all, so
                there's genuinely nothing to switch to yet, and the
                buttons say so instead of pretending otherwise. */}
            <div>
              <div className="text-[10px] text-inkfaint font-mono mb-1.5 flex items-center gap-1">
                <Gauge className="w-3 h-3" /> Now Showing (already-fetched data)
              </div>
              <div className="flex gap-1.5">
                {[
                  { key: null, label: 'Temperature', analyticType: 'tcm' },
                  { key: 'exceedance', label: 'Exceedance', analyticType: 'exceedance' },
                  { key: 'persistence', label: 'Persistence', analyticType: 'persistence' },
                ].map((opt) => {
                  const previewQuery = opt.key
                    ? { ...appliedQuery, analyticType: opt.analyticType, filterType: 3, time: undefined, endTime: undefined, endDate: undefined, granularity: 100 }
                    : appliedQuery;
                  const available = opt.key === null || isCached(city, previewQuery);
                  const isActive = factorPreview === opt.key;
                  return (
                    <button
                      key={opt.label}
                      onClick={() => setFactorPreview(opt.key)}
                      disabled={!available}
                      title={available ? undefined : `Not fetched yet — check "Also fetch Exceedance & Persistence" in Query, then Apply`}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                        isActive ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              {factorPreview && (
                <p className="text-[9px] text-inkfaint font-mono mt-1">
                  Showing the already-fetched full-day {factorPreview} result for {appliedQuery.date} — map, stats, and tile details all reflect it. Not a live request.
                </p>
              )}
            </div>

            {/* Moved here from Query — this reflects the Exceedance/
                Persistence background fetches riskBoost triggers, not a
                query setting itself (it never changes what the map
                shows). Each factor's own progress is tracked separately
                so it's clear which of the two is still in flight, not
                just a single generic "fetching" blob for both. */}
            {riskBoost && Object.keys(riskBoostStatus).length > 0 && (
              <div className="p-2.5 rounded-xl bg-app/60 border border-border space-y-1.5">
                <div className="text-[10px] text-inkfaint font-mono uppercase flex items-center gap-1.5">
                  <Gauge className="w-3 h-3" /> Risk Score Factors
                </div>
                {Object.entries(riskBoostStatus).map(([analyticType, status]) => {
                  const label = analyticType === 'exceedance' ? 'Exceedance' : 'Persistence';
                  const isDone = status === 'done';
                  const isFetching = status === 'fetching';
                  return (
                    <div key={analyticType} className="flex items-center gap-1.5 text-[11px]">
                      {isFetching && <RefreshCw className="w-3 h-3 animate-spin text-inkfaint shrink-0" />}
                      {isDone && <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />}
                      {!isFetching && !isDone && <AlertTriangle className="w-3 h-3 text-red-400 shrink-0" />}
                      <span className={isDone ? 'text-inksoft' : isFetching ? 'text-inkfaint' : 'text-red-400'}>
                        {label}{isFetching && ' — fetching…'}{isDone && ' — done'}{!isFetching && !isDone && ` — ${status}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {activeMode.unit === 'temp' && (
              <div className="flex gap-1.5">
                {['F', 'C'].map((u) => (
                  <button key={u} onClick={() => setUnit(u)}
                    className={`flex-1 py-1 rounded-lg text-xs font-semibold cursor-pointer ${unit === u ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft'}`}>
                    °{u}
                  </button>
                ))}
              </div>
            )}

            <div>
              <div className="text-[10px] text-inkfaint font-mono mb-1.5">Classification</div>
              <div className="flex gap-1.5">
                {[{ k: 'equal', l: 'Equal Interval' }, { k: 'quantile', l: 'Quantile' }].map((c) => (
                  <button key={c.k} onClick={() => setClassification(c.k)}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer ${classification === c.k ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40' : 'bg-surface2 text-inksoft border border-transparent'}`}>
                    {c.l}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-[10px] text-inkfaint font-mono">Classes: {classCount}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setClassCount((n) => Math.max(3, n - 1))} className="w-6 h-6 rounded bg-surface2 hover:bg-surface3 text-ink text-xs cursor-pointer">−</button>
                <button onClick={() => setClassCount((n) => Math.min(16, n + 1))} className="w-6 h-6 rounded bg-surface2 hover:bg-surface3 text-ink text-xs cursor-pointer">+</button>
              </div>
            </div>

            <div>
              <div className="text-[10px] text-inkfaint font-mono mb-1.5">Color Scheme</div>
              <div className="flex gap-1.5">
                {Object.entries(COLOR_SCHEMES).map(([key, s]) => (
                  <button key={key} onClick={() => setScheme(key)}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer border ${scheme === key ? 'border-orange-500/50 bg-surface2' : 'border-border bg-surface/60'}`}>
                    <div className="h-2 rounded-full mb-1 overflow-hidden flex">
                      {s.stops.map((c, i) => <span key={i} className="flex-1" style={{ backgroundColor: `rgb(${c.join(',')})` }} />)}
                    </div>
                    <span className="text-inksoft">{s.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Legend — real numeric ranges from the loaded data */}
            <div className="space-y-1 pt-1">
              {Array.from({ length: classCount }).map((_, i) => {
                const t = classCount > 1 ? i / (classCount - 1) : 0.5;
                return (
                  <div key={i} className="flex items-center gap-2 text-[10px] font-mono text-inksoft">
                    <span className="w-4 h-4 rounded shrink-0" style={{ backgroundColor: colorAtPosition(scheme, t) }} />
                    <span>{formatBucketValue(breaks[i])} – {formatBucketValue(breaks[i + 1])}</span>
                  </div>
                );
              })}
            </div>

            <div className="pt-2 space-y-2 border-t border-border">
              <label className="flex items-center justify-between text-xs text-inksoft cursor-pointer">
                Heatmap fill
                <input type="checkbox" checked={showFill} onChange={(e) => setShowFill(e.target.checked)} className="cursor-pointer" />
              </label>
              <label className="flex items-center justify-between text-xs text-inksoft cursor-pointer">
                Tile borders
                <input type="checkbox" checked={showBorders} onChange={(e) => setShowBorders(e.target.checked)} className="cursor-pointer" />
              </label>
              <div>
                <div className="flex justify-between text-[10px] text-inkfaint font-mono mb-1">
                  <span>Opacity</span><span>{Math.round(opacity * 100)}%</span>
                </div>
                <input type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full cursor-pointer" />
              </div>
            </div>

            {/* Phase 6 — exposure points layer, independent of the heat
                query above (its own cache, its own fetch, ~1.5km fixed AOI
                around the city rather than whatever bbox the heatmap used). */}
            <div className="pt-2 space-y-2 border-t border-border">
              <label className="flex items-center justify-between text-xs text-inksoft cursor-pointer">
                <span className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Exposure points (OSM)</span>
                <input type="checkbox" checked={showExposure} onChange={(e) => setShowExposure(e.target.checked)} className="cursor-pointer" />
              </label>
              {showExposure && (
                <p className="text-[10px] text-inkfaint font-mono">
                  {exposureLoading
                    ? 'Fetching from OpenStreetMap…'
                    : `${exposurePoints.filter((p) => p.type === 'school').length} schools · ${exposurePoints.filter((p) => p.type === 'hospital').length} hospitals/clinics${exposureDensity ? ` · ${formatNumber(exposureDensity.building_count, 0)} buildings nearby` : ''}`}
                </p>
              )}
            </div>
          </Section>
        </div>
      )}

      <div className="flex-1 relative flex items-center justify-center p-4 min-w-0 min-h-0">
        {loading && !heatmap && (
          <div className="text-inkmuted text-sm font-mono flex flex-col items-center gap-2 text-center max-w-sm px-4">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>Fetching live heatmap from FortyGuard{elapsedSeconds != null ? ` — ${elapsedSeconds}s` : '…'}</span>
            {elapsedSeconds != null && elapsedSeconds > 20 && (
              <span className="text-[11px] text-inkfaint">
                Still processing — this isn't frozen, FortyGuard is genuinely still working (wide date ranges and fine granularity take longer). It'll appear the moment it's ready.
              </span>
            )}
          </div>
        )}
        {error && (
          <div className="max-w-md text-center text-red-400 text-xs font-mono flex flex-col items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            <span>Live fetch failed: {error}</span>
            <button onClick={refresh} className="px-3 py-1.5 rounded-lg bg-surface2 text-ink text-xs cursor-pointer">Retry</button>
          </div>
        )}
        {heatmap && !error && (heatmap.map_data?.features?.length ?? 0) === 0 && (
          <div className="max-w-md text-center text-inkmuted text-xs font-mono flex flex-col items-center gap-2 px-4">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span className="text-ink font-semibold">FortyGuard completed this request but returned zero tiles.</span>
            <span>This usually means the area is smaller than one tile at the current granularity, or there's no coverage for this exact date/time. Try a coarser granularity, a larger area, or a different date.</span>
            <button onClick={refresh} className="px-3 py-1.5 rounded-lg bg-surface2 text-ink text-xs cursor-pointer mt-1">Retry</button>
          </div>
        )}
        {heatmap && !error && (heatmap.map_data?.features?.length ?? 0) > 0 && (
          <div className="w-full h-full relative isolate">
            <LeafletHeatmapMap
              ref={mapRef}
              mapData={heatmap.map_data}
              valueKey={tileValueKey}
              city={city}
              breaks={breaks}
              scheme={scheme}
              opacity={opacity}
              showFill={showFill}
              showBorders={showBorders}
              onSelectTile={setSelectedTile}
              onBackgroundClick={() => setSelectedTile(null)}
              selectedTileId={selectedTile?.tile_id}
              exposurePoints={exposurePoints}
              showExposure={showExposure}
            />

            {/* Real on-map controls — quick display adjustments without
                opening the full sidebar, plus a recenter button. Leaflet's
                own zoom control (top-left) and scale bar (bottom-left) are
                added directly by LeafletHeatmapMap. */}
            <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2 items-end">
              <button
                onClick={() => mapRef.current?.recenter()}
                className="p-2 rounded-xl bg-surface/90 backdrop-blur border border-border shadow-lg text-inksoft hover:text-ink hover:bg-surface2 cursor-pointer"
                title="Recenter on data"
                aria-label="Recenter map"
              >
                <Crosshair className="w-4 h-4" />
              </button>
              <div className="p-2.5 rounded-xl bg-surface/90 backdrop-blur border border-border shadow-lg w-40 space-y-2">
                <label className="flex items-center justify-between text-[10px] text-inksoft cursor-pointer">
                  Fill
                  <input type="checkbox" checked={showFill} onChange={(e) => setShowFill(e.target.checked)} className="cursor-pointer" />
                </label>
                <label className="flex items-center justify-between text-[10px] text-inksoft cursor-pointer">
                  Borders
                  <input type="checkbox" checked={showBorders} onChange={(e) => setShowBorders(e.target.checked)} className="cursor-pointer" />
                </label>
                <div>
                  <div className="flex justify-between text-[9px] text-inkfaint font-mono mb-0.5">
                    <span>Opacity</span><span>{Math.round(opacity * 100)}%</span>
                  </div>
                  <input type="range" min="0.1" max="1" step="0.05" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full cursor-pointer" />
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 z-[1000]">
          {!showControls && (
            <button onClick={() => setShowControls(true)} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-surface2 text-inksoft cursor-pointer shadow-lg">
              <Flame className="w-3.5 h-3.5" /> Controls
            </button>
          )}
          {selectedTile && !showDrawer && (
            <button onClick={() => setShowDrawer(true)} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 bg-orange-500 text-zinc-950 cursor-pointer shadow-lg">
              Tile Details
            </button>
          )}
        </div>
      </div>

      {showDrawer && selectedTile && (
        <div className="fixed top-16 bottom-0 right-0 z-40 w-full sm:w-96 lg:static lg:top-auto lg:bottom-auto lg:w-96 bg-surface/95 lg:bg-surface border-l border-border p-5 flex flex-col shrink-0 overflow-y-auto shadow-2xl">
          <div className="space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-inkmuted">Tile #{selectedTile.tile_id}</span>
              <button
                onClick={() => setSelectedTile(null)}
                className="p-1.5 text-inkmuted hover:text-ink rounded-lg hover:bg-surface2 cursor-pointer"
                aria-label="Close tile details"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Phase 8 — compact glance at the city's Heat Risk Score
                (not this specific tile's — the score is city+date level,
                same as Dashboard). Arrow hands off to the full itemized
                breakdown on Dashboard rather than repeating it here. */}
            <TileRiskBadge
              cityId={city.id}
              date={displayQuery.date}
              refreshToken={riskFactorsVersion}
              onViewFull={() => onNavigateTab('dashboard')}
            />
            <div className={`grid ${activeMode.unit === 'temp' ? 'grid-cols-2' : 'grid-cols-1'} gap-2.5`}>
              <div className="p-3 bg-app/70 rounded-xl border border-border">
                <div className="text-[11px] text-inkmuted font-mono">Average</div>
                <div className="text-xl font-black text-ink mt-0.5">{formatBucketValue(selectedTile[tileValueKey])}</div>
              </div>
              {activeMode.unit === 'temp' && (
                <div className="p-3 bg-app/70 rounded-xl border border-border">
                  <div className="text-[11px] text-inkmuted font-mono">Min / Max</div>
                  <div className="text-sm font-bold text-ink mt-0.5">{formatBucketValue(selectedTile.min_temperature)} / {formatBucketValue(selectedTile.max_temperature)}</div>
                </div>
              )}
            </div>
            <p className="text-[11px] text-inkfaint font-mono">Raw tile data from FortyGuard's live Heatmap Generation endpoint — nothing computed or invented client-side.</p>

            <TileInsights
              key={selectedTile.tile_id}
              latitude={selectedTile.centroid_lat}
              longitude={selectedTile.centroid_lng}
              temperature={activeMode.unit === 'temp' ? selectedTile.average_temperature : undefined}
              date={displayQuery.date}
              time={displayQuery.time}
            />

            <div className="pt-4 space-y-2 border-t border-border">
              <button onClick={() => onNavigateTab('heatstory')} className="w-full py-2.5 bg-surface2 hover:bg-surface3 border border-borderstrong text-orange-300 font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer">
                <BookOpen className="w-4 h-4" /> View Heat Story
              </button>
              <button onClick={() => onNavigateTab('emergency')} className="w-full py-2.5 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer">
                <ShieldAlert className="w-4 h-4" /> Emergency Mode
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};