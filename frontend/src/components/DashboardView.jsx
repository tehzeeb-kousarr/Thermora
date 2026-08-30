import React, { useState, useEffect } from 'react';
import { MapPin, ChevronRight, AlertTriangle, Clock, Zap, RefreshCw } from 'lucide-react';
import { getMostRecentForCity, subscribeCity, subscribeRiskFactorsUpdated } from '../lib/liveDataStore';
import { AlertsCard } from './dashboard/AlertsCard';
import { ExposureCard } from './dashboard/ExposureCard';
import { RiskScoreCard } from './dashboard/RiskScoreCard';
import { ImpactScoreCard } from './dashboard/ImpactScoreCard';
import { EmergencyBanner } from './dashboard/EmergencyBanner';
import { formatTemp, formatNumber, displayTemp } from '../lib/thermalFormat';
import { describeWindow, lastCompletedHourDateISO, lastCompletedHourHHMM } from '../lib/queryWindow';
import { SimpleBarChart } from './charts/MiniBarChart';
import { postEnvParams } from '../api/thermoraApi';

// Every field FortyGuard's Environmental Parameters endpoint can return,
// labeled for display. Shown in full (not a curated subset) so nothing
// retrieved from the API is left off the dashboard.
const ENV_PARAM_FIELDS = [
  { key: 'heat_index_celsius', label: 'Heat Index', kind: 'temp' },
  { key: 'apparent_temperature_celsius', label: 'Apparent Temp', kind: 'temp' },
  { key: 'wet_bulb_temperature_celsius', label: 'Wet Bulb', kind: 'temp' },
  { key: 'relative_humidity_percent', label: 'Humidity', kind: 'number', unit: '%' },
  { key: 'precipitation_mm', label: 'Precipitation', kind: 'number', unit: ' mm' },
  { key: 'cloud_cover_octas', label: 'Cloud Cover', kind: 'number', unit: ' octas' },
  { key: 'air_quality:idx', label: 'AQI (Overall)', kind: 'number' },
  { key: 'air_quality_pm2p5:idx', label: 'AQI · PM2.5', kind: 'number' },
  { key: 'air_quality_pm10:idx', label: 'AQI · PM10', kind: 'number' },
  { key: 'air_quality_no2:idx', label: 'AQI · NO₂', kind: 'number' },
  { key: 'aqi_us_co', label: 'AQI · CO', kind: 'number' },
  { key: 'air_quality_o3:idx', label: 'AQI · O₃', kind: 'number' },
  { key: 'air_quality_so2:idx', label: 'AQI · SO₂', kind: 'number' },
  { key: 'methane_ppb', label: 'Methane', kind: 'number', unit: ' ppb' },
  { key: 'co2_ppm', label: 'CO₂', kind: 'number', unit: ' ppm' },
];

function MetricCard({ label, value, sub }) {
  return (
    <div className="p-3 bg-app/70 rounded-xl border border-border">
      <div className="text-[11px] text-inkmuted font-mono uppercase truncate">{label}</div>
      <div className="text-xl font-black text-ink mt-0.5">{value ?? '—'}</div>
      {sub && <div className="text-[10px] text-inkfaint font-mono">{sub}</div>}
    </div>
  );
}

function timeAgo(date) {
  if (!date) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  return `${mins}m ago`;
}

