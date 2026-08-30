import React, { useEffect, useState } from 'react';
import {
  Scale, RefreshCw, AlertTriangle, ArrowRight, TrendingUp, TrendingDown, Send, Clock,
  Sparkles, Loader2, HelpCircle, BarChart3, HeartPulse, Thermometer,
} from 'lucide-react';
import { useLiveCityDataIfRequested, DEFAULT_QUERY } from '../hooks/useLiveCityData';
import { LeafletHeatmapMap } from './heatmap/LeafletHeatmapMap';
import { buildBreaks } from '../lib/heatmapColors';
import { formatNumber, formatAnalyticValue, cToF } from '../lib/thermalFormat';
import { FILTER_TYPES, ANALYTIC_MODES, THRESHOLD_MODES, describeWindow, todayISO, addDaysISO } from '../lib/queryWindow';
import { getRequestedValue, setRequestedValue } from '../lib/requestedGateStore';
import { postTimeComparison } from '../api/thermoraApi';
import { GroupedBarChart } from './charts/MiniBarChart';

// Groq's explanation sections, in display order — mirrors
// groq_client.py's TIME_COMPARISON_SYSTEM_PROMPT required fields exactly
// (the_difference/why_it_differs/what_else_it_shows/why_it_matters).
// `summary` is rendered separately, as the card's headline, not in this list.
const EXPLANATION_SECTIONS = [
  { key: 'the_difference', label: 'The difference', icon: Scale },
  { key: 'why_it_differs', label: 'Why it likely differs', icon: HelpCircle },
  { key: 'what_else_it_shows', label: 'What else the numbers show', icon: BarChart3 },
  { key: 'why_it_matters', label: 'Why it matters', icon: HeartPulse },
];

// Turns a fetched window's raw stats into exactly the generic shape
// POST /api/cities/{id}/time-comparison expects (see groq_client.py's
// generalized generate_time_comparison/_format_window_line) — a metric
// name/unit plus whatever named statistics are actually available for
// it. For temperature, that's Fahrenheit mean/max/min/std_dev (std_dev
// is a spread, not an absolute reading, so it only needs the ×9/5 scale
// factor, never the +32 offset cToF() applies to actual temperatures).
// For exceedance/persistence/time_of_measure, `stats` has already been
// normalized by extractStats() below into the same {mean, maximum,
// minimum} shape, in that metric's own native unit (hours, or UTC
// hour-of-day) — no Celsius-to-Fahrenheit conversion applies to those at
// all, since they were never a temperature to begin with.
function toComparisonWindow(label, activeMode, stats, threshold, direction) {
  if (activeMode.unit === 'temp') {
    return {
      label,
      metric_name: 'Temperature',
      metric_unit: '\u00b0F',
      values: {
        mean: stats?.mean != null ? cToF(stats.mean) : null,
        max: stats?.maximum != null ? cToF(stats.maximum) : null,
        min: stats?.minimum != null ? cToF(stats.minimum) : null,
        std_dev: stats?.standard_deviation != null ? stats.standard_deviation * (9 / 5) : null,
      },
    };
  }
  const metricName = activeMode.key === 'exceedance'
    ? `Exceedance Hours (> ${threshold}\u00b0C, ${direction})`
    : activeMode.key === 'persistence'
      ? `Longest Continuous Run (> ${threshold}\u00b0C, ${direction})`
      : 'Diurnal Peak Hour';
  return {
    label,
    metric_name: metricName,
    metric_unit: activeMode.unit === 'hour' ? 'UTC hour' : 'hours',
    values: {
      mean: stats?.mean ?? null,
      max: stats?.maximum ?? null,
      min: stats?.minimum ?? null,
    },
  };
}

// Normalizes a fetched heatmap result into ONE consistent {mean, maximum,
// minimum, standard_deviation} shape regardless of analytic type, so
// every downstream consumer (MiniMap's stat boxes, the delta banner, the
// bar chart, toComparisonWindow above) can stay analytic-type-agnostic
// instead of each re-implementing this same branch. tcm nests its
// aggregate under stats_data.temperature_stats; exceedance/persistence/
// time_of_measure report a FLAT stats_data shape instead (mean/min/max
// sit directly on it, no standard_deviation at all) — see
// location_features.py's own documented note on this exact difference,
// confirmed against a real FortyGuard response.
function extractStats(activeMode, heatmapResult) {
  if (!heatmapResult) return null;
  if (activeMode.unit === 'temp') return heatmapResult.stats_data?.temperature_stats || null;
  const flat = heatmapResult.stats_data;
  if (!flat || flat.mean == null) return null;
  return { mean: flat.mean, maximum: flat.max ?? null, minimum: flat.min ?? null, standard_deviation: null };
}

