import React, { useState, useEffect, useMemo } from 'react';
import {
  Scale, RefreshCw, Plus, TrendingUp, TrendingDown, AlertTriangle, CalendarRange,
  Thermometer, Hourglass, Timer, CalendarDays, BarChart3,
  LineChart as LineChartIcon, AreaChart as AreaChartIcon, BarChart2,
  Flame, Snowflake, CloudRain, ChevronDown, Activity, Download, Sparkles,
} from 'lucide-react';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { useCityLatest } from '../hooks/useCityLatest';
import { CalendarDatePicker } from './CalendarDatePicker';
import { WeatherGaugeRow } from './compare/WeatherGauges';
import {
  fetchHistoricalComparison,
  fetchHistoricalAvailableMonths,
  fetchHistoricalAvailableDates,
  fetchHistoricalByDate,
  fetchHistoricalExtremes,
  fetchWeatherContext,
  fetchWeatherContextBatch,
  fetchTemperatureProfile,
  fetchTemperatureProfileByDate,
} from '../api/thermoraApi';

function celsiusToF(c) {
  return c === undefined || c === null ? null : (c * 9) / 5 + 32;
}

// Generic tidy-format CSV export — every "Download" button in this file
// hands this an array of plain objects (one row each); headers are taken
// from the union of keys across all rows (not just the first) so a row
// missing a field some other row has doesn't silently shift columns.
// Client-side only, no backend endpoint: everything exported here is
// already sitting in this component's own state, fetched from Postgres-
// backed endpoints the same charts already render from — this just
// serializes what's already on screen, not a second data path.
function downloadCSV(filename, rows) {
  if (!rows || rows.length === 0) return;
  const headers = [...rows.reduce((set, row) => { Object.keys(row).forEach((k) => set.add(k)); return set; }, new Set())];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function DownloadButton({ onClick, label = 'Download CSV', disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border border-border text-inkmuted hover:text-ink hover:border-borderstrong disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <Download className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

// Every "Ask AI" button in this file opens the SAME app-wide agent
// drawer every other tab uses (see App.jsx's onOpenAIAgent) — a real,
// tool-calling agent that has its own get_multiple_cities_status and
// get_historical_trend tools (it reads the exact same historical_heat_data
// this view does), not a bespoke summarizer built just for this screen.
// This button only ever supplies the opening PROMPT; the agent still
// investigates for itself rather than being handed pre-computed numbers
// to just reword.
function AskAIButton({ onClick, label = 'Ask AI' }) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer"
    >
      <Sparkles className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

// --- Live Conditions Table — one row per selected city, live FortyGuard
// reading (via the shared/cached useCityLatest hook — no extra fetch
// beyond what selecting the city already triggers), plus the environment
// factor columns and the FortyGuard pass timestamp. This is the ONLY
// live-conditions view now: no card grid, no chart toggle — just the
// table, exactly as it reads at a glance in the reference layout.
const ENV_FACTOR_COLUMNS = [
  { key: 'relative_humidity_percent', label: 'HUMIDITY', unit: '%', digits: 0 },
  { key: 'heat_index_celsius', label: 'HEAT INDEX', unit: '°F', digits: 1, isTemp: true },
  { key: 'wet_bulb_temperature_celsius', label: 'WET BULB', unit: '°F', digits: 1, isTemp: true },
  { key: 'air_quality:idx', label: 'AQI', unit: '', digits: 0 },
];

function firstEnvValue(envParams, key) {
  const params = envParams?.locations?.[0]?.parameters || {};
  const vals = params[key];
  const val = Array.isArray(vals) ? vals[0] : vals;
  return val === undefined || val === null ? null : val;
}

function LiveConditionsTableRow({ city }) {
  const { heatmap, envParams, updatedAt, loading } = useCityLatest(city.id);
  const stats = heatmap?.stats_data?.temperature_stats;
  const hasData = !!stats;

  return (
    <tr className="border-b border-border/50 last:border-b-0">
      <td className="px-4 py-2.5">
        <span className="font-semibold text-ink text-xs">{city.name}</span>
      </td>
      {loading && !hasData ? (
        <td colSpan={4 + ENV_FACTOR_COLUMNS.length} className="px-4 py-2.5 text-right">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-inkfaint font-mono">
            <RefreshCw className="w-3 h-3 animate-spin" /> fetching…
          </span>
        </td>
      ) : !hasData ? (
        <td colSpan={4 + ENV_FACTOR_COLUMNS.length} className="px-4 py-2.5 text-right text-[11px] text-inkfaint font-mono">
          No live data available
        </td>
      ) : (
        <>
          <td className="px-4 py-2.5 text-right font-black text-ink text-sm">{celsiusToF(stats.mean).toFixed(1)}°F</td>
          <td className="px-4 py-2.5 text-right font-black text-orange-400 text-sm">{celsiusToF(stats.maximum).toFixed(1)}°F</td>
          <td className="px-4 py-2.5 text-right text-inksoft text-sm">{stats.standard_deviation != null ? stats.standard_deviation.toFixed(2) : '—'}</td>
          {ENV_FACTOR_COLUMNS.map((col) => {
            const raw = firstEnvValue(envParams, col.key);
            const display = raw == null ? '—' : col.isTemp ? `${celsiusToF(raw).toFixed(col.digits)}${col.unit}` : `${Number(raw).toFixed(col.digits)}${col.unit}`;
            return (
              <td key={col.key} className="px-4 py-2.5 text-right text-xs font-semibold text-inksoft hidden sm:table-cell">
                {display}
              </td>
            );
          })}
          <td className="px-4 py-2.5 text-right text-[10.5px] font-mono text-inkfaint hidden md:table-cell">
            {updatedAt ? new Date(updatedAt).toLocaleString() : '—'}
          </td>
        </>
      )}
    </tr>
  );
}

function LiveConditionsTable({ selectedCities }) {
  return (
    <div className="rounded-2xl bg-surface/80 border border-border overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-app/40">
            <th className="text-left font-mono text-[10px] text-inkmuted px-4 py-2.5">CITY</th>
            <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">MEAN</th>
            <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">MAX</th>
            <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">STD DEV</th>
            {ENV_FACTOR_COLUMNS.map((col) => (
              <th key={col.key} className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5 hidden sm:table-cell">{col.label}</th>
            ))}
            <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5 hidden md:table-cell">FORTYGUARD PASS</th>
          </tr>
        </thead>
        <tbody>
          {selectedCities.map((c) => <LiveConditionsTableRow key={c.id} city={c} />)}
        </tbody>
      </table>
      <p className="text-[10px] font-mono text-inkfaint text-center py-2 border-t border-border">
        Live FortyGuard reading per city · refreshes automatically once the local hour rolls over
      </p>
    </div>
  );
}

const CHART_TYPE_OPTIONS = [
  { value: 'line', label: 'Line', icon: LineChartIcon },
  { value: 'bar', label: 'Column', icon: BarChart2 },
  { value: 'area', label: 'Area', icon: AreaChartIcon },
  { value: 'stackedArea', label: 'Stacked Area', icon: BarChart3 },
];

const ANALYTIC_TYPES = [
  { value: 'tcm', label: 'Temperature', icon: Thermometer },
  { value: 'exceedance', label: 'Exceedance', icon: Hourglass },
  { value: 'persistence', label: 'Persistence', icon: Timer },
];

// A fixed, distinct color per city id so a given city always renders the
// same color across re-renders/selections — easier to track visually
// than re-deriving from array index, which shifts as cities are toggled.
const CITY_COLORS = {
  dfw: '#fb923c', houston: '#f87171', austin: '#38bdf8',
  'san-antonio': '#a78bfa', phoenix: '#facc15', miami: '#34d399',
};

function unitFor(analyticType) {
  return analyticType === 'tcm' ? '°F' : 'hours';
}

function toDisplay(value, analyticType) {
  if (value == null) return null;
  return analyticType === 'tcm' ? Number(celsiusToF(value).toFixed(1)) : Number(value.toFixed(1));
}

// A single, robust tooltip used by every chart in this file. Recharts'
// default tooltip infers each row's color from `payload[i].color`, which
// isn't reliably set for series that get their color from a <Cell> child
// (like the per-city bars in DateCompareSection) rather than a `fill`/
// `stroke` prop on the series element itself — that's what was rendering
// as unreadable dark-on-dark text. This version resolves the color
// itself (city id → CITY_COLORS, with a safe fallback) and always pairs
// it with light, high-contrast text on a solid dark background.
// `focusedId` (set by clicking a specific line/bar/area — see
// TrendChartCard) narrows the box down to just that one city; clicking
// the axis or any empty chart area clears it back to showing every
// selected city, same as before.
function ChartTooltip({ active, payload, label, cities, unit, focusedId }) {
  if (!active || !payload || payload.length === 0) return null;
  const nameFor = (id) => cities.find((c) => c.id === id)?.name || id;
  const visiblePayload = focusedId
    ? payload.filter((entry) => (entry.dataKey || entry.payload?.cityId || entry.name) === focusedId)
    : payload;
  if (visiblePayload.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-[#0d0d0d] px-3 py-2 shadow-2xl">
      {label && <p className="text-[10px] font-bold text-ink mb-1">{label}</p>}
      {focusedId && (
        <p className="text-[9px] font-mono text-inkfaint mb-1">Showing 1 of {payload.length} · click axis to see all</p>
      )}
      {visiblePayload.map((entry, i) => {
        const cityId = entry.dataKey || entry.payload?.cityId || entry.name;
        const color = CITY_COLORS[cityId] || entry.color || entry.fill || '#f97316';
        const cityName = entry.payload?.city || nameFor(cityId);
        const value = entry.value;
        return (
          <p key={i} className="text-[10.5px] font-mono flex items-center gap-1.5 leading-relaxed">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
            <span className="text-inkmuted">{cityName}:</span>
            <span className="text-ink font-bold">{value == null ? '—' : `${value}${unit}`}</span>
          </p>
        );
      })}
    </div>
  );
}
// --- Historical Trends: one chart per analytic type, fetched over an
// explicit "last N months" window OR an explicit hand-picked set of
// (possibly non-consecutive) months. ---------------------------------------

function useComparisonSeries({ selectedIds, analyticType, rangeMode, monthsBack, selectedMonths }) {
  const idsKey = selectedIds.join(',');
  const monthsKey = selectedMonths.join(',');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (selectedIds.length === 0) { setData(null); setLoading(false); return undefined; }
    if (rangeMode === 'specific' && selectedMonths.length === 0) { setData(null); setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const range = rangeMode === 'specific' ? { monthsList: selectedMonths } : { months: monthsBack };
    fetchHistoricalComparison(selectedIds, analyticType, range)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, analyticType, rangeMode, monthsBack, monthsKey]);

  return { data, loading, error };
}

// Average, across the currently-selected cities, of (last stored month -
// first stored month) for this analytic type — a quick "is this trending up
// or down" readout to sit next to the chart title. Purely derived from
// chartRows already being computed for the chart itself, so it costs nothing
// extra to fetch.
//
// When only one month is on screen (either because "Pick specific months"
// has just one month checked, or the range genuinely only has one month of
// data), there's no "from → to" delta to compute — but that single month
// still deserves a caption instead of going silent, so this falls back to
// that month's own average. Without this fallback, whichever month the
// user narrows down to alone (e.g. picking July on its own) would show no
// annotation at all, which reads as "the app doesn't know about July" even
// though the data — visible in the bars below — is right there.
function useTrendDelta(chartRows, selectedIds) {
  return useMemo(() => {
    if (chartRows.length === 0) return null;

    if (chartRows.length === 1) {
      const row = chartRows[0];
      const values = selectedIds.map((id) => row[id]).filter((v) => v != null);
      if (values.length === 0) return null;
      return {
        kind: 'single',
        value: values.reduce((s, v) => s + v, 0) / values.length,
        month: row.month,
      };
    }

    const first = chartRows[0];
    const last = chartRows[chartRows.length - 1];
    const diffs = selectedIds
      .map((id) => (first[id] != null && last[id] != null ? last[id] - first[id] : null))
      .filter((v) => v != null);
    if (diffs.length === 0) return null;
    return {
      kind: 'delta',
      value: diffs.reduce((s, v) => s + v, 0) / diffs.length,
      fromMonth: first.month,
      toMonth: last.month,
    };
  }, [chartRows, selectedIds]);
}

function TrendChartCard({ title, Icon, analyticType, cities, selectedIds, data, loading, error, availableMonths, chartType }) {
  const chartRows = useMemo(() => {
    if (!data) return [];
    const months = new Set();
    data.series.forEach((s) => s.points.forEach((p) => months.add(p.month)));
    const sortedMonths = [...months].sort();
    return sortedMonths.map((month) => {
      const row = { month };
      data.series.forEach((s) => {
        const point = s.points.find((p) => p.month === month);
        row[s.city_id] = point ? toDisplay(point.mean, analyticType) : null;
      });
      return row;
    });
  }, [data, analyticType]);

  const hasAnyData = chartRows.some((row) => Object.entries(row).some(([k, v]) => k !== 'month' && v != null));
  const trendDelta = useTrendDelta(chartRows, selectedIds);

  // Click-to-focus: clicking directly on one city's line/dot/bar/area
  // narrows the tooltip to that city alone; clicking the axis or any
  // other empty part of the chart clears it. Each series' onClick calls
  // stopPropagation so the chart-level onClick (which does the clearing)
  // doesn't immediately undo it on the same click.
  const [focusedId, setFocusedId] = useState(null);
  useEffect(() => {
    if (focusedId && !selectedIds.includes(focusedId)) setFocusedId(null);
  }, [focusedId, selectedIds]);
  const focusSeries = (id) => (...args) => {
    // Recharts calls series onClick as (data, index, event) but a dot's
    // onClick fires as a plain DOM handler with just (event) — find
    // whichever argument actually looks like an event and stop it there,
    // so the click doesn't also bubble up to the chart-level onClick
    // (which is what clears focusedId back to "show all").
    const event = args.find((a) => a && typeof a.stopPropagation === 'function');
    event?.stopPropagation();
    setFocusedId((prev) => (prev === id ? null : id));
  };
  const clearFocus = () => setFocusedId(null);

  // A single data point (one month selected) can't be connected into a
  // line or filled into an area — recharts still draws the lone dot, but
  // that reads as "broken" rather than "trend with one sample". Force
  // columns in that case regardless of the chosen chart type, and say why.
  const effectiveChartType = chartRows.length < 2 && chartType !== 'bar' ? 'bar' : chartType;
  const forcedToBar = effectiveChartType === 'bar' && chartType !== 'bar';

  // IMPORTANT: CartesianGrid/XAxis/YAxis/Tooltip/Legend below are
  // duplicated per branch on purpose, not pulled out into a shared
  // variable/fragment. Recharts only recognizes its axis/tooltip/legend
  // children when they are literal direct JSX children of the chart
  // wrapper (LineChart/BarChart/AreaChart) — inserting them via a
  // `{sharedFragment}` variable hides them from Recharts' child
  // introspection, which is why axis lines/numbers previously failed to
  // render at all. Keep these inline even though it's more lines.

  return (
    <div className="p-4 rounded-2xl bg-app/40 border border-border space-y-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-orange-400" />
          <h3 className="text-sm font-bold text-ink">{title}</h3>
          <span className="text-[10px] font-mono text-inkfaint">({unitFor(analyticType)})</span>
        </div>
        {trendDelta && trendDelta.kind === 'delta' && (
          <span className={`text-[10px] font-mono flex items-center gap-1 ${trendDelta.value >= 0 ? 'text-orange-400' : 'text-sky-400'}`}>
            {trendDelta.value >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {trendDelta.value >= 0 ? '+' : ''}{trendDelta.value.toFixed(1)}{unitFor(analyticType)} avg · {trendDelta.fromMonth}→{trendDelta.toMonth}
          </span>
        )}
        {trendDelta && trendDelta.kind === 'single' && (
          <span className="text-[10px] font-mono text-inkmuted flex items-center gap-1">
            avg {trendDelta.value.toFixed(1)}{unitFor(analyticType)} · {trendDelta.month}
          </span>
        )}
      </div>
      {forcedToBar && hasAnyData && !loading && !error && (
        <p className="text-[9px] font-mono text-inkfaint -mt-1.5">
          Only one month selected — showing as columns since a line/area needs 2+ points. Pick another month to see a trend.
        </p>
      )}
      <div className="h-64 min-w-0" style={{ minHeight: 256 }}>
        {loading ? (
          <div className="h-full flex items-center justify-center text-inkmuted text-xs font-mono gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-400 text-xs font-mono gap-2 px-4 text-center">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </div>
        ) : !hasAnyData ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-4">
            <AlertTriangle className="w-5 h-5 text-inkfaint" />
            <p className="text-[11px] text-inkmuted font-mono">
              No data yet for the selected cities/range.{' '}
              {availableMonths.length > 0
                ? `Data on file: ${availableMonths[0]} → ${availableMonths[availableMonths.length - 1]}.`
                : 'Run the historical seeder + migration script to populate this.'}
            </p>
          </div>
        ) : effectiveChartType === 'bar' ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} onClick={clearFocus}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} vertical={false} />
              <XAxis dataKey="month" height={26} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis width={44} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} domain={['auto', 'auto']} allowDecimals />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<ChartTooltip cities={cities} unit={unitFor(analyticType)} focusedId={focusedId} />} />
              <Legend formatter={(value) => cities.find((c) => c.id === value)?.name || value} wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
              {selectedIds.map((id) => (
                <Bar
                  key={id} dataKey={id} name={id} fill={CITY_COLORS[id] || '#f97316'} radius={[3, 3, 0, 0]}
                  cursor="pointer"
                  fillOpacity={!focusedId || focusedId === id ? 1 : 0.25}
                  onClick={focusSeries(id)}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : effectiveChartType === 'area' ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} onClick={clearFocus}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} vertical={false} />
              <XAxis dataKey="month" height={26} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis width={44} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} domain={['auto', 'auto']} allowDecimals />
              <Tooltip cursor={{ stroke: '#444', strokeWidth: 1 }} content={<ChartTooltip cities={cities} unit={unitFor(analyticType)} focusedId={focusedId} />} />
              <Legend formatter={(value) => cities.find((c) => c.id === value)?.name || value} wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
              {selectedIds.map((id) => (
                <Area
                  key={id} type="monotone" dataKey={id} name={id}
                  stroke={CITY_COLORS[id] || '#f97316'} fill={CITY_COLORS[id] || '#f97316'}
                  fillOpacity={!focusedId || focusedId === id ? 0.18 : 0.04}
                  strokeOpacity={!focusedId || focusedId === id ? 1 : 0.25}
                  strokeWidth={2} connectNulls
                  cursor="pointer"
                  activeDot={{ onClick: focusSeries(id), r: 5 }}
                  onClick={focusSeries(id)}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : effectiveChartType === 'stackedArea' ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} onClick={clearFocus}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} vertical={false} />
              <XAxis dataKey="month" height={26} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis width={44} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} domain={['auto', 'auto']} allowDecimals />
              <Tooltip cursor={{ stroke: '#444', strokeWidth: 1 }} content={<ChartTooltip cities={cities} unit={unitFor(analyticType)} focusedId={focusedId} />} />
              <Legend formatter={(value) => cities.find((c) => c.id === value)?.name || value} wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
              {selectedIds.map((id) => (
                <Area
                  key={id} type="monotone" dataKey={id} name={id} stackId="trend"
                  stroke={CITY_COLORS[id] || '#f97316'} fill={CITY_COLORS[id] || '#f97316'}
                  fillOpacity={!focusedId || focusedId === id ? 0.55 : 0.12}
                  strokeOpacity={!focusedId || focusedId === id ? 1 : 0.25}
                  strokeWidth={1.5} connectNulls
                  cursor="pointer"
                  activeDot={{ onClick: focusSeries(id), r: 4 }}
                  onClick={focusSeries(id)}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }} onClick={clearFocus}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} vertical={false} />
              <XAxis dataKey="month" height={26} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis width={44} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} domain={['auto', 'auto']} allowDecimals />
              <Tooltip cursor={{ stroke: '#444', strokeWidth: 1 }} content={<ChartTooltip cities={cities} unit={unitFor(analyticType)} focusedId={focusedId} />} />
              <Legend formatter={(value) => cities.find((c) => c.id === value)?.name || value} wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
              {selectedIds.map((id) => (
                <Line
                  key={id}
                  type="monotone"
                  dataKey={id}
                  name={id}
                  stroke={CITY_COLORS[id] || '#f97316'}
                  strokeOpacity={!focusedId || focusedId === id ? 1 : 0.2}
                  strokeWidth={2.5}
                  dot={{ r: 3, cursor: 'pointer', onClick: focusSeries(id) }}
                  activeDot={{ r: 5, cursor: 'pointer', onClick: focusSeries(id) }}
                  connectNulls
                  onClick={focusSeries(id)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// Small icon-button group for picking which recharts type renders the
// trend-over-months data — same three cards, four ways to look at them.
function ChartTypeSelector({ chartType, setChartType }) {
  return (
    <div className="flex items-center gap-1.5 p-1 bg-app/60 rounded-xl border border-border w-fit">
      {CHART_TYPE_OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          onClick={() => setChartType(value)}
          title={`${label} chart`}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
            chartType === value ? 'bg-orange-500 text-zinc-950' : 'text-inkmuted hover:text-ink'
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

function RangeControls({ rangeMode, setRangeMode, monthsBack, setMonthsBack, selectedMonths, setSelectedMonths, availableMonths }) {
  const toggleMonth = (m) => {
    setSelectedMonths((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m].sort()));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 p-1 bg-app/60 rounded-xl border border-border w-fit">
        <button
          onClick={() => setRangeMode('lastN')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            rangeMode === 'lastN' ? 'bg-surface2 text-ink' : 'text-inkmuted hover:text-ink'
          }`}
        >
          Last N months
        </button>
        <button
          onClick={() => setRangeMode('specific')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            rangeMode === 'specific' ? 'bg-surface2 text-ink' : 'text-inkmuted hover:text-ink'
          }`}
        >
          Pick specific months
        </button>
      </div>

      {rangeMode === 'lastN' ? (
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-xs font-mono text-inkmuted whitespace-nowrap">Last</label>
          <input
            type="range"
            min={1}
            max={12}
            value={monthsBack}
            onChange={(e) => setMonthsBack(Number(e.target.value))}
            className="w-40 accent-orange-500 cursor-pointer"
          />
          <span className="px-2.5 py-1 rounded-lg bg-orange-500/20 border border-orange-500/50 text-orange-300 text-xs font-bold min-w-[2.5rem] text-center">
            {monthsBack}
          </span>
          <span className="text-xs font-mono text-inkmuted whitespace-nowrap">month{monthsBack > 1 ? 's' : ''} back (from today)</span>
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="text-[10px] font-mono text-inkfaint">Click any months on file — they don't need to be consecutive.</p>
          <div className="flex flex-wrap gap-2">
            {availableMonths.length === 0 ? (
              <span className="text-xs font-mono text-inkfaint">No months on file yet.</span>
            ) : (
              availableMonths.map((m) => {
                const active = selectedMonths.includes(m);
                return (
                  <button
                    key={m}
                    onClick={() => toggleMonth(m)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all cursor-pointer ${
                      active
                        ? 'bg-orange-500/20 border-orange-500/60 text-orange-300'
                        : 'bg-transparent border-border text-inkmuted hover:text-ink'
                    }`}
                  >
                    {m}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Compare cities on one exact date (cross-section, not a trend) -------

function DateCompareSection({ cities, selectedIds, availableMonths, onExportData }) {
  const [selectedDate, setSelectedDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [weatherByCity, setWeatherByCity] = useState({});

  // Default to the most recent stored date once the month list loads —
  // the calendar itself resolves per-month dates lazily as the user
  // navigates, so this only needs to seed an initial selection.
  useEffect(() => {
    if (selectedDate || availableMonths.length === 0) return undefined;
    const lastMonth = availableMonths[availableMonths.length - 1];
    let cancelled = false;
    fetchHistoricalAvailableDates(lastMonth)
      .then((r) => {
        if (cancelled) return;
        const dates = r.dates || [];
        if (dates.length > 0) setSelectedDate(dates[dates.length - 1]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [availableMonths, selectedDate]);

  useEffect(() => {
    if (!selectedDate || selectedIds.length === 0) { setData(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHistoricalByDate(selectedIds, selectedDate)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedIds.join(',')]);

  // Optional enrichment — live rainfall/sky condition per selected city
  // for this exact date, so "why did DFW run hotter than Miami that day"
  // has at least a first-pass answer. Never blocks the bar charts above;
  // a city that Open-Meteo doesn't answer for just has no line below.
  // One batched request for every selected city rather than N separate
  // ones — see fetchWeatherContextBatch's doc comment for why that
  // matters once more than a couple of cities are selected.
  useEffect(() => {
    if (!selectedDate || selectedIds.length === 0) { setWeatherByCity({}); return undefined; }
    let cancelled = false;
    fetchWeatherContextBatch(selectedIds, selectedDate)
      .then((results) => { if (!cancelled) setWeatherByCity(results); })
      .catch(() => { if (!cancelled) setWeatherByCity({}); });
    return () => { cancelled = true; };
  }, [selectedDate, selectedIds.join(',')]);

  const barRows = (type) => (data?.cities || []).map((c) => ({
    city: cities.find((x) => x.id === c.city_id)?.name || c.city_id,
    cityId: c.city_id,
    value: c[type] ? toDisplay(c[type].mean, type) : null,
  }));

  // Reports the exact rows behind the three bar charts below, tidy-
  // format (one row per city per analytic type) — same reporting-up
  // pattern as the live table uses for its own per-city fetches.
  useEffect(() => {
    if (!onExportData) return;
    if (!data?.cities) { onExportData([]); return; }
    const rows = [];
    data.cities.forEach((c) => {
      const cityName = cities.find((x) => x.id === c.city_id)?.name || c.city_id;
      ['tcm', 'exceedance', 'persistence'].forEach((type) => {
        if (c[type]?.mean == null) return;
        rows.push({ dataset: 'date_compare', analytic_type: type, city: cityName, city_id: c.city_id, date: selectedDate, value: toDisplay(c[type].mean, type), unit: unitFor(type) });
      });
    });
    onExportData(rows);
  }, [data, cities, selectedDate, onExportData]);

  // A short, always-present takeaway for every panel (not just
  // Temperature) — which selected city ran highest/lowest that day for
  // this analytic type. Exceedance/Persistence used to just show an
  // empty gap below their chart; this fills it with the same kind of
  // "so what" read the Temperature panel already got from the weather
  // caption.
  const rankingFor = (type) => {
    const rows = barRows(type).filter((r) => r.value != null);
    if (rows.length < 2) return null;
    const sorted = [...rows].sort((a, b) => b.value - a.value);
    const highest = sorted[0];
    const lowest = sorted[sorted.length - 1];
    if (highest.cityId === lowest.cityId) return null;
    return { highest, lowest };
  };

  const hasAnyData = !!data && data.cities.some((c) => c.has_data);

  // Detailed (forecast-card-style: feels-like, wind, humidity, cloud
  // cover, sunshine) vs compact (one line per city) weather readout.
  // Used to be forced by city count (<=2 detailed, 3 compact) — now it's
  // a toggle so the fuller research-grade view is available whether 2 or
  // 3 cities are selected, defaulting to whichever reads best for the
  // current count.
  const [weatherViewOverride, setWeatherViewOverride] = useState(null);
  const detailedWeather = weatherViewOverride != null ? weatherViewOverride : selectedIds.length <= 2;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <CalendarDatePicker
          label="Date"
          value={selectedDate}
          onChange={setSelectedDate}
          availableMonths={availableMonths}
          fetchDatesForMonth={fetchHistoricalAvailableDates}
        />
        <div className="flex items-center gap-1.5 p-1 bg-app/60 rounded-xl border border-border w-fit ml-auto">
          <span className="text-[9px] font-mono text-inkfaint pl-1.5 hidden sm:inline">Weather detail</span>
          <button
            onClick={() => setWeatherViewOverride(false)}
            className={`px-2.5 py-1 rounded-lg text-[10.5px] font-semibold transition-all cursor-pointer ${
              !detailedWeather ? 'bg-surface2 text-ink' : 'text-inkmuted hover:text-ink'
            }`}
          >
            Compact
          </button>
          <button
            onClick={() => setWeatherViewOverride(true)}
            className={`px-2.5 py-1 rounded-lg text-[10.5px] font-semibold transition-all cursor-pointer ${
              detailedWeather ? 'bg-surface2 text-ink' : 'text-inkmuted hover:text-ink'
            }`}
          >
            Detailed
          </button>
        </div>
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center text-inkmuted text-xs font-mono gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="h-40 flex items-center justify-center text-red-400 text-xs font-mono gap-2">
          <AlertTriangle className="w-4 h-4" /> {error}
        </div>
      ) : !hasAnyData ? (
        <div className="h-40 flex items-center justify-center text-inkmuted text-xs font-mono px-6 text-center">
          No stored data for the selected cities on this date.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {ANALYTIC_TYPES.map(({ value, label, icon: Icon }) => {
            const ranking = rankingFor(value);
            return (
              <div key={value} className="p-4 rounded-xl bg-app/40 border border-border space-y-2 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5 text-orange-400" />
                  <h4 className="text-xs font-bold text-ink">{label}</h4>
                  <span className="text-[9px] font-mono text-inkfaint">({unitFor(value)})</span>
                </div>
                <div className="h-48 min-w-0" style={{ minHeight: 192 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barRows(value)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} vertical={false} />
                      <XAxis dataKey="city" height={24} tick={{ fontSize: 9, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} />
                      <YAxis width={36} tick={{ fontSize: 9, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} domain={['auto', 'auto']} />
                      <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<ChartTooltip cities={cities} unit={unitFor(value)} />} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {barRows(value).map((row) => (
                          <Cell key={row.cityId} fill={CITY_COLORS[row.cityId] || '#f97316'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                {ranking && (
                  <div className="pt-2 border-t border-border/60 space-y-0.5">
                    <p className="text-[9px] font-mono text-inkmuted">
                      <span style={{ color: CITY_COLORS[ranking.highest.cityId] || '#f97316' }}>▲</span>{' '}
                      Highest: <span className="text-ink font-bold">{ranking.highest.city}</span> ({ranking.highest.value}{unitFor(value)})
                    </p>
                    <p className="text-[9px] font-mono text-inkmuted">
                      <span style={{ color: CITY_COLORS[ranking.lowest.cityId] || '#38bdf8' }}>▼</span>{' '}
                      Lowest: <span className="text-ink font-bold">{ranking.lowest.city}</span> ({ranking.lowest.value}{unitFor(value)})
                    </p>
                  </div>
                )}

                {value === 'tcm' && Object.values(weatherByCity).some((w) => w?.available) && !detailedWeather && (
                  <div className="pt-2 border-t border-border/60 space-y-1">
                    <p className="text-[9px] font-mono text-inkfaint flex items-center gap-1">
                      <CloudRain className="w-3 h-3" /> Weather that day (Open-Meteo, live)
                    </p>
                    {selectedIds.map((id) => {
                      const w = weatherByCity[id];
                      if (!w?.available) return null;
                      const cityName = cities.find((c) => c.id === id)?.name || id;
                      const tagStr = w.tags && w.tags.length > 0 ? ` · ${w.tags.join(', ')}` : '';
                      return (
                        <p key={id} className="text-[9px] font-mono text-inkmuted">
                          <span style={{ color: CITY_COLORS[id] || '#f97316' }}>●</span> {cityName}: {w.precipitation_mm}mm rain · {w.condition}{tagStr}
                        </p>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Detailed per-city weather cards render full-width in their own
          horizontal grid (3-up on desktop, wrapping to a new row), not
          stacked one-under-another inside the Temperature column — that
          used to force a lot of vertical scrolling for not much extra
          width, and left the Exceedance/Persistence columns visually
          empty beneath their charts. */}
      {hasAnyData && detailedWeather && Object.values(weatherByCity).some((w) => w?.available) && (
        <div className="space-y-2">
          <p className="text-[9px] font-mono text-inkfaint flex items-center gap-1">
            <CloudRain className="w-3 h-3" /> Weather that day (Open-Meteo, live)
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {selectedIds.map((id) => {
              const w = weatherByCity[id];
              if (!w?.available) return null;
              const cityName = cities.find((c) => c.id === id)?.name || id;
              return (
                <div key={id} className="rounded-lg bg-app/40 border border-border p-3 space-y-1.5 min-w-0">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="text-[9.5px] font-mono font-bold text-ink flex items-center gap-1">
                      <span style={{ color: CITY_COLORS[id] || '#f97316' }}>●</span> {cityName} · {w.condition}
                    </p>
                    {w.tags && w.tags.length > 0 && (
                      <div className="flex gap-1">
                        {w.tags.map((tag) => (
                          <span key={tag} className="px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-[8px] font-mono text-inkmuted capitalize">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <WeatherGaugeRow weather={w} />
                  <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] font-mono text-inkmuted pt-1 border-t border-border/40">
                    {w.temp_max_f != null && <span>High: <span className="text-ink">{w.temp_max_f}°F</span></span>}
                    {w.temp_min_f != null && <span>Low: <span className="text-ink">{w.temp_min_f}°F</span></span>}
                    {w.feels_like_max_f != null && <span>Feels like: <span className="text-ink">{w.feels_like_max_f}°F</span></span>}
                    {w.cloud_cover_pct != null && <span>Cloud cover: <span className="text-ink">{w.cloud_cover_pct}%</span></span>}
                    {w.sunshine_hours != null && <span>Sunshine: <span className="text-ink">{w.sunshine_hours}h</span></span>}
                    <span>Rain: <span className="text-ink">{w.precipitation_mm}mm</span></span>
                    {w.precipitation_hours != null && <span>Rain hrs: <span className="text-ink">{w.precipitation_hours}h</span></span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <p className="text-[10px] font-mono text-inkfaint">
        Source: historical_heat_data · the exact stored reading for {selectedDate || 'the selected date'} (not an average). Weather details are a live Open-Meteo lookup, not a stored reading.
      </p>
    </div>
  );
}

// Phase 14 — City-to-City Comparison. Reads from historical_heat_data
// (populated offline by seed_historical.py, migrated in via
// scripts/migrate_historical_from_neon.py) — a handful of cheap Postgres
// reads, never FortyGuard, for every part of this section including the
// snapshot cards above.
// Fetches, for the currently selected cities/range, each city's hottest
// and coolest stored day (see repo.get_extremes) — independent of
// analyticType/chartType, so it's one fetch shared by the whole trend
// section rather than one per chart card.
function useExtremes({ selectedIds, rangeMode, monthsBack, selectedMonths }) {
  const idsKey = selectedIds.join(',');
  const monthsKey = selectedMonths.join(',');
  const [extremes, setExtremes] = useState(null);

  useEffect(() => {
    if (selectedIds.length === 0) { setExtremes(null); return undefined; }
    if (rangeMode === 'specific' && selectedMonths.length === 0) { setExtremes(null); return undefined; }
    let cancelled = false;
    const range = rangeMode === 'specific' ? { monthsList: selectedMonths } : { months: monthsBack };
    fetchHistoricalExtremes(selectedIds, range)
      .then((r) => { if (!cancelled) setExtremes(r.cities || []); })
      .catch(() => { if (!cancelled) setExtremes(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, rangeMode, monthsBack, monthsKey]);

  return extremes;
}

// Highlights the single hottest and single coolest day across *all*
// currently-compared cities/months (not per-city) — answers "of
// everything on screen, what was the most extreme day and where" — then
// lazily looks up that day's rainfall/sky condition from Open-Meteo as a
// first-pass "why".
function ExtremesHighlight({ extremes }) {
  const overall = useMemo(() => {
    if (!extremes || extremes.length === 0) return null;
    let hottest = null;
    let coolest = null;
    extremes.forEach((c) => {
      if (c.hottest && (!hottest || c.hottest.value_c > hottest.value_c)) {
        hottest = { ...c.hottest, city_id: c.city_id, city_name: c.city_name };
      }
      if (c.coolest && (!coolest || c.coolest.value_c < coolest.value_c)) {
        coolest = { ...c.coolest, city_id: c.city_id, city_name: c.city_name };
      }
    });
    return (hottest || coolest) ? { hottest, coolest } : null;
  }, [extremes]);

  const [weather, setWeather] = useState({});
  useEffect(() => {
    if (!overall) return undefined;
    let cancelled = false;
    [overall.hottest, overall.coolest].filter(Boolean).forEach((entry) => {
      const key = `${entry.city_id}:${entry.date}`;
      fetchWeatherContext(entry.city_id, entry.date)
        .then((r) => { if (!cancelled) setWeather((prev) => ({ ...prev, [key]: r })); })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [overall?.hottest?.city_id, overall?.hottest?.date, overall?.coolest?.city_id, overall?.coolest?.date]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!overall) return null;

  const Chip = ({ entry, kind }) => {
    if (!entry) return null;
    const key = `${entry.city_id}:${entry.date}`;
    const w = weather[key];
    const isHot = kind === 'hot';
    return (
      <div className={`flex items-start gap-2 px-3 py-2.5 rounded-xl border ${isHot ? 'bg-orange-500/10 border-orange-500/30' : 'bg-sky-500/10 border-sky-500/30'}`}>
        {isHot ? <Flame className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> : <Snowflake className="w-4 h-4 text-sky-400 mt-0.5 shrink-0" />}
        <div className="text-[10.5px] font-mono leading-relaxed">
          <span className="font-bold text-ink">{isHot ? 'Hottest day in range' : 'Coolest day in range'}</span>
          <br />
          <span className="text-inkmuted">{entry.city_name} · {entry.date} · {celsiusToF(entry.value_c).toFixed(1)}°F</span>
          {w?.available ? (
            <>
              <br />
              <span className="text-inkfaint flex items-center gap-1 mt-0.5">
                <CloudRain className="w-3 h-3" /> {w.precipitation_mm}mm rain · {w.condition}
              </span>
              <span className="text-inkfaint flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                {w.humidity_max_pct != null && <span>Humidity {w.humidity_max_pct}%</span>}
                {w.wind_max_mph != null && <span>Wind {w.wind_max_mph}mph</span>}
                {w.cloud_cover_pct != null && <span>Clouds {w.cloud_cover_pct}%</span>}
              </span>
              {w.tags && w.tags.length > 0 && (
                <span className="flex gap-1 mt-1">
                  {w.tags.map((tag) => (
                    <span key={tag} className="px-1.5 py-0.5 rounded-full bg-surface2 border border-border text-[8.5px] font-mono text-inkmuted capitalize">
                      {tag}
                    </span>
                  ))}
                </span>
              )}
            </>
          ) : w && !w.available ? (
            <>
              <br />
              <span className="text-inkfaint">No live weather context available for this day.</span>
            </>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <Chip entry={overall.hottest} kind="hot" />
      <Chip entry={overall.coolest} kind="cool" />
    </div>
  );
}

// --- Temperature Profile: Mean/Max/StdDev trend (replaces the old
// card-based snapshot with a graph), plus a same-shape table for one
// exact date — reuses historical_heat_data, tcm only, no live FortyGuard
// call. ------------------------------------------------------------------

function useTemperatureProfile({ selectedIds, rangeMode, monthsBack, selectedMonths }) {
  const idsKey = selectedIds.join(',');
  const monthsKey = selectedMonths.join(',');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (selectedIds.length === 0) { setData(null); setLoading(false); return undefined; }
    if (rangeMode === 'specific' && selectedMonths.length === 0) { setData(null); setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const range = rangeMode === 'specific' ? { monthsList: selectedMonths } : { months: monthsBack };
    fetchTemperatureProfile(selectedIds, range)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, rangeMode, monthsBack, monthsKey]);

  return { data, loading, error };
}

const PROFILE_METRICS = [
  { key: 'mean', label: 'Mean', color: '#38bdf8' },
  { key: 'max', label: 'Max', color: '#fb923c' },
  { key: 'std', label: 'StdDev', color: '#a78bfa' },
];

// One metric (mean/max/std) at a time, every selected city as its own
// line — simple line chart only (unlike TrendChartCard, no bar/area
// toggle) since this is meant to read like the reference sketch: a
// handful of clean upward/downward lines, not a switchable chart type.
function ProfileMetricChart({ metricKey, label, cities, selectedIds, data, loading, error }) {
  const chartRows = useMemo(() => {
    if (!data) return [];
    const months = new Set();
    data.series.forEach((s) => s.points.forEach((p) => months.add(p.month)));
    const sortedMonths = [...months].sort();
    return sortedMonths.map((month) => {
      const row = { month };
      data.series.forEach((s) => {
        const point = s.points.find((p) => p.month === month);
        row[s.city_id] = point && point[metricKey] != null
          ? Number((metricKey === 'std' ? point[metricKey] : celsiusToF(point[metricKey])).toFixed(2))
          : null;
      });
      return row;
    });
  }, [data, metricKey]);

  const hasAnyData = chartRows.some((row) => Object.entries(row).some(([k, v]) => k !== 'month' && v != null));
  const unit = metricKey === 'std' ? '' : '°F';

  return (
    <div className="p-4 rounded-2xl bg-app/40 border border-border space-y-3 min-w-0">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-bold text-ink">{label}</h3>
        <span className="text-[10px] font-mono text-inkfaint">({unit || 'σ'})</span>
      </div>
      <div className="h-56 min-w-0" style={{ minHeight: 224 }}>
        {loading ? (
          <div className="h-full flex items-center justify-center text-inkmuted text-xs font-mono gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-400 text-xs font-mono gap-2 px-4 text-center">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </div>
        ) : !hasAnyData ? (
          <div className="h-full flex items-center justify-center text-center px-4">
            <p className="text-[11px] text-inkmuted font-mono">No data yet for the selected cities/range.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartRows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" opacity={0.3} vertical={false} />
              <XAxis dataKey="month" height={26} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} />
              <YAxis width={40} tick={{ fontSize: 10, fill: '#aaa' }} axisLine={{ stroke: '#333' }} tickLine={false} domain={['auto', 'auto']} />
              <Tooltip cursor={{ stroke: '#444', strokeWidth: 1 }} content={<ChartTooltip cities={cities} unit={unit} />} />
              <Legend formatter={(value) => cities.find((c) => c.id === value)?.name || value} wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
              {selectedIds.map((id) => (
                <Line
                  key={id} type="monotone" dataKey={id} name={id}
                  stroke={CITY_COLORS[id] || '#f97316'} strokeWidth={2.5}
                  dot={{ r: 3 }} connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

// Table below the graph — appears once the user picks one exact date
// instead of reading the monthly trend, same mean/max/min/std shape as
// the old snapshot cards but as rows (not cards) so it doesn't blow up
// vertically past 2-3 cities.
function ProfileDateTable({ cities, selectedIds, availableMonths }) {
  const [selectedDate, setSelectedDate] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (selectedDate || availableMonths.length === 0) return undefined;
    const lastMonth = availableMonths[availableMonths.length - 1];
    let cancelled = false;
    fetchHistoricalAvailableDates(lastMonth)
      .then((r) => {
        if (cancelled) return;
        const dates = r.dates || [];
        if (dates.length > 0) setSelectedDate(dates[dates.length - 1]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [availableMonths, selectedDate]);

  useEffect(() => {
    if (!selectedDate || selectedIds.length === 0) { setData(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTemperatureProfileByDate(selectedIds, selectedDate)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, selectedIds.join(',')]);

  return (
    <div className="space-y-3">
      <CalendarDatePicker
        label="Date"
        value={selectedDate}
        onChange={setSelectedDate}
        availableMonths={availableMonths}
        fetchDatesForMonth={fetchHistoricalAvailableDates}
      />
      <div className="rounded-2xl bg-surface/80 border border-border overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-app/40">
              <th className="text-left font-mono text-[10px] text-inkmuted px-4 py-2.5">CITY</th>
              <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">MEAN</th>
              <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">MAX</th>
              <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">MIN</th>
              <th className="text-right font-mono text-[10px] text-inkmuted px-4 py-2.5">STD DEV</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-3 text-center text-[11px] text-inkfaint font-mono">
                <RefreshCw className="w-3 h-3 animate-spin inline mr-1.5" /> Loading…
              </td></tr>
            ) : error ? (
              <tr><td colSpan={5} className="px-4 py-3 text-center text-[11px] text-red-400 font-mono">{error}</td></tr>
            ) : !selectedDate ? (
              <tr><td colSpan={5} className="px-4 py-3 text-center text-[11px] text-inkfaint font-mono">Pick a date above.</td></tr>
            ) : (
              (data?.cities || []).map((c) => {
                const city = cities.find((x) => x.id === c.city_id);
                const color = CITY_COLORS[c.city_id] || '#f97316';
                return (
                  <tr key={c.city_id} className="border-b border-border/50 last:border-b-0">
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2 font-semibold text-ink text-xs">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                        {city?.name || c.city_id}
                      </span>
                    </td>
                    {!c.has_data ? (
                      <td colSpan={4} className="px-4 py-2.5 text-right text-[11px] text-inkfaint font-mono">No data for this date</td>
                    ) : (
                      <>
                        <td className="px-4 py-2.5 text-right font-black text-ink text-sm">{c.mean != null ? `${celsiusToF(c.mean).toFixed(1)}°F` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-black text-orange-400 text-sm">{c.max != null ? `${celsiusToF(c.max).toFixed(1)}°F` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-inksoft text-sm">{c.min != null ? `${celsiusToF(c.min).toFixed(1)}°F` : '—'}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-inksoft text-sm">{c.std != null ? c.std.toFixed(2) : '—'}</td>
                      </>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TemperatureProfileSection({ cities, selectedIds, rangeMode, setRangeMode, monthsBack, setMonthsBack, selectedMonths, setSelectedMonths, availableMonths, onExportData }) {
  const [dateMode, setDateMode] = useState(false); // false = monthly graph, true = also show the specific-date table below it
  const profile = useTemperatureProfile({ selectedIds, rangeMode, monthsBack, selectedMonths });

  // Reports the exact rows behind the three ProfileMetricChart lines
  // below, tidy-format (one row per city per month per metric).
  useEffect(() => {
    if (!onExportData) return;
    if (!profile.data?.series) { onExportData([]); return; }
    const rows = [];
    profile.data.series.forEach((s) => {
      const cityName = cities.find((c) => c.id === s.city_id)?.name || s.city_id;
      s.points.forEach((p) => {
        PROFILE_METRICS.forEach(({ key, label }) => {
          if (p[key] == null) return;
          rows.push({
            dataset: 'temperature_profile', metric: label, city: cityName, city_id: s.city_id,
            month: p.month, value: key === 'std' ? p[key].toFixed(2) : celsiusToF(p[key]).toFixed(1),
            unit: key === 'std' ? '' : '°F',
          });
        });
      });
    });
    onExportData(rows);
  }, [profile.data, cities, onExportData]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeControls
          rangeMode={rangeMode}
          setRangeMode={setRangeMode}
          monthsBack={monthsBack}
          setMonthsBack={setMonthsBack}
          selectedMonths={selectedMonths}
          setSelectedMonths={setSelectedMonths}
          availableMonths={availableMonths}
        />
        <button
          onClick={() => setDateMode((v) => !v)}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
            dateMode ? 'bg-orange-500 text-zinc-950 border-orange-500' : 'text-inkmuted hover:text-ink border-border'
          }`}
        >
          <CalendarDays className="w-3.5 h-3.5" /> {dateMode ? 'Hide specific-date table' : 'Look up an exact date'}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {PROFILE_METRICS.map(({ key, label }) => (
          <ProfileMetricChart
            key={key}
            metricKey={key}
            label={label}
            cities={cities}
            selectedIds={selectedIds}
            data={profile.data}
            loading={profile.loading}
            error={profile.error}
          />
        ))}
      </div>

      <p className="text-[10px] font-mono text-inkfaint">
        Source: historical_heat_data (offline-seeded via FortyGuard) · monthly average per city, tcm only
      </p>

      {dateMode && <ProfileDateTable cities={cities} selectedIds={selectedIds} availableMonths={availableMonths} />}
    </div>
  );
}

function HistoricalTrendsSection({ cities = [], onOpenAIAgent }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedIds, setSelectedIds] = useState(cities.map((c) => c.id));
  const [viewMode, setViewMode] = useState('trend'); // 'trend' | 'date' | 'profile'
  const [rangeMode, setRangeMode] = useState('lastN'); // 'lastN' | 'specific'
  const [monthsBack, setMonthsBack] = useState(3);
  const [selectedMonths, setSelectedMonths] = useState([]);
  const [availableMonths, setAvailableMonths] = useState([]);
  const [chartType, setChartType] = useState('line'); // 'line' | 'bar' | 'area' | 'stackedArea'

  // Whatever's currently on screen, in exportable tidy-row form — 'trend'
  // mode fills this directly below (it already has tcm/exceedance/
  // persistence/extremes in scope in THIS component); 'date' and
  // 'profile' mode report their own rows up via onExportData, same
  // reporting-up pattern the live table uses for its per-city fetches.
  // Only one of the three is ever actually mounted at a time, so there's
  // no risk of a hidden section's rows clobbering the visible one's.
  const [exportRows, setExportRows] = useState([]);

  useEffect(() => {
    fetchHistoricalAvailableMonths()
      .then((r) => {
        const months = r.months || [];
        setAvailableMonths(months);
        setSelectedMonths((prev) => (prev.length > 0 ? prev : months.slice(-3)));
      })
      .catch(() => setAvailableMonths([]));
  }, []);

  const toggleCity = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const tcm = useComparisonSeries({ selectedIds, analyticType: 'tcm', rangeMode, monthsBack, selectedMonths });
  const exceedance = useComparisonSeries({ selectedIds, analyticType: 'exceedance', rangeMode, monthsBack, selectedMonths });
  const persistence = useComparisonSeries({ selectedIds, analyticType: 'persistence', rangeMode, monthsBack, selectedMonths });
  const seriesByType = { tcm, exceedance, persistence };
  const extremes = useExtremes({ selectedIds, rangeMode, monthsBack, selectedMonths });

  // Trend mode's own export rows — one row per (analytic type, city,
  // month) plus the hottest/coolest-in-range highlights, tidy-format so
  // all three analytic types land in one CSV instead of three.
  useEffect(() => {
    if (viewMode !== 'trend') return;
    const rows = [];
    Object.entries(seriesByType).forEach(([analyticType, { data }]) => {
      if (!data) return;
      data.series.forEach((s) => {
        const cityName = cities.find((c) => c.id === s.city_id)?.name || s.city_id;
        s.points.forEach((p) => {
          rows.push({
            dataset: 'monthly_trend', analytic_type: analyticType, city: cityName, city_id: s.city_id,
            month: p.month, value: toDisplay(p.mean, analyticType), unit: unitFor(analyticType),
          });
        });
      });
    });
    (extremes || []).forEach((c) => {
      const cityName = cities.find((x) => x.id === c.city_id)?.name || c.city_id;
      if (c.hottest) rows.push({ dataset: 'extreme_hottest', analytic_type: 'tcm', city: cityName, city_id: c.city_id, month: c.hottest.date, value: celsiusToF(c.hottest.value_c).toFixed(1), unit: '°F' });
      if (c.coolest) rows.push({ dataset: 'extreme_coolest', analytic_type: 'tcm', city: cityName, city_id: c.city_id, month: c.coolest.date, value: celsiusToF(c.coolest.value_c).toFixed(1), unit: '°F' });
    });
    setExportRows(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, tcm.data, exceedance.data, persistence.data, extremes, cities]);

  // Context-aware opening prompt for the real tool-calling agent — it
  // investigates for itself from here (get_historical_trend etc.), this
  // just tells it what's currently being looked at so the question
  // doesn't have to be re-typed from scratch.
  const cityNames = cities.filter((c) => selectedIds.includes(c.id)).map((c) => c.name).join(', ');
  const rangeDescription = rangeMode === 'specific'
    ? `the months ${selectedMonths.join(', ')}`
    : `the last ${monthsBack} months`;
  const askPrompt = viewMode === 'trend'
    ? `Explain the historical heat trend for ${cityNames} over ${rangeDescription} — what's changed and why might it differ between these cities?`
    : viewMode === 'date'
      ? `Explain how ${cityNames} compared to each other on the date currently selected in Compare Cities.`
      : `Explain the mean/max/variability temperature profile for ${cityNames} over ${rangeDescription}.`;

  return (
    <div className="p-6 sm:p-8 rounded-[2rem] bg-surface/80 border border-border shadow-2xl space-y-6">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between flex-wrap gap-3 cursor-pointer text-left"
      >
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-orange-400" />
          <h2 className="text-lg font-bold text-ink tracking-tight">Historical Trends</h2>
          <ChevronDown className={`w-4 h-4 text-inkfaint transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
        {availableMonths.length > 0 && (
          <span className="text-[10px] font-mono text-inkfaint flex items-center gap-1.5">
            <CalendarRange className="w-3 h-3" /> Data on file: {availableMonths[0]} → {availableMonths[availableMonths.length - 1]}
          </span>
        )}
      </button>

      {expanded && (
        <>
      <div className="flex items-center justify-end gap-2 flex-wrap -mt-2">
        <DownloadButton
          label={`Download ${viewMode === 'trend' ? 'Trend' : viewMode === 'date' ? 'Date Compare' : 'Profile'} CSV`}
          disabled={exportRows.length === 0}
          onClick={() => downloadCSV(`thermora_historical_${viewMode}_${new Date().toISOString().slice(0, 10)}.csv`, exportRows)}
        />
        {onOpenAIAgent && <AskAIButton onClick={() => onOpenAIAgent(askPrompt)} />}
      </div>
      {/* View mode: trend-over-time vs one-exact-date cross-section */}
      <div className="flex items-center gap-1.5 p-1 bg-app/60 rounded-xl border border-border w-fit">
        <button
          onClick={() => setViewMode('trend')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
            viewMode === 'trend' ? 'bg-orange-500 text-zinc-950' : 'text-inkmuted hover:text-ink'
          }`}
        >
          <TrendingUp className="w-3.5 h-3.5" /> Trend over months
        </button>
        <button
          onClick={() => setViewMode('date')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
            viewMode === 'date' ? 'bg-orange-500 text-zinc-950' : 'text-inkmuted hover:text-ink'
          }`}
        >
          <BarChart3 className="w-3.5 h-3.5" /> Compare on a specific date
        </button>
        <button
          onClick={() => setViewMode('profile')}
          className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
            viewMode === 'profile' ? 'bg-orange-500 text-zinc-950' : 'text-inkmuted hover:text-ink'
          }`}
        >
          <Thermometer className="w-3.5 h-3.5" /> Mean/Max/StdDev
        </button>
      </div>

      {/* City toggle pills — shared by both modes */}
      <div className="flex flex-wrap gap-2">
        {cities.map((c) => {
          const active = selectedIds.includes(c.id);
          const color = CITY_COLORS[c.id] || '#f97316';
          return (
            <button
              key={c.id}
              onClick={() => toggleCity(c.id)}
              className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer border flex items-center gap-1.5"
              style={active
                ? { backgroundColor: `${color}26`, borderColor: `${color}80`, color }
                : { backgroundColor: 'transparent', borderColor: 'var(--border, #333)', color: 'var(--inkmuted, #999)' }}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: active ? color : '#555' }} />
              {c.name}
            </button>
          );
        })}
      </div>

      {viewMode === 'trend' ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <RangeControls
              rangeMode={rangeMode}
              setRangeMode={setRangeMode}
              monthsBack={monthsBack}
              setMonthsBack={setMonthsBack}
              selectedMonths={selectedMonths}
              setSelectedMonths={setSelectedMonths}
              availableMonths={availableMonths}
            />
            <ChartTypeSelector chartType={chartType} setChartType={setChartType} />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {ANALYTIC_TYPES.map(({ value, label, icon: Icon }) => (
              <TrendChartCard
                key={value}
                title={label}
                Icon={Icon}
                analyticType={value}
                cities={cities}
                selectedIds={selectedIds}
                data={seriesByType[value].data}
                loading={seriesByType[value].loading}
                error={seriesByType[value].error}
                availableMonths={availableMonths}
                chartType={chartType}
              />
            ))}
          </div>

          <ExtremesHighlight extremes={extremes} />

          <p className="text-[10px] font-mono text-inkfaint">
            Source: historical_heat_data (offline-seeded via FortyGuard, one representative sample per calendar day) · monthly average per analytic type
          </p>
        </>
      ) : viewMode === 'date' ? (
        <DateCompareSection cities={cities} selectedIds={selectedIds} availableMonths={availableMonths} onExportData={setExportRows} />
      ) : (
        <TemperatureProfileSection
          cities={cities}
          selectedIds={selectedIds}
          rangeMode={rangeMode}
          setRangeMode={setRangeMode}
          monthsBack={monthsBack}
          setMonthsBack={setMonthsBack}
          selectedMonths={selectedMonths}
          setSelectedMonths={setSelectedMonths}
          availableMonths={availableMonths}
          onExportData={setExportRows}
        />
      )}
        </>
      )}
    </div>
  );
}

// Live Conditions section — table only. No card grid, no chart/table
// toggle: this used to mount up to 3 CompareCards (each a real live
// FortyGuard fetch) plus a bar-chart/table switcher for the same data.
// Both are gone — selecting a city still triggers its one live fetch
// (via useCityLatest, shared with the table rows), but the only thing
// rendered from it now is the table.
export const CompareView = ({ activeCity, cities = [], onSelectCity, onOpenAIAgent }) => {
  const [selectedIds, setSelectedIds] = useState([activeCity.id]);

  // If the active city changes (user switched cities elsewhere) while this
  // tab is mounted, keep it in the selection rather than silently dropping it.
  useEffect(() => {
    setSelectedIds((prev) => (prev.includes(activeCity.id) ? prev : [activeCity.id, ...prev]));
  }, [activeCity.id]);

  const toggle = (id) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) {
        return prev.length > 1 ? prev.filter(x => x !== id) : prev;
      }
      return prev.length < 3 ? [...prev, id] : prev;
    });
  };

  const selectedCities = cities.filter(c => selectedIds.includes(c.id));

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8 text-ink font-sans">
      <div className="flex items-center gap-2 pb-4 border-b border-border">
        <Scale className="w-5 h-5 text-orange-400" />
        <h1 className="text-2xl font-bold text-ink tracking-tight">Compare Cities</h1>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-base font-bold text-ink flex items-center gap-2">
            <Activity className="w-4 h-4 text-orange-400" /> Live Conditions
          </h2>
          {onOpenAIAgent && selectedCities.length > 0 && (
            <AskAIButton
              onClick={() => onOpenAIAgent(
                selectedCities.length > 1
                  ? `Compare the current live conditions for ${selectedCities.map((c) => c.name).join(' and ')} in detail.`
                  : `What's the current live heat risk in ${selectedCities[0].name}?`
              )}
            />
          )}
        </div>
        <p className="text-[11px] text-inkfaint font-mono flex items-center gap-1.5">
          <Plus className="w-3 h-3" /> Click up to 2 more cities to compare — real live FortyGuard call per city (temperature + humidity/heat index/wet bulb/AQI), cached per local hour.
        </p>
        <div className="flex flex-wrap gap-2">
          {cities.map(c => (
            <button
              key={c.id}
              onClick={() => toggle(c.id)}
              className={`px-3.5 py-2 rounded-xl text-xs font-semibold transition-all cursor-pointer ${selectedIds.includes(c.id) ? 'bg-orange-500 text-zinc-950' : 'bg-surface border border-border text-inkmuted hover:text-ink'}`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <LiveConditionsTable selectedCities={selectedCities} />
      </div>

      {/* Phase 14 — City-to-City historical comparison: trend over
          months, one-exact-date cross-section, and the Mean/Max/StdDev
          profile. Pure Postgres reads over historical_heat_data
          (offline-seeded via seed_historical.py + migrate_historical_
          from_neon.py) — never touches FortyGuard, independent of the
          live table above. If that table hasn't been seeded yet in this
          environment, each panel below says so instead of silently
          looking broken. */}
      <HistoricalTrendsSection cities={cities} onOpenAIAgent={onOpenAIAgent} />
    </div>
  );
};