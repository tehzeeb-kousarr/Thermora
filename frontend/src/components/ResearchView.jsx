import React, { useEffect, useRef, useState } from 'react';
import {
  BarChart3, Sparkles, Download, CheckCircle2, Loader2, AlertTriangle, RefreshCw,
  TrendingUp, TrendingDown, Flame, Gauge, Database, HeartPulse, School, Cross, Building2,
  CloudDownload, X,
} from 'lucide-react';
import { fetchResearchHistory, postResearchSummary, postResearchFillGaps, fetchHeatmapStatus } from '../api/thermoraApi';
import { formatNumber } from '../lib/thermalFormat';
import { todayISO, addDaysISO } from '../lib/queryWindow';
import { ChartHoverTip } from './charts/MiniBarChart';

const RANGES = [
  { key: '7d', label: 'Last 7 Days', days: 7 },
  { key: '14d', label: 'Last 14 Days', days: 14 },
  { key: '30d', label: 'Last 30 Days', days: 30 },
];

// Same polling cadence/ceiling as HeatStoryView's own job polling — this
// reuses the identical GET /api/heatmap/status Heat Map/Heat Story poll.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 60; // ~3 minutes per job, same ceiling as backend

// Mirrors routers/research.py's MAX_FILL_JOBS_PER_REQUEST — only used
// client-side to preview the batch size in the consent modal; the actual
// cap is always enforced backend-side regardless of what this says.
const MAX_FILL_JOBS_PER_REQUEST = 20;

async function pollJob(signature) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    const result = await fetchHeatmapStatus(signature);
    if (result.status === 'Completed' || result.status === 'Failed') return result;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: 'Failed', error: 'Timed out waiting for this hour to complete.' };
}

// Groq's research-summary sections, in display order — mirrors
// groq_client.py's RESEARCH_SUMMARY_SYSTEM_PROMPT required fields exactly.
// `summary` is rendered separately, as the card's headline.
const SUMMARY_SECTIONS = [
  { key: 'overall_trend', label: 'Overall trend', icon: TrendingUp },
  { key: 'exceedance_pattern', label: 'Exceedance & persistence pattern', icon: Flame },
  { key: 'data_coverage', label: 'Data coverage', icon: Database },
  { key: 'why_it_matters', label: 'Why it matters', icon: HeartPulse },
];