const SCHEME = 'spectral';

function WindowForm({ label, draft, onChange, requested, onRequest, loading }) {
  const filterTypeConfig = FILTER_TYPES.find((f) => f.value === draft.filterType) || FILTER_TYPES[2];
  const isDirty = JSON.stringify(draft) !== JSON.stringify(requested);

  return (
    <div className="p-4 rounded-2xl bg-app/60 border border-border space-y-3">
      <div className="text-[10px] font-mono font-bold text-inkmuted uppercase">{label}</div>
      <select
        value={draft.filterType}
        onChange={(e) => onChange({ ...draft, filterType: Number(e.target.value) })}
        className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink cursor-pointer"
      >
        {FILTER_TYPES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <span className="text-[9px] text-inkfaint font-mono">Date</span>
          <input type="date" value={draft.date} onChange={(e) => onChange({ ...draft, date: e.target.value })}
            className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink" />
        </div>
        {filterTypeConfig.needs.includes('endDate') && (
          <div>
            <span className="text-[9px] text-inkfaint font-mono">End Date</span>
            <input type="date" value={draft.endDate || ''} onChange={(e) => onChange({ ...draft, endDate: e.target.value })}
              className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink" />
          </div>
        )}
        {filterTypeConfig.needs.includes('time') && (
          <div>
            <span className="text-[9px] text-inkfaint font-mono">Start Time</span>
            <input type="time" value={draft.time || '14:00'} onChange={(e) => onChange({ ...draft, time: e.target.value })}
              className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink" />
          </div>
        )}
        {filterTypeConfig.needs.includes('endTime') && (
          <div>
            <span className="text-[9px] text-inkfaint font-mono">End Time</span>
            <input type="time" value={draft.endTime || '18:00'} onChange={(e) => onChange({ ...draft, endTime: e.target.value })}
              className="w-full bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink" />
          </div>
        )}
      </div>

      {/* Explicit request button — nothing here fetches on its own.
          Editing dates/times above only updates the draft; FortyGuard is
          only called once you click this. */}
      <button
        onClick={onRequest}
        disabled={loading || !isDirty}
        className={`w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
          !isDirty ? 'bg-surface2 text-inkfaint cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-400 text-zinc-950'
        }`}
      >
        {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
        {loading ? 'Requesting…' : isDirty ? 'Request Data' : 'Up to date'}
      </button>
    </div>
  );
}

function MiniMap({ title, city, entry, loading, error, requested, activeMode }) {
  const isTemp = activeMode.unit === 'temp';
  const stats = extractStats(activeMode, entry);
  const tileValueKey = isTemp ? 'average_temperature' : 'value';
  const tileValues = (entry?.map_data?.features || []).map((f) => f.properties[tileValueKey]).filter((v) => v != null);
  const breaks = React.useMemo(
    () => buildBreaks(tileValues, stats?.minimum ?? 0, stats?.maximum ?? 1, 8, 'equal'),
    [tileValues, stats]
  );

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2">
      <div className="text-xs font-bold text-inksoft">{title}</div>
      <div className="h-80 sm:h-[28rem] rounded-2xl overflow-hidden border border-border relative bg-app/40">
        {!requested && !entry && (
          <div className="absolute inset-0 flex items-center justify-center text-inkfaint text-xs font-mono gap-2 px-4 text-center">
            <Clock className="w-4 h-4" /> Set a window and click "Request Data"
          </div>
        )}
        {loading && requested && !entry && (
          <div className="absolute inset-0 flex items-center justify-center text-inkmuted text-xs font-mono gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Fetching…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center text-red-400 text-xs font-mono gap-2 px-4 text-center">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        {entry && !error && (
          <LeafletHeatmapMap
            mapData={entry.map_data}
            city={city}
            breaks={breaks}
            scheme={SCHEME}
            opacity={0.8}
            showFill
            showBorders={false}
            interactive={false}
          />
        )}
      </div>
      {stats && (
        <div className="grid grid-cols-3 gap-1.5 text-center">
          <div className="p-1.5 bg-app/60 rounded-lg border border-border">
            <div className="text-[9px] text-inkfaint font-mono">MEAN</div>
            <div className="text-sm font-black text-ink">{formatAnalyticValue(activeMode.unit, stats.mean)}</div>
          </div>
          <div className="p-1.5 bg-app/60 rounded-lg border border-border">
            <div className="text-[9px] text-inkfaint font-mono">MAX</div>
            <div className="text-sm font-black text-orange-400">{formatAnalyticValue(activeMode.unit, stats.maximum)}</div>
          </div>
          {isTemp ? (
            <div className="p-1.5 bg-app/60 rounded-lg border border-border">
              <div className="text-[9px] text-inkfaint font-mono">STD DEV</div>
              <div className="text-sm font-black text-inksoft">{formatNumber(stats.standard_deviation, 2)}</div>
            </div>
          ) : (
            <div className="p-1.5 bg-app/60 rounded-lg border border-border">
              <div className="text-[9px] text-inkfaint font-mono">MIN</div>
              <div className="text-sm font-black text-inksoft">{formatAnalyticValue(activeMode.unit, stats.minimum)}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// A dedicated tab — same city/AOI, two independently-configured FortyGuard
// windows (e.g. "today vs. a week ago"), each with its OWN explicit
// "Request Data" button. Nothing fetches just from changing a date field,
// AND nothing fetches just from opening this tab either — useLiveCityData
// is only called once requestedA/requestedB is actually set by a click.
//
// (Previously this called useLiveCityData(city, requestedA || draftA) —
// falling back to draftA when nothing had been requested yet — which
// fired two real FortyGuard requests the instant this tab mounted, before
// the user had touched anything. The comment above it claimed otherwise;
// it wasn't true. Fixed by only mounting useLiveCityData once a request
// exists, via a small wrapper that returns an idle/unfetched shape until
// then.)
//
// requestedA/requestedB now live in requestedGateStore (module scope),
// keyed per city, not local useState — App.jsx renders tabs
// conditionally, so switching away from Time Compare and back fully
// unmounts/remounts this component. A plain useState(null) would forget
// which window was actually requested and silently revert both panes to
// their idle "nothing loaded" state even after the user had already
// pulled real data — the underlying result would still be sitting in
// liveDataStore's cache, just no longer visibly connected to anything.
export const TimeCompareView = ({ city, onOpenAIAgent }) => {
  // Bug fix — same as HeatMapView.jsx/useLiveCityData.js: todayISO() with
  // no `city` used the browser's local date instead of this city's, even
  // though `city` is a prop right here. For a city on the other side of a
  // date boundary from the browser, "today" and "today - 7 days" could
  // both silently name the wrong calendar date.
  const [draftA, setDraftA] = useState({ ...DEFAULT_QUERY, date: todayISO(city), filterType: 3 });
  const [draftB, setDraftB] = useState({ ...DEFAULT_QUERY, date: addDaysISO(todayISO(city), -7), filterType: 3 });

  // Shared across BOTH windows, deliberately not per-window state —
  // comparing Window A's exceedance hours against Window B's temperature
  // wouldn't mean anything, so there is only ever ONE analytic-type
  // control here, not two that could independently disagree. Switching
  // it clears any already-requested windows below (see setAnalyticType)
  // so a stale fetch made under the OLD metric can never be shown or
  // compared against the new one.
  const [analyticType, setAnalyticTypeState] = useState('tcm');
  const [threshold, setThreshold] = useState(30);
  const [direction, setDirection] = useState('above');
  const activeMode = ANALYTIC_MODES.find((m) => m.key === analyticType) || ANALYTIC_MODES[0];
  const needsThreshold = THRESHOLD_MODES.has(analyticType);

  // Keeps draftA/draftB's own analyticType/threshold/direction fields in
  // sync with the shared selector above, so WindowForm's own isDirty
  // check (comparing draft against requested) stays meaningful — without
  // this, draft would always carry the ORIGINAL 'tcm'/30/'above' from
  // DEFAULT_QUERY's initializer regardless of what the shared selector
  // now says, so submitting a request under e.g. Exceedance would still
  // show "unrequested changes" forever after (draft's stale tcm !==
  // requested's actual exceedance), even though nothing new needed
  // fetching.
  useEffect(() => {
    setDraftA((d) => ({ ...d, analyticType, threshold, direction }));
    setDraftB((d) => ({ ...d, analyticType, threshold, direction }));
  }, [analyticType, threshold, direction]);

  const keyA = `timecompareA:${city.id}`;
  const keyB = `timecompareB:${city.id}`;
  // The "requested" query is only updated when the user clicks Request.
  const [requestedA, setRequestedAState] = useState(() => getRequestedValue(keyA));
  const [requestedB, setRequestedBState] = useState(() => getRequestedValue(keyB));
  // Explanation state is reset (not just left stale) any time a window is
  // re-requested — see setRequestedA/setRequestedB below — since a Groq
  // explanation is only ever generated FROM the currently-loaded stats
  // (see generateExplanation) and a leftover explanation for a since-
  // replaced window would silently misdescribe whatever's on screen now.
  const [explanation, setExplanation] = useState(null);
  const [explanationLoading, setExplanationLoading] = useState(false);
  const [explanationError, setExplanationError] = useState(null);

  const resetExplanation = () => {
    setExplanation(null);
    setExplanationError(null);
  };
  const setRequestedA = (query) => { setRequestedValue(keyA, query); setRequestedAState(query); resetExplanation(); };
  const setRequestedB = (query) => { setRequestedValue(keyB, query); setRequestedBState(query); resetExplanation(); };

  // Changing the metric invalidates whatever was already fetched under
  // the PREVIOUS one — there's no meaningful way to keep showing (or
  // comparing) a Temperature result once the control now says
  // Exceedance. Clearing both forces a fresh, explicit "Request Data" for
  // each window under the newly-selected metric, same off-by-default
  // rule as every other fetch here.
  const setAnalyticType = (nextType) => {
    setAnalyticTypeState(nextType);
    setRequestedA(null);
    setRequestedB(null);
  };

  const a = useLiveCityDataIfRequested(city, requestedA);
  const b = useLiveCityDataIfRequested(city, requestedB);

  const statsA = requestedA ? extractStats(activeMode, a.heatmap) : null;
  const statsB = requestedB ? extractStats(activeMode, b.heatmap) : null;
  const meanDelta = statsA && statsB ? statsA.mean - statsB.mean : null;
  const maxDelta = statsA && statsB ? statsA.maximum - statsB.maximum : null;
  const pctDelta = statsA && statsB && statsB.mean !== 0 ? (meanDelta / Math.abs(statsB.mean)) * 100 : null;
  // Fahrenheit display for the delta banner below — a DIFFERENCE only
  // ever needs the ×9/5 scale factor to convert, never formatTemp's +32
  // offset (that's for absolute readings). This used to call
  // formatTemp(meanDelta, 'F', 1) directly on a raw Celsius delta, which
  // silently added 32 to a plain difference — e.g. a real +2°C/+3.6°F
  // gap displayed as a nonsensical "+35.6°F". std_dev elsewhere in this
  // file already correctly used ×9/5 alone; this brings the delta
  // banner in line with that same, correct logic, and applies no
  // conversion at all for non-temperature metrics, which were never
  // Celsius to begin with.
  const deltaUnit = activeMode.unit === 'temp' ? '\u00b0F' : (activeMode.unit === 'hour' ? 'h' : ' hrs');
  const displayMeanDelta = activeMode.unit === 'temp' ? meanDelta * (9 / 5) : meanDelta;
  const displayMaxDelta = activeMode.unit === 'temp' ? maxDelta * (9 / 5) : maxDelta;

  // Explicit action, same contract as Heat Story's "Generate Story" — it
  // costs a real Groq call, so it's defined once here and reused both by
  // the auto-fire effect below and the "Regenerate" button, rather than
  // two separate call sites that could drift out of sync.
  const generateExplanation = () => {
    if (!statsA || !statsB) return;
    setExplanationLoading(true);
    setExplanationError(null);
    postTimeComparison(
      city.id,
      toComparisonWindow(describeWindow(requestedA), activeMode, statsA, threshold, direction),
      toComparisonWindow(describeWindow(requestedB), activeMode, statsB, threshold, direction),
    )
      .then((r) => {
        if (r.story?.available) setExplanation(r.story);
        else setExplanationError(r.story?.reason || 'Explanation unavailable.');
      })
      .catch((err) => setExplanationError(err.message || String(err)))
      .finally(() => setExplanationLoading(false));
  };

  // Fires automatically the moment BOTH windows have real stats — no
  // click required. Guarded on !explanation/!explanationLoading/
  // !explanationError so it only ever fires ONCE per statsA/statsB pair:
  // resetExplanation() (called from setRequestedA/setRequestedB above)
  // clears all three whenever a window is re-requested, which is exactly
  // what lets this effect fire again for the next pair — it does not
  // re-fire on every render, and a failed attempt is not silently
  // retried forever (the "Regenerate" button remains for that).
  useEffect(() => {
    if (statsA && statsB && !explanation && !explanationLoading && !explanationError) {
      generateExplanation();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsA, statsB]);

  // Same "Ask AI" pattern as HeatStoryView/ResearchView/EmergencyModeView —
  // a plain button that hands the drawer a relevant starting question, not
  // a second AI surface of its own. The question is only as specific as
  // what's actually loaded right now, so it never implies data that
  // hasn't been fetched.
  const askPrompt = statsA && statsB
    ? `For ${city.name}, how does ${describeWindow(requestedA)} compare to ${describeWindow(requestedB)}, and what's the likely reason for the difference?`
    : requestedA || requestedB
      ? `What can you tell me about heat conditions in ${city.name} for ${describeWindow(requestedA || requestedB)}?`
      : `What can you tell me about comparing different time windows for ${city.name}'s heat?`;

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6 text-ink font-sans">
      <div className="flex items-center justify-between gap-2 pb-4 border-b border-border flex-wrap">
        <div className="flex items-center gap-2">
          <Scale className="w-5 h-5 text-orange-400" />
          <div>
            <h1 className="text-2xl font-bold text-ink tracking-tight">Time Compare</h1>
            <p className="text-xs text-inkmuted">{city.name}, {city.state} · same AOI, two independently-requested FortyGuard windows</p>
          </div>
        </div>
        {onOpenAIAgent && (
          <button
            onClick={() => onOpenAIAgent(askPrompt)}
            className="px-4 py-2 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shrink-0"
          >
            <Sparkles className="w-4 h-4 text-orange-400" />
            <span>Ask AI</span>
          </button>
        )}
      </div>

      {/* Shared analytic-type control — deliberately ONE selector for both
          windows, not two, so "same type both sides" is structural rather
          than something the user could get wrong. Switching it clears any
          already-requested windows (see setAnalyticType) so a comparison
          can never mix one metric on one side with a different metric on
          the other. */}
      <div className="p-4 rounded-2xl bg-app/60 border border-border space-y-3">
        <div className="text-[10px] font-mono font-bold text-inkmuted uppercase">Metric to compare (same for both windows)</div>
        <div className="flex flex-wrap gap-1.5">
          {ANALYTIC_MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setAnalyticType(m.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
                analyticType === m.key
                  ? 'bg-orange-500/20 text-orange-300 font-bold border-orange-500/40'
                  : 'bg-surface/60 text-inksoft hover:bg-surface2 border-border'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {needsThreshold && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <div className="flex items-center gap-2">
              <Thermometer className="w-3.5 h-3.5 text-inkfaint shrink-0" />
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="w-20 bg-surface/60 border border-border rounded-lg px-2 py-1.5 text-xs text-ink"
              />
              <span className="text-[10px] text-inkfaint font-mono">°C</span>
            </div>
            <div className="flex gap-1.5">
              {['above', 'below'].map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold capitalize cursor-pointer ${direction === d ? 'bg-orange-500 text-zinc-950' : 'bg-surface2 text-inksoft hover:bg-surface3'}`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <WindowForm
          label="Window A" draft={draftA} onChange={setDraftA}
          requested={requestedA} loading={requestedA ? a.loading : false}
          onRequest={() => setRequestedA({ ...draftA, analyticType, threshold, direction })}
        />
        <WindowForm
          label="Window B" draft={draftB} onChange={setDraftB}
          requested={requestedB} loading={requestedB ? b.loading : false}
          onRequest={() => setRequestedB({ ...draftB, analyticType, threshold, direction })}
        />
      </div>

      {meanDelta != null && (
        <div className="p-4 rounded-2xl bg-app/70 border border-border flex flex-wrap items-center gap-4 justify-center text-center">
          <div className="flex items-center gap-2">
            {displayMeanDelta >= 0 ? <TrendingUp className="w-5 h-5 text-orange-400" /> : <TrendingDown className="w-5 h-5 text-blue-400" />}
            <span className="text-2xl font-black text-ink">{displayMeanDelta >= 0 ? '+' : ''}{formatNumber(displayMeanDelta, 1)}{deltaUnit}</span>
            <span className="text-xs text-inkmuted">mean Δ</span>
          </div>
          {pctDelta != null && (
            <span className="text-xs font-mono text-inkfaint">({pctDelta >= 0 ? '+' : ''}{pctDelta.toFixed(1)}%)</span>
          )}
          <div className="h-6 w-px bg-border" />
          <span className="text-xs text-inkmuted">
            Peak Δ <span className="font-bold text-ink">{displayMaxDelta >= 0 ? '+' : ''}{formatNumber(displayMaxDelta, 1)}{deltaUnit}</span>
          </span>
          <div className="h-6 w-px bg-border hidden sm:block" />
          <span className="text-[11px] font-mono text-inkfaint flex items-center gap-1">
            {describeWindow(requestedA)} <ArrowRight className="w-3 h-3" /> {describeWindow(requestedB)}
          </span>
        </div>
      )}

      {/* Visual read of the same numbers already shown above/below — Mean,
          Max, Min side by side for each window, at a glance. */}
      {statsA && statsB && (
        <div className="p-5 rounded-2xl bg-surface/80 border border-border">
          <div className="text-[10px] font-mono text-inkfaint uppercase mb-3">
            Mean / Max / Min — Window A vs Window B ({activeMode.unit === 'temp' ? '\u00b0F' : activeMode.unit === 'hour' ? 'UTC hour' : 'hours'})
          </div>
          <GroupedBarChart
            seriesALabel="Window A" seriesBLabel="Window B" decimals={1}
            unit={activeMode.unit === 'temp' ? '\u00b0F' : activeMode.unit === 'hour' ? 'h' : ' hrs'}
            groups={activeMode.unit === 'temp' ? [
              { label: 'Mean', a: cToF(statsA.mean), b: cToF(statsB.mean) },
              { label: 'Max', a: cToF(statsA.maximum), b: cToF(statsB.maximum) },
              { label: 'Min', a: cToF(statsA.minimum), b: cToF(statsB.minimum) },
            ] : [
              { label: 'Mean', a: statsA.mean, b: statsB.mean },
              { label: 'Max', a: statsA.maximum, b: statsB.maximum },
              { label: 'Min', a: statsA.minimum, b: statsB.minimum },
            ]}
          />
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-4">
        <MiniMap title={requestedA ? describeWindow(requestedA) : 'Window A'} city={city} entry={requestedA ? a.heatmap : null} loading={a.loading} error={requestedA ? a.error : null} requested={!!requestedA} activeMode={activeMode} />
        <MiniMap title={requestedB ? describeWindow(requestedB) : 'Window B'} city={city} entry={requestedB ? b.heatmap : null} loading={b.loading} error={requestedB ? b.error : null} requested={!!requestedB} activeMode={activeMode} />
      </div>

      {/* AI explanation — fires automatically once both windows have real
          stats to compare (see the useEffect above); the button here is
          only for re-running it (a fresh take, or after a failure). */}
      {statsA && statsB && (
        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
          <div className="flex items-center justify-between pb-4 border-b border-border gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-orange-400" />
              <h3 className="text-base font-bold text-ink">Explain this comparison</h3>
            </div>
            <button
              onClick={generateExplanation}
              disabled={explanationLoading}
              className="px-3.5 py-2 rounded-xl bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 shrink-0"
            >
              {explanationLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              {explanationLoading ? 'Explaining…' : explanation ? 'Regenerate' : 'Retry'}
            </button>
          </div>

          {explanationLoading && !explanation && (
            <p className="text-xs text-inkmuted mt-4 flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Explaining the difference between {describeWindow(requestedA)} and {describeWindow(requestedB)}…
            </p>
          )}
          {explanationError && (
            <p className="text-xs text-red-400 font-mono mt-4 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {explanationError}
            </p>
          )}
          {explanation && (
            <div className="space-y-3 mt-5">
              <div className="p-4 rounded-2xl bg-orange-500/10 border border-orange-500/30">
                <p className="text-sm font-bold text-ink leading-relaxed">{explanation.summary}</p>
              </div>
              {EXPLANATION_SECTIONS.map(({ key, label, icon: Icon }) => (
                <div key={key} className="p-4 rounded-2xl bg-app/60 border border-border/80 flex items-start gap-3.5">
                  <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 border bg-orange-500/15 border-orange-500/30 text-orange-400">
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-ink">{label}</h4>
                    <p className="text-xs text-inksoft mt-1 leading-relaxed">{explanation[key]}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] text-inkfaint font-mono text-center">
        Each window is a separate, explicit FortyGuard request — nothing here fetches automatically. Color scales are independent per map; only the numeric delta above is directly comparable.
      </p>
    </div>
  );
};