export const DashboardView = ({ city, userSettings, onNavigateTab, onOpenAIAgent }) => {
  const unit = userSettings?.tempUnit === 'C' ? 'C' : 'F';

  // Overview does NOT fetch a heatmap of its own. It simply shows whatever
  // heatmap result was most recently generated for this city — by Heat
  // Map view, by Time Compare, wherever — reading directly from
  // liveDataStore's shared in-memory cache. If nothing has been generated
  // yet this session, that section renders its real structure with an
  // honest "no data generated yet" state instead of a fetch button —
  // generating a heatmap is Heat Map view's job; Overview just reflects
  // it, labeled with exactly which date/time it's showing.
  //
  // The one deliberate exception is Environmental Parameters, just below:
  // it has its own explicit "Fetch Environmental Factors" button, calling
  // POST /api/env-params directly rather than waiting on the lazy
  // city-summary bundle. That's a real FortyGuard request, but one
  // already cached by request signature server-side (repository.
  // get_env_params), so re-clicking for the same city/date/hour is free.
  const [entry, setEntry] = useState(() => getMostRecentForCity(city.id));

  useEffect(() => {
    setEntry(getMostRecentForCity(city.id));
    return subscribeCity(city.id, setEntry);
  }, [city.id]);

  // Fixes the exact bug this comment used to warn about: riskBoost
  // completing in the (separate) Heat Map tab genuinely writes new
  // exceedance/persistence data, but this card's own city/date props
  // never change as a result — without this, RiskScoreCard would keep
  // showing its last "Missing: Exceedance, Persistence" result forever,
  // even after that data exists, until something else (a city switch, a
  // full reload) happened to force a re-fetch.
  const [riskRefreshToken, setRiskRefreshToken] = useState(0);
  useEffect(
    () => subscribeRiskFactorsUpdated(city.id, () => setRiskRefreshToken((v) => v + 1)),
    [city.id]
  );

  const heatmap = entry?.heatmap ?? null;
  const appliedQuery = entry?.appliedQuery ?? null;
  const fetchedAt = entry?.fetchedAt ?? null;

  // "Fetch Environmental Factors" — standalone, explicit call to
  // POST /api/env-params, independent of the lazy heatmap/alerts/env
  // bundle scheduler.py's refresh_city_summary fetches automatically.
  // Result is kept in local state (not written into liveDataStore) so
  // this stays exactly as scoped as it looks: a manual fetch + display,
  // not a change to how the rest of the Dashboard sources its data.
  //
  // Declared here, BEFORE `envParams` below reads it — a plain `const`
  // is in the temporal dead zone until its own declaration runs, so
  // reading manualEnvParams any earlier (as an earlier version of this
  // file did) throws "Cannot access 'manualEnvParams' before
  // initialization" on every render, taking the whole Dashboard down.
  const [manualEnvParams, setManualEnvParams] = useState(null);
  const [envFetchLoading, setEnvFetchLoading] = useState(false);
  const [envFetchError, setEnvFetchError] = useState(null);

  const envParams = manualEnvParams ?? entry?.envParams ?? null;

  const stats = heatmap?.stats_data?.temperature_stats;
  const loc = envParams?.locations?.[0];
  const params = loc?.parameters || {};
  const solar = loc?.solar_irradiance?.clear_sky;
  const hasData = !!entry;

  // Resolved once, shared by both the fetch handler and the header label
  // below, so the two can never drift apart (one showing what will be
  // requested, the other silently computing something slightly
  // different). See fetchEnvironmentalFactors' fuller comment for why the
  // fallback is noon-of-that-date rather than "the current hour."
  const envFetchDate = appliedQuery?.date || lastCompletedHourDateISO(city);
  const envFetchTime = appliedQuery?.date ? (appliedQuery.time || '12:00') : lastCompletedHourHHMM(city);

  // Must reset whenever the WINDOW being shown changes, not just when the
  // city changes — otherwise switching Heat Map to a different date/time
  // (for the same city) left this card silently showing a manually-
  // fetched result for the OLD window, still labeled "freshly fetched" as
  // if it matched what's on screen now. Depending on the primitive
  // appliedQuery fields (not the object itself, which gets a new
  // reference on every entry update) so this only fires when the actual
  // window changes.
  useEffect(() => {
    setManualEnvParams(null);
    setEnvFetchError(null);
  }, [city.id, appliedQuery?.date, appliedQuery?.time, appliedQuery?.endTime, appliedQuery?.endDate, appliedQuery?.filterType]);

  const fetchEnvironmentalFactors = () => {
    setEnvFetchLoading(true);
    setEnvFetchError(null);
    // The date/hour this card is ACTUALLY showing right now — never
    // "today"/"current hour" when a real window is on screen, even a past
    // or future one. `appliedQuery.time` covers filterType 1 (single
    // hour) and 2 (hour range, where `time` is the range's start); a full
    // day (3) or day range (4) has no single hour at all, so this falls
    // back to noon of THAT shown date — not lastCompletedHourHHMM(city),
    // which is today's last-completed hour and would silently graft
    // "right now" onto a possibly-unrelated date. Only when NOTHING has
    // been generated yet for this city (hasData is false, appliedQuery is
    // null) does "current" mean anything, since there's no shown window
    // to match instead.
    const date = envFetchDate;
    const time = envFetchTime;
    // `temperature` mirrors scheduler.py's own env_payload — FortyGuard's
    // Environmental Parameters endpoint takes it as an input, not an
    // output, so it's sourced from whatever heatmap mean is already on
    // screen for THIS SAME window (or the same 25°C fallback
    // scheduler.py uses when none exists yet).
    const temperature = stats?.mean ?? 25;
    postEnvParams({
      latitude: city.lat,
      longitude: city.lon,
      temperature,
      date,
      time,
      filter_type: 1,
    })
      .then((r) => setManualEnvParams(r))
      .catch((err) => setEnvFetchError(err.message || String(err)))
      .finally(() => setEnvFetchLoading(false));
  };

  return (
    <div className="p-4 sm:p-8 max-w-7xl mx-auto space-y-6 sm:space-y-8 text-ink font-sans">
      <EmergencyBanner city={city} onNavigateTab={onNavigateTab} />

      <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-ink tracking-tight">Live Heat Intelligence</h1>
          {hasData && appliedQuery ? (
            <p className="text-xs text-inkfaint font-mono mt-1 flex items-center gap-1.5 flex-wrap">
              <Clock className="w-3 h-3" />
              {describeWindow(appliedQuery)}
              {fetchedAt && <span className="text-inkfaint/70">· generated {timeAgo(fetchedAt)}</span>}
            </p>
          ) : (
            <p className="text-xs text-inkfaint font-mono mt-1">No heatmap generated yet for {city.name}.</p>
          )}
        </div>
        <button onClick={() => onNavigateTab('heatmap')} className="px-3 py-2 bg-orange-500/20 hover:bg-orange-500/30 border border-orange-500/40 text-orange-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 cursor-pointer shrink-0">
          <Zap className="w-3.5 h-3.5" /> {hasData ? 'Generate a different window' : 'Generate in Heat Map'}
        </button>
      </div>

      {/* Sections always render — never a single vague placeholder box
          instead of the real Overview layout. Each metric independently
          shows "—" plus a small note when there's simply nothing to show
          yet, exactly like every other missing-reading case already
          handled below (unavailable individual fields, empty tiles, etc). */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Temperature card, from whatever heatmap was last generated */}
        <div className="lg:col-span-6 p-6 sm:p-8 rounded-[2rem] bg-gradient-to-b from-surface2 to-surface border border-borderstrong shadow-2xl relative overflow-hidden">
          <div className="uppercase text-[11px] tracking-[0.2em] text-inkmuted mb-4 font-bold flex items-center justify-between flex-wrap gap-2">
            <span>Area Mean Temperature</span>
            <span className="text-inkfaint font-mono text-[10px] flex items-center gap-1 font-medium">
              <MapPin className="w-3 h-3 text-orange-400" />
              {city.name}, {city.state}
            </span>
          </div>

          <div className="flex items-start">
            <span className="text-[64px] sm:text-[90px] leading-none font-black text-transparent bg-clip-text bg-gradient-to-b from-ink to-inkfaint">
              {stats?.mean != null ? formatTemp(stats.mean, unit, 1).replace(`°${unit}`, '') : '—'}°
            </span>
            <span className="text-3xl sm:text-4xl mt-1 sm:mt-2 font-bold text-inkmuted">{unit}</span>
          </div>

          {!hasData && (
            <p className="text-[11px] text-inkfaint font-mono mt-1">
              Generate a heatmap in the Heat Map tab — it'll show up here labeled with its date and hour.
            </p>
          )}

          {hasData && heatmap?.stats_data?.empty && (
            <p className="text-[11px] text-amber-400/90 font-mono mt-1 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" /> FortyGuard returned no tiles for this area/hour — not an error, just nothing to report for that exact window.
            </p>
          )}

          <div className="mt-4 flex items-center gap-4 sm:gap-6 flex-wrap">
            <div className="flex flex-col">
              <span className="text-xs text-inkfaint uppercase tracking-wider font-semibold">Peak (max tile)</span>
              <span className="text-2xl font-bold text-orange-400">{formatTemp(stats?.maximum, unit, 1)}</span>
            </div>
            <div className="h-8 w-px bg-surface2" />
            <div className="flex flex-col">
              <span className="text-xs text-inkfaint uppercase tracking-wider font-semibold">Coolest tile</span>
              <span className="text-2xl font-bold text-inksoft">{formatTemp(stats?.minimum, unit, 1)}</span>
            </div>
            <div className="h-8 w-px bg-surface2" />
            <div className="flex flex-col">
              <span className="text-xs text-inkfaint uppercase tracking-wider font-semibold">Std Dev</span>
              <span className="text-2xl font-bold text-inksoft">{formatNumber(stats?.standard_deviation, 2)}</span>
            </div>
          </div>

          {/* Same Coolest/Mean/Peak numbers as above, as a quick visual read */}
          {hasData && stats && (
            <div className="mt-6 pt-4 border-t border-border/60">
              <SimpleBarChart
                decimals={1}
                unit={`°${unit}`}
                bars={[
                  { label: 'Coolest', value: displayTemp(stats?.minimum, unit), colorClass: 'from-sky-500 to-sky-400' },
                  { label: 'Mean', value: displayTemp(stats?.mean, unit), colorClass: 'from-inkfaint to-inksoft' },
                  { label: 'Peak', value: displayTemp(stats?.maximum, unit), colorClass: 'from-orange-500 to-orange-400' },
                ]}
              />
            </div>
          )}

          <div className="mt-8 flex items-center justify-between pt-4 border-t border-border/80">
            <span className="text-[10px] font-mono text-inkfaint">Source: FortyGuard Heatmap Generation</span>
            <button onClick={() => onNavigateTab('heatmap')} className="text-xs text-inkmuted hover:text-orange-400 flex items-center gap-1 cursor-pointer font-medium">
              <span>Open full map</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Environmental parameters — shows every field FortyGuard returned
            for that same generated window */}
        <div className="lg:col-span-6 p-6 sm:p-8 rounded-[2rem] bg-surface/80 border border-border shadow-2xl">
          <div className="flex items-center justify-between gap-2 flex-wrap mb-6 pb-2 border-b border-border/60">
            <span className="uppercase text-[11px] tracking-[0.2em] text-inkfaint font-bold">Environmental Parameters</span>
            <div className="flex items-center gap-2">
              <span className="normal-case tracking-normal text-inkfaint/80 font-mono text-[10px]">
                {manualEnvParams
                  ? `freshly fetched · ${envFetchDate} ${envFetchTime}`
                  : hasData && appliedQuery ? describeWindow(appliedQuery) : 'no data yet'}
              </span>
              <button
                onClick={fetchEnvironmentalFactors}
                disabled={envFetchLoading}
                className="px-2.5 py-1.5 rounded-lg bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 text-[10px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 shrink-0"
                title="Fetch environmental factors for this city/date/hour (cached — repeat clicks are free)"
              >
                <RefreshCw className={`w-3 h-3 ${envFetchLoading ? 'animate-spin' : ''}`} />
                {envFetchLoading ? 'Fetching…' : 'Fetch Environmental Factors'}
              </button>
            </div>
          </div>
          {envFetchError && (
            <p className="text-[10px] font-mono text-red-400 mb-4 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3 shrink-0" /> {envFetchError}
            </p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {ENV_PARAM_FIELDS.map((f) => {
              const raw = params[f.key]?.[0];
              const missing = raw == null || raw === -999;
              const value = missing
                ? null
                : f.kind === 'temp'
                  ? formatTemp(raw, unit, 1)
                  : formatNumber(raw, 0, f.unit || '');
              return <MetricCard key={f.key} label={f.label} value={value} />;
            })}
            <MetricCard label="Solar GHI" value={formatNumber(solar?.ghi, 0, ' W/m²')} />
            <MetricCard label="Solar DNI" value={formatNumber(solar?.dni, 0, ' W/m²')} />
            <MetricCard label="Solar DHI" value={formatNumber(solar?.dhi, 0, ' W/m²')} />
            <MetricCard label="Elevation" value={formatNumber(loc?.elevation, 0, ' m')} />
          </div>
          <p className="text-[10px] font-mono text-inkfaint mt-4">Source: FortyGuard Environmental Parameters · unavailable readings shown as —</p>
        </div>
      </div>

      {/* Phase 8 — deterministic Heat Risk Score, reads Phase 5's
          location_features for whichever date is currently shown above.
          Deliberately NO fallback to today here — matches exactly how
          the Temperature and Environmental Parameters cards behave: this
          shows data for whatever was actually generated (appliedQuery),
          full stop. If nothing's been generated yet this session,
          appliedQuery is null/undefined and the card shows its own
          honest "generate a heatmap first" state, same as its siblings —
          it does not proactively reach for today's date on its own,
          because Overview as a whole never shows anything the user
          didn't actually generate. */}
      <RiskScoreCard city={city} date={appliedQuery?.date} refreshToken={riskRefreshToken} />

      {/* Phase 9 — People Impact Score: combines the Risk Score above
          with Phase 6's OSM exposure for this city's AOI. Same
          appliedQuery?.date dependency as RiskScoreCard, since it reads
          the identical location_features row on the heat side. */}
      <ImpactScoreCard city={city} date={appliedQuery?.date} refreshToken={riskRefreshToken} />

      {/* Phase 6 (OSM exposure) + Phase 7 (NWS alerts) — both real, live,
          source-labeled data. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <ExposureCard city={city} onOpenAIAgent={onOpenAIAgent} onNavigateTab={onNavigateTab} />
        <AlertsCard city={city} onNavigateTab={onNavigateTab} />
      </div>
    </div>
  );
};