// Same consent-gate shape as HeatStoryView's own ConsentModal (Section
// 16: always show exactly how many real FortyGuard requests are about to
// go out before submitting) — grouped by day here since a Research
// backfill spans a whole range, not one date.
function FillGapsModal({ daysWithGaps, hourCount, batchCount, onCancel, onConfirm, confirming }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-3xl border border-border shadow-2xl max-w-sm w-full p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-ink">Fetch Missing Data</h3>
          <button onClick={onCancel} className="text-inkfaint hover:text-ink cursor-pointer shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-3 max-h-40 overflow-y-auto space-y-1 pr-1">
          {daysWithGaps.map((d) => (
            <div key={d.date} className="flex items-center justify-between text-[11px] font-mono px-2 py-1 rounded-lg bg-app/70 border border-border">
              <span className="text-inksoft">{d.date}</span>
              <span className="text-inkfaint">{d.missing_hours.length} hour(s)</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-inkmuted mt-4 leading-relaxed">
          This will make <strong className="text-ink">{batchCount}</strong> real FortyGuard
          request{batchCount === 1 ? '' : 's'} to fill in {hourCount > batchCount ? `the first ${batchCount} of ${hourCount}` : `all ${hourCount}`} missing
          hour(s) across {daysWithGaps.length} day(s) — so every day in this range ends up measured
          against the same hourly coverage. May take a few minutes; already-fetched hours are never
          re-requested.
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
            {confirming ? 'Fetching…' : `Fetch ${batchCount} Hour${batchCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function cToF(celsius) {
  return celsius == null ? null : (celsius * 9) / 5 + 32;
}

// A day's bar height, scaled against the hottest REAL day in range (never
// against an assumed fixed axis) — see the `maxOfRange` computation below.
// Days with no data render as a flat, clearly-labeled placeholder, never
// as a zero-height (which would misleadingly read as "measured near 0°F").
// A day whose value is built from PARTIAL hourly coverage (below the
// full 6am-8pm expected-hours window — see routers/research.py's
// _with_coverage) renders visibly lighter/hatched, so a thin 1-hour
// sample never LOOKS as trustworthy as a fully-measured day at a glance,
// not just on hover.
function DayBar({ day, maxOfRange, isHottest }) {
  const tempF = cToF(day.max_temp_c);
  const heightPct = tempF != null && maxOfRange ? Math.max(8, (tempF / maxOfRange) * 100) : null;
  const dateLabel = day.date.slice(5).replace('-', '/');
  const isPartial = day.has_data && day.coverage_percent != null && day.coverage_percent < 100;

  const tip = day.has_data ? (
    <>
      <div className="font-bold text-inksoft">{day.date}</div>
      <div>{tempF != null ? <>Max: <span className="text-ink font-semibold">{tempF.toFixed(1)}°F</span></> : 'Temp not available'}</div>
      {day.max_temp_source === 'hourly_max' && (
        <div className="text-inkfaint mt-0.5">Max across {day.hours_fetched} fetched hour(s)</div>
      )}
      {day.coverage_percent != null && (
        <div className={`mt-0.5 ${isPartial ? 'text-amber-300' : 'text-emerald-300'}`}>
          {isPartial && '⚠ '}{day.coverage_percent}% of expected hours on file
          {isPartial && ` (${day.missing_hours.length} missing)`}
        </div>
      )}
      {(day.exceedance_hours ?? 0) > 0 && (
        <div className="text-orange-300 mt-0.5">{day.exceedance_hours.toFixed(1)}h above threshold</div>
      )}
    </>
  ) : (
    <>
      <div className="font-bold text-inksoft">{day.date}</div>
      <div className="text-inkfaint">No data — never fetched</div>
    </>
  );

  return (
    <ChartHoverTip tip={tip} className="flex-1 flex flex-col items-center gap-1.5 h-full justify-end min-w-0">
      <>
        {day.has_data && tempF != null ? (
          <span className={`text-[10px] font-mono font-bold ${isPartial ? 'text-inkfaint' : 'text-inksoft'}`}>{tempF.toFixed(0)}°</span>
        ) : (
          <span className="text-[10px] font-mono text-inkfaint">—</span>
        )}
        {day.has_data && heightPct != null ? (
          <div
            className={`w-full max-w-[36px] rounded-t-lg transition-all group-hover/tip:brightness-110 ${
              isPartial
                ? 'opacity-45 [background-image:repeating-linear-gradient(135deg,theme(colors.orange.500/70)_0,theme(colors.orange.500/70)_3px,transparent_3px,transparent_6px)]'
                : isHottest ? 'bg-gradient-to-t from-orange-500 to-red-500' : 'bg-gradient-to-t from-surface2 to-orange-500/70'
            }`}
            style={{ height: `${heightPct}%` }}
          />
        ) : (
          <div className="w-full max-w-[36px] rounded-t-lg border-2 border-dashed border-border h-2" />
        )}
        {(day.exceedance_hours ?? 0) > 0 && (
          <div className="w-1.5 h-1.5 rounded-full bg-red-500/80" />
        )}
        <span className="text-[9px] font-mono text-inkmuted truncate">{dateLabel}</span>
      </>
    </ChartHoverTip>
  );
}

// A dedicated tab — real daily history straight from location_features
// (Phase 5), read-only against Postgres (see fetchResearchHistory), plus
// an optional Groq-written summary over the same range (see
// postResearchSummary). Nothing here is invented: a day nobody has ever
// fetched (via Heat Map, Heat Story, Dashboard, or this tab) shows up
// honestly as "no data", never as a plausible-looking placeholder number
// — see location_features.get_daily_history's own docstring for exactly
// how each field is sourced.
export const ResearchView = ({ city, onOpenAIAgent }) => {
  const [rangeKey, setRangeKey] = useState('7d');
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState(null);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  const [showFillModal, setShowFillModal] = useState(false);
  const [filling, setFilling] = useState(false);
  const [fillError, setFillError] = useState(null);

  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[0];
  const endDate = todayISO(city);
  const startDate = addDaysISO(endDate, -(range.days - 1));

  // Postgres-only read — same "safe to call the moment this opens or the
  // range changes" contract as HeatStoryView's own GET. No FortyGuard
  // request is ever made just from viewing this tab. Also re-called after
  // a "Fetch Missing Data" batch settles, to pick up the newly-written
  // rows — same pattern as HeatStoryView's own load().
  const loadHistory = () => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchResearchHistory(city.id, startDate, endDate)
      .then((r) => { if (!cancelled) setHistory(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  };

  useEffect(() => {
    setSummary(null);
    setSummaryError(null);
    setFillError(null);
    return loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.id, rangeKey]);

  const daily = history?.daily || [];
  const availableDays = daily.filter((d) => d.has_data);
  const daysWithTemp = availableDays.filter((d) => d.max_temp_c != null);
  const daysWithGaps = daily.filter((d) => (d.missing_hours?.length || 0) > 0);
  const totalMissingHours = history?.total_missing_hours ?? daysWithGaps.reduce((sum, d) => sum + d.missing_hours.length, 0);

  let hottest = null, coolest = null;
  for (const d of daysWithTemp) {
    if (!hottest || d.max_temp_c > hottest.max_temp_c) hottest = d;
    if (!coolest || d.max_temp_c < coolest.max_temp_c) coolest = d;
  }
  const maxOfRange = daysWithTemp.length ? Math.max(...daysWithTemp.map((d) => cToF(d.max_temp_c))) : null;
  const totalExceedance = availableDays.reduce((sum, d) => sum + (d.exceedance_hours || 0), 0);
  const daysAboveThreshold = availableDays.filter((d) => (d.exceedance_hours || 0) > 0).length;
  const exposure = history?.exposure_summary;

  // Consent-confirmed batch fetch — mirrors HeatStoryView's runFetch:
  // submit, poll every returned job to completion, then re-read Postgres.
  const confirmFillGaps = async () => {
    setFilling(true);
    setFillError(null);
    try {
      const { jobs, remaining_missing } = await postResearchFillGaps(city.id, startDate, endDate);
      const settled = await Promise.all(
        jobs.map(async (job) => {
          if (job.status === 'Completed') return job;
          return { ...job, ...(await pollJob(job.signature)) };
        })
      );
      const failed = settled.filter((j) => j.status === 'Failed');
      if (failed.length) {
        setFillError(`${failed.length} hour(s) failed: ${failed.map((f) => `${f.date} ${f.hour}`).join(', ')}`);
      } else if (remaining_missing > 0) {
        setFillError(`Filled this batch — ${remaining_missing} more missing hour(s) in this range. Click "Fetch Missing Data" again to continue.`);
      }
      loadHistory(); // re-read the range now that new rows exist
    } catch (err) {
      setFillError(err.message || String(err));
    } finally {
      setFilling(false);
      setShowFillModal(false);
    }
  };


  const generateSummary = () => {
    setSummaryLoading(true);
    setSummaryError(null);
    postResearchSummary(city.id, startDate, endDate)
      .then((r) => {
        if (r.summary?.available) setSummary(r.summary);
        else setSummaryError(r.summary?.reason || 'Summary unavailable.');
      })
      .catch((err) => setSummaryError(err.message || String(err)))
      .finally(() => setSummaryLoading(false));
  };

  // Auto-generate once the range actually has real data — same reasoning
  // as HeatStoryView's auto-generate: don't make the person remember to
  // click "Generate Summary" every time. Fires at most once per distinct
  // city+range+dates (availableDays.length > 0 is the same "is there
  // really something here" check the empty state below already uses),
  // and stays silent if the range genuinely has nothing yet — no summary
  // gets generated from zero real days.
  const autoSummaryFiredForRef = useRef(null);
  useEffect(() => {
    if (!history || summary || summaryLoading) return;
    if (!availableDays.length) return;
    const key = `${city.id}:${rangeKey}:${startDate}:${endDate}`;
    if (autoSummaryFiredForRef.current === key) return;
    autoSummaryFiredForRef.current = key;
    generateSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, summary, summaryLoading, city.id, rangeKey, startDate, endDate]);

  // Exports exactly what's on screen — the real daily record and exposure
  // profile this component just read from the backend — not a static
  // dump of the city's config object (which is what this used to export,
  // regardless of what range was even selected).
  const handleExportData = () => {
    if (!history) return;
    const payload = { city_id: city.id, city_name: city.name, ...history, research_summary: summary };
    const dataStr = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(payload, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', dataStr);
    a.setAttribute('download', `thermora_research_${city.id}_${startDate}_to_${endDate}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setDownloadSuccess(true);
    setTimeout(() => setDownloadSuccess(false), 3000);
  };

  const askPrompt = hottest
    ? `For ${city.name}, what does the heat record from ${startDate} to ${endDate} show — the hottest day was ${hottest.date}. What's notable about this period?`
    : `What can you tell me about ${city.name}'s recent heat history?`;

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6 text-ink font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center shrink-0">
            <BarChart3 className="w-4 h-4 text-orange-400" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-ink tracking-tight">Research: {city.name}</h2>
            <p className="text-xs text-inkmuted mt-0.5">
              Real daily record from Thermora's own stored data — never fetches FortyGuard just by opening this tab.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleExportData}
            disabled={!history}
            className="px-4 py-2 bg-surface hover:bg-surface2 border border-border text-ink rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
          >
            {downloadSuccess ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Download className="w-4 h-4 text-inkmuted" />}
            <span>{downloadSuccess ? 'Dataset Exported' : 'Export Dataset (.JSON)'}</span>
          </button>
          {onOpenAIAgent && (
            <button
              onClick={() => onOpenAIAgent(askPrompt)}
              className="px-4 py-2 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer"
            >
              <Sparkles className="w-4 h-4 text-orange-400" />
              <span>Ask AI</span>
            </button>
          )}
        </div>
      </div>

      <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-ink">Daily Max Temperature Record</h3>
            <p className="text-xs text-inkmuted mt-0.5">
              {startDate} to {endDate} · {history ? `${history.coverage.available_days} of ${history.coverage.total_days} days have data` : '…'}
              {' '}· red dot = a day with hours above the exceedance threshold · hatched bar = partial hourly coverage
            </p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
            {totalMissingHours > 0 && (
              <button
                onClick={() => setShowFillModal(true)}
                disabled={filling || loading}
                className="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
              >
                {filling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CloudDownload className="w-3.5 h-3.5" />}
                {filling ? 'Fetching…' : `Fetch Missing Data (${totalMissingHours})`}
              </button>
            )}
            <div className="flex items-center gap-1 bg-app p-1 rounded-xl border border-border">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setRangeKey(r.key)}
                  className={`px-3 py-1.5 text-xs font-mono rounded-lg transition-all cursor-pointer ${
                    rangeKey === r.key ? 'bg-orange-500 text-zinc-950 font-black' : 'text-inkmuted hover:text-ink'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {fillError && (
          <p className="text-xs text-amber-300 font-mono flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {fillError}
          </p>
        )}

        <div className="h-64 w-full bg-app/60 rounded-2xl p-4 border border-border relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-inkmuted text-xs font-mono gap-2 bg-app/60">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Reading stored data…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-red-400 text-xs font-mono gap-2 px-4 text-center bg-app/60">
              <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}
          {!loading && !error && (
            <div className="h-full w-full flex items-end justify-between gap-1.5 sm:gap-2.5">
              {daily.map((d) => (
                <DayBar key={d.date} day={d} maxOfRange={maxOfRange} isHottest={hottest && d.date === hottest.date} />
              ))}
            </div>
          )}
        </div>

        {!loading && !error && availableDays.length === 0 && (
          <p className="text-xs text-inkmuted text-center">
            No data on file for this range yet — visit Heat Map, Heat Story, or the Dashboard for one of these dates to populate it.
          </p>
        )}
      </div>

      {/* Real correlation-style panels — every number here is read
          straight from location_features/exposure_repository, nothing
          modeled or estimated for this view specifically. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <h4 className="text-sm font-bold text-ink flex items-center gap-1.5"><TrendingUp className="w-4 h-4 text-red-400" /> Hottest / Coolest Day</h4>
          </div>
          {hottest ? (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-inkmuted">Hottest</span>
                <span className="font-mono font-bold text-red-400">{cToF(hottest.max_temp_c).toFixed(1)}°F · {hottest.date}</span>
              </div>
              {coolest && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-inkmuted">Coolest</span>
                  <span className="font-mono font-bold text-blue-400 flex items-center gap-1"><TrendingDown className="w-3 h-3" /> {cToF(coolest.max_temp_c).toFixed(1)}°F · {coolest.date}</span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-inkfaint mt-3">No temperature data on file for this range yet.</p>
          )}
        </div>

        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <h4 className="text-sm font-bold text-ink flex items-center gap-1.5"><Flame className="w-4 h-4 text-orange-400" /> Exceedance</h4>
          </div>
          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-inkmuted">Days above threshold</span>
              <span className="font-mono font-bold text-ink">{daysAboveThreshold} of {availableDays.length || 0} measured</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-inkmuted">Total exceedance hours</span>
              <span className="font-mono font-bold text-orange-400">{formatNumber(totalExceedance, 1, 'h')}</span>
            </div>
          </div>
        </div>

        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <h4 className="text-sm font-bold text-ink flex items-center gap-1.5"><Gauge className="w-4 h-4 text-amber-400" /> Data Coverage</h4>
          </div>
          <div className="mt-3 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-inkmuted">Days with any data</span>
              <span className="font-mono font-bold text-ink">
                {history ? `${history.coverage.available_days} / ${history.coverage.total_days}` : '—'}
              </span>
            </div>
            {exposure && (
              <div className="flex items-center gap-3 pt-2 border-t border-border/60 mt-2">
                <span className="flex items-center gap-1 text-inksoft"><School className="w-3.5 h-3.5 text-orange-400" /> {exposure.schools}</span>
                <span className="flex items-center gap-1 text-inksoft"><Cross className="w-3.5 h-3.5 text-orange-400" /> {exposure.hospitals}</span>
                <span className="flex items-center gap-1 text-inksoft"><Building2 className="w-3.5 h-3.5 text-orange-400" /> {formatNumber(exposure.buildings, 0)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Groq research summary — explicit click, same contract as Heat
          Story's "Generate Story" and Time Compare's explanation: it
          costs a real Groq call and re-reads the range fresh server-side. */}
      <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
        <div className="flex items-center justify-between pb-4 border-b border-border gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-orange-400" />
            <h3 className="text-base font-bold text-ink">Research Summary</h3>
          </div>
          <button
            onClick={generateSummary}
            disabled={summaryLoading || !history || availableDays.length === 0}
            className="px-3.5 py-2 rounded-xl bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 shrink-0"
          >
            {summaryLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {summaryLoading ? 'Analyzing…' : summary ? 'Regenerate' : 'Generate Research Summary'}
          </button>
        </div>

        {!summary && !summaryLoading && !summaryError && (
          <p className="text-xs text-inkmuted mt-4">
            {availableDays.length === 0
              ? 'No data on file for this range yet — nothing to summarize.'
              : `Get an AI-written summary of the ${startDate} – ${endDate} record: the overall trend, the exceedance/persistence pattern, how complete the data actually is, and why it matters.`}
          </p>
        )}
        {summaryError && (
          <p className="text-xs text-red-400 font-mono mt-4 flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {summaryError}
          </p>
        )}
        {summary && (
          <div className="space-y-3 mt-5">
            <div className="p-4 rounded-2xl bg-orange-500/10 border border-orange-500/30">
              <p className="text-sm font-bold text-ink leading-relaxed">{summary.summary}</p>
            </div>
            {SUMMARY_SECTIONS.map(({ key, label, icon: Icon }) => (
              <div key={key} className="p-4 rounded-2xl bg-app/60 border border-border/80 flex items-start gap-3.5">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 border bg-orange-500/15 border-orange-500/30 text-orange-400">
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-ink">{label}</h4>
                  <p className="text-xs text-inksoft mt-1 leading-relaxed">{summary[key]}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] text-inkfaint font-mono text-center">
        Every figure above comes from Thermora's own stored record (location_features) or Phase 6 exposure data — nothing on this page is modeled, estimated, or invented.
      </p>

      {showFillModal && (
        <FillGapsModal
          daysWithGaps={daysWithGaps}
          hourCount={totalMissingHours}
          batchCount={Math.min(totalMissingHours, MAX_FILL_JOBS_PER_REQUEST)}
          confirming={filling}
          onCancel={() => setShowFillModal(false)}
          onConfirm={confirmFillGaps}
        />
      )}
    </div>
  );
};