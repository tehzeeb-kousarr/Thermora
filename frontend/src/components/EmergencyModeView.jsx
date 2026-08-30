import React, { useEffect, useState, useCallback } from 'react';
import {
  ShieldAlert, RefreshCw, AlertTriangle, CheckCircle2, Siren,
  School, Cross, Building2, Megaphone, Clock3, Sparkles, Check, MapPin,
} from 'lucide-react';
import { AlertsCard } from './dashboard/AlertsCard';
import { fetchEmergencyStatus, fetchCityAlerts, fetchHeatStory } from '../api/thermoraApi';
import { RISK_COLOR_CLASSES as COLOR_CLASSES } from '../lib/riskColors';
import { formatNumber, formatTemp, cToF } from '../lib/thermalFormat';
// Phase 10 fix — same three liveDataStore helpers DashboardView already
// uses for RiskScoreCard/ImpactScoreCard. Emergency Mode was previously
// calling fetchEmergencyStatus(city.id) with no date, silently defaulting
// to the backend's date.today() regardless of what the user is actually
// looking at elsewhere in the app. Reading from the same shared store
// keeps this view's date/refresh signal identical to the score cards'.
import { getMostRecentForCity, subscribeCity, subscribeRiskFactorsUpdated } from '../lib/liveDataStore';

const STATUS_ICON = { EMERGENCY: Siren, WATCH: AlertTriangle, NORMAL: CheckCircle2 };

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2 };
const PRIORITY_META = {
  P1: { label: 'Immediate', classes: 'bg-red-500/15 border-red-500/30 text-red-300' },
  P2: { label: 'Urgent', classes: 'bg-orange-500/15 border-orange-500/30 text-orange-300' },
  P3: { label: 'Near-term', classes: 'bg-amber-500/15 border-amber-500/30 text-amber-300' },
};

function ScoreChip({ label, score, level, color }) {
  // Phase 10 fix — neutral fallback instead of emerald (safe green) when
  // a color is missing; this chip renders Risk/Impact status, so a silent
  // "all clear" default here is exactly backwards.
  const c = COLOR_CLASSES[color] || COLOR_CLASSES.slate;
  return (
    <div className={`px-3 py-1.5 rounded-xl border text-xs font-mono ${c.bg}`}>
      <span className="text-inkfaint uppercase tracking-wide mr-1.5">{label}</span>
      <span className={`font-bold ${c.text}`}>
        {score == null ? 'n/a' : `${score}/100`}
      </span>
      {level && <span className="text-inkfaint ml-1.5">({level})</span>}
    </div>
  );
}

// Compact score gauge, same visual language as ImpactScoreCard's — used
// here twice (Risk + Impact side by side) so the two numbers driving the
// whole page are the most visually prominent thing on it, not buried in
// a text chip.
function MiniGauge({ label, score, level, color }) {
  const c = COLOR_CLASSES[color] || COLOR_CLASSES.slate;
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const offset = score == null ? circumference : circumference * (1 - score / 100);
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-20 h-20 shrink-0">
        <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
          <circle cx="50" cy="50" r={radius} fill="none" strokeWidth="9" className="stroke-surface2" />
          {score != null && (
            <circle
              cx="50" cy="50" r={radius} fill="none" strokeWidth="9" strokeLinecap="round"
              className={c.ring} strokeDasharray={circumference} strokeDashoffset={offset}
              style={{ transition: 'stroke-dashoffset 0.6s ease' }}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-xl font-black ${c.text}`}>{score ?? '—'}</span>
        </div>
      </div>
      <div>
        <div className="text-[11px] text-inkfaint font-mono uppercase tracking-wide">{label}</div>
        <div className={`text-sm font-bold ${c.text}`}>{level || 'No data'}</div>
      </div>
    </div>
  );
}

// Top 2 breakdown factors from a score's `breakdown` list — enough to
// answer "why is this number what it is" at a glance.
function TopFactors({ breakdown }) {
  if (!breakdown?.length) return null;
  const top = [...breakdown].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).slice(0, 2);
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {top.map((f) => (
        <span key={f.key} className="px-2 py-1 rounded-lg bg-app/70 border border-border text-[10px] font-mono text-inksoft">
          {f.label}: {formatNumber(f.raw_value, f.key === 'heat_risk' ? 1 : 0)}{f.unit || ''}
        </span>
      ))}
    </div>
  );
}

function formatAlertTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return null;
  }
}

// The official NWS alert this status was (partly) triggered by — headline,
// description, area, and active window, not just a "there's an alert" chip.
function OfficialAlertBox({ alert }) {
  if (!alert) return null;
  const from = formatAlertTime(alert.active_from);
  const to = formatAlertTime(alert.active_to);
  return (
    <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/30">
      <div className="flex items-center gap-2 text-[10px] font-mono uppercase text-red-300/90 tracking-wide">
        <Megaphone className="w-3.5 h-3.5" /> Official NWS Alert — {alert.severity}
      </div>
      <div className="text-sm font-bold text-ink mt-1.5">{alert.headline || alert.alert_type}</div>
      {alert.description && (
        <p className="text-[11px] text-inkmuted mt-1.5 leading-relaxed line-clamp-4">{alert.description}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[10px] text-inkfaint font-mono">
        {alert.area_desc && <span>{alert.area_desc}</span>}
        {(from || to) && (
          <span className="flex items-center gap-1"><Clock3 className="w-3 h-3" /> {from || '—'} → {to || 'until further notice'}</span>
        )}
      </div>
    </div>
  );
}

// Local-only tracking of which recommended actions an operator has
// personally started/finished — deliberately NOT a "dispatch" or
// "broadcast" simulation. This app has no SMS/notification/paging
// integration; pretending a click here notified anyone would be actively
// misleading. This is a checklist for a human, nothing more.
// Scoped per city + today's local calendar date — Emergency Mode has no
// date parameter of its own (it's always "right now"), so a new day
// naturally starts a fresh ack list rather than carrying over
// acknowledgments against what will be a differently-worded action set
// anyway (see key-by-text below).
function ackStorageKey(cityId) {
  return `thermora:ackedActions:${cityId}:${new Date().toISOString().slice(0, 10)}`;
}

// Keyed by the action's own text rather than array index — the previous
// version tracked acknowledgment by position in the sorted list, which
// silently pointed at the WRONG action the moment a refresh reordered or
// regenerated the list (e.g. a P2 resolving and a P3 taking its slot).
// Text is a stable-enough identity here since the same real underlying
// condition (checked in emergency_score.py's _build_actions) always
// produces the same action text.
function loadAcked(cityId) {
  try {
    const raw = localStorage.getItem(ackStorageKey(cityId));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function TacticalPlan({ actions, onOpenAIAgent, cityName, cityId }) {
  const [acked, setAcked] = useState(() => loadAcked(cityId));

  // Re-load whenever the city changes (switching cities shouldn't carry
  // over another city's acknowledgments).
  useEffect(() => {
    setAcked(loadAcked(cityId));
  }, [cityId]);

  const toggle = (actionText) => setAcked((prev) => {
    const next = new Set(prev);
    next.has(actionText) ? next.delete(actionText) : next.add(actionText);
    try {
      localStorage.setItem(ackStorageKey(cityId), JSON.stringify([...next]));
    } catch {
      // Personal convenience feature only — a full localStorage or
      // private-browsing mode just means acks don't persist this
      // session, not a reason to break the tactical plan itself.
    }
    return next;
  });

  const sorted = [...(actions || [])].sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));

  return (
    <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl flex flex-col">
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <div>
          <span className="text-xs font-mono font-semibold uppercase text-orange-400">{cityName}</span>
          <h3 className="text-base font-bold text-ink mt-0.5">Tactical Action Plan</h3>
        </div>
        {onOpenAIAgent && (
          <button
            onClick={() => onOpenAIAgent(`Is there an active heat emergency in ${cityName} right now, and what should I do?`)}
            className="px-3.5 py-2 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5 text-orange-400" /> Ask agent
          </button>
        )}
      </div>

      {!sorted.length && (
        <p className="text-xs text-inkmuted font-mono mt-4">No status elevated enough to require action right now.</p>
      )}

      <div className="space-y-2.5 mt-4">
        {sorted.map((a) => (
          <div
            key={a.action}
            onClick={() => toggle(a.action)}
            className={`p-4 rounded-2xl border flex items-start gap-3 transition-all cursor-pointer ${
              acked.has(a.action) ? 'bg-emerald-950/30 border-emerald-500/50' : 'bg-app/60 border-border hover:border-borderstrong'
            }`}
          >
            <div className={`w-5 h-5 rounded-lg flex items-center justify-center mt-0.5 shrink-0 ${
              acked.has(a.action) ? 'bg-emerald-500 text-zinc-950' : 'border border-borderstrong'
            }`}>
              {acked.has(a.action) && <Check className="w-3.5 h-3.5 stroke-[3]" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className={`font-bold text-xs ${acked.has(a.action) ? 'text-inkmuted line-through decoration-emerald-500/50' : 'text-ink'}`}>{a.action}</span>
                <span className={`shrink-0 px-1.5 py-0.5 rounded-md text-[9px] font-mono font-bold border ${PRIORITY_META[a.priority]?.classes || PRIORITY_META.P3.classes}`}>
                  {a.priority}
                </span>
              </div>
              <p className="text-xs text-inksoft mt-1">{a.why}</p>
            </div>
          </div>
        ))}
      </div>

      {sorted.length > 0 && (
        <div className="pt-4 border-t border-border mt-5 flex items-center justify-between text-xs">
          <span className="text-inkmuted">
            {acked.size} of {sorted.length} actions marked in progress
            <span className="block text-[10px] text-inkfaint mt-0.5">Personal tracking only — saved on this device, nothing here is transmitted to anyone.</span>
          </span>
        </div>
      )}
    </div>
  );
}

// Real schools/hospitals from Phase 6's OSM exposure data — name, type,
// and coordinates only. The mockup example showed capacity, "HVAC
// Operational" status, and a phone number per facility; OSM doesn't
// reliably provide any of those for most entries, and this app has no
// separate facilities database, so none of that is shown here — inventing
// it would be actively worse than not having it.
function VulnerableAssets({ sites, cityName }) {
  if (!sites?.length) return null;
  const ICON = { school: School, hospital: Cross };
  return (
    <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
      <div className="flex items-center justify-between pb-4 border-b border-border">
        <div>
          <h3 className="text-base font-bold text-ink">Vulnerable Sites (OSM Layer)</h3>
          <p className="text-xs text-inkmuted mt-0.5">
            Schools and hospitals Phase 6's OSM data found within {cityName}'s scored area
          </p>
        </div>
        <span className="text-xs font-mono text-inkmuted shrink-0">{sites.length} sites</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-4">
        {sites.map((s, i) => {
          const Icon = ICON[s.type] || Building2;
          return (
            <a
              key={i}
              href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`}
              target="_blank"
              rel="noreferrer"
              className="p-3.5 rounded-2xl bg-app/60 border border-border/80 flex items-start gap-2.5 hover:border-borderstrong transition-all"
            >
              <Icon className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-[9px] font-mono uppercase text-inkfaint">{s.type}</div>
                <div className="font-semibold text-ink text-xs truncate">{s.name || 'Unnamed on OSM'}</div>
                <div className="text-[10px] text-inkfaint font-mono flex items-center gap-1 mt-0.5">
                  <MapPin className="w-2.5 h-2.5" /> {Number(s.lat).toFixed(4)}, {Number(s.lon).toFixed(4)}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

// "Next level" addition — a single chronological view combining the
// three things this tab otherwise shows in separate, disconnected cards:
// real NWS alert windows (active_from/active_to, straight from
// nws_client.py), real Heat Story observed hourly readings (Postgres-
// only, same GET /api/heat-story/{city} the Heat Story tab itself uses),
// and the current Emergency status. The only "event" this component adds
// that isn't a direct read of stored data is a threshold-crossing marker
// — and even that is computed here from real per-hour temperatures
// against the person's own configured thresholds (userSettings), not an
// invented milestone; Heat Story deliberately has no per-hour "notes"
// field to fabricate one from (see HeatStoryView's own history on this).
function hourToTodayDate(hour) {
  const [h, m] = hour.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m || 0, 0, 0);
  return d;
}

function ActiveTimeline({ city, userSettings }) {
  const [alerts, setAlerts] = useState([]);
  const [heatStory, setHeatStory] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetchCityAlerts(city.id).catch(() => ({ alerts: [] })),
      fetchHeatStory(city.id).catch(() => null),
    ]).then(([alertsResult, storyResult]) => {
      if (cancelled) return;
      setAlerts(alertsResult.alerts || []);
      setHeatStory(storyResult);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [city.id]);

  const events = React.useMemo(() => {
    const list = [];
    for (const a of alerts) {
      if (!a.active_from) continue;
      list.push({
        time: new Date(a.active_from),
        kind: 'alert',
        badge: 'NWS',
        badgeColor: 'red',
        label: a.alert_type,
        detail: a.headline,
      });
    }
    if (heatStory?.observed && userSettings) {
      const warnF = userSettings.warningThreshold;
      const emergF = userSettings.emergencyThreshold;
      let wasWarn = false;
      let wasEmerg = false;
      for (const o of heatStory.observed) {
        if (!o.exists || o.temperature == null) continue;
        const f = cToF(o.temperature);
        if (f >= emergF && !wasEmerg) {
          list.push({
            time: hourToTodayDate(o.hour), kind: 'threshold', badge: 'THRESHOLD', badgeColor: 'red',
            label: `Crossed Emergency threshold (${emergF}°F)`,
            detail: `${o.hour} observed — ${formatTemp(o.temperature, 'F', 1)}`,
          });
        } else if (f >= warnF && !wasWarn) {
          list.push({
            time: hourToTodayDate(o.hour), kind: 'threshold', badge: 'THRESHOLD', badgeColor: 'amber',
            label: `Crossed Warning threshold (${warnF}°F)`,
            detail: `${o.hour} observed — ${formatTemp(o.temperature, 'F', 1)}`,
          });
        }
        wasWarn = wasWarn || f >= warnF;
        wasEmerg = wasEmerg || f >= emergF;
      }
    }
    return list.sort((a, b) => a.time - b.time);
  }, [alerts, heatStory, userSettings]);

  if (loading) {
    return <p className="text-xs text-inkmuted font-mono flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Building timeline…</p>;
  }
  if (!events.length) {
    return <p className="text-xs text-inkmuted font-mono">No NWS alerts or threshold crossings recorded for today yet.</p>;
  }

  return (
    <div className="space-y-0">
      {events.map((e, i) => {
        const c = COLOR_CLASSES[e.badgeColor] || COLOR_CLASSES.slate;
        return (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${c.dot}`} />
              {i < events.length - 1 && <span className="w-px flex-1 bg-border/60 my-0.5" />}
            </div>
            <div className="pb-4 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-mono text-inkfaint">
                  {e.time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </span>
                <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full border ${c.bg} ${c.text}`}>{e.badge}</span>
                <span className="text-xs font-bold text-ink">{e.label}</span>
              </div>
              {e.detail && <p className="text-[11px] text-inksoft mt-1">{e.detail}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Phase 10 — Heat Emergency Mode. Reads the deterministic, rules-based
// trigger computed server-side by emergency_score.compute_emergency_status
// (Phase 7 alerts + Phase 8 Risk + Phase 9 Impact) — this component does
// no scoring of its own, it only renders what the backend already decided
// and explains why.
export const EmergencyModeView = ({ city, userSettings, onOpenAIAgent, onSelectCity }) => {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastChecked, setLastChecked] = useState(null);

  // Phase 10 fix — same pattern DashboardView uses for RiskScoreCard /
  // ImpactScoreCard: read the most recently generated date for this city
  // from the shared store, and re-subscribe to cross-tab risk-factor
  // updates (e.g. a riskBoost fetch completing on the Heat Map tab).
  const [entry, setEntry] = useState(() => getMostRecentForCity(city.id));
  useEffect(() => {
    setEntry(getMostRecentForCity(city.id));
    return subscribeCity(city.id, setEntry);
  }, [city.id]);

  const [riskRefreshToken, setRiskRefreshToken] = useState(0);
  useEffect(
    () => subscribeRiskFactorsUpdated(city.id, () => setRiskRefreshToken((v) => v + 1)),
    [city.id]
  );

  const date = entry?.appliedQuery?.date ?? null;

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchEmergencyStatus(city.id, date)
      .then((r) => { setResult(r); setLastChecked(new Date()); })
      .catch((err) => setError(err.message || String(err)))
      .finally(() => setLoading(false));
  }, [city.id, date]);

  useEffect(() => {
    load();
  }, [load, riskRefreshToken]);

  // Phase 10 fix — "Emergency Mode" shouldn't require a manual click to
  // stay current. Re-check every 3 minutes on its own.
  useEffect(() => {
    const id = setInterval(load, 3 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  const StatusIcon = result ? STATUS_ICON[result.status] || ShieldAlert : ShieldAlert;
  // Phase 10 fix — neutral fallback instead of emerald (safe green).
  const statusColorClasses = result ? COLOR_CLASSES[result.color] || COLOR_CLASSES.slate : COLOR_CLASSES.slate;
  const isEmergency = result?.status === 'EMERGENCY';
  const exposureCounts = result?.impact_score_detail?.exposure_counts;
  const hasOperator = !!(userSettings?.userName || userSettings?.role || userSettings?.organization);

  return (
    <div className="p-4 sm:p-8 max-w-6xl mx-auto space-y-6 text-ink font-sans">
      {/* Command header — colored by the REAL current status, not always
          red. The mockup's banner assumed Emergency was always active; a
          command header that's dramatic even when status is Watch or
          Normal trains people to ignore it. */}
      <div className={`rounded-[2rem] p-6 shadow-2xl relative overflow-hidden backdrop-blur-md border ${
        isEmergency
          ? 'bg-gradient-to-r from-red-950/80 via-surface/90 to-red-950/80 border-red-500/50'
          : 'bg-surface/90 border-border'
      }`}>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start md:items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border ${
              isEmergency ? 'bg-red-500/20 border-red-400/50 text-red-400 animate-pulse' : `${statusColorClasses.bg} ${statusColorClasses.text}`
            }`}>
              <StatusIcon className="w-7 h-7" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] font-mono font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full ${
                  isEmergency ? 'bg-red-500 text-white' : `${statusColorClasses.bg} ${statusColorClasses.text}`
                }`}>
                  {result?.status_label || 'Checking…'}
                </span>
                {result?.triggered_by_official_alert && (
                  <span className="text-xs text-red-300 font-mono">Official NWS alert active</span>
                )}
              </div>
              <h2 className="text-2xl font-black text-ink tracking-tight mt-1">
                Emergency Response — {city.name}
              </h2>
              {hasOperator ? (
                <p className="text-xs text-inksoft mt-1">
                  Operational authority: <strong>{userSettings.userName || 'Unnamed'}</strong>
                  {(userSettings.role || userSettings.organization) && (
                    <> ({[userSettings.role, userSettings.organization].filter(Boolean).join(' — ')})</>
                  )}
                </p>
              ) : (
                <p className="text-[11px] text-inkfaint font-mono mt-1">Add your name/role in Settings to show it here.</p>
              )}
            </div>
          </div>

          <button
            onClick={load}
            disabled={loading}
            className="px-4 py-2.5 rounded-xl border border-border hover:bg-surface2/60 text-inkfaint hover:text-ink transition-all cursor-pointer disabled:opacity-50 flex items-center gap-2 text-xs font-semibold shrink-0"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Re-check status
          </button>
        </div>

        {lastChecked && (
          <p className="text-[10px] text-inkfaint font-mono mt-4">Last checked {lastChecked.toLocaleTimeString()}</p>
        )}
        {error && (
          <p className="text-xs text-red-400 font-mono flex items-center gap-1.5 mt-2">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
            {result && ' — showing last known status below, may be stale.'}
          </p>
        )}
      </div>

      {result && (
        <>
          {/* Score summary — gauges + top factors + real exposure counts,
              everything the endpoint already returns. */}
          <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
            <div className="flex flex-wrap gap-2 mb-5">
              <ScoreChip label="Risk" score={result.risk_score} level={result.risk_level} color={result.risk_score_detail?.color || 'emerald'} />
              <ScoreChip label="Impact" score={result.impact_score} level={result.impact_level} color={result.impact_score_detail?.color || 'emerald'} />
            </div>
            <div className="grid sm:grid-cols-2 gap-5">
              {result.risk_score_detail && (
                <div>
                  <MiniGauge label="Heat Risk" score={result.risk_score} level={result.risk_level} color={result.risk_score_detail.color} />
                  <TopFactors breakdown={result.risk_score_detail.breakdown} />
                </div>
              )}
              {result.impact_score_detail && (
                <div>
                  <MiniGauge label="People Impact" score={result.impact_score} level={result.impact_level} color={result.impact_score_detail.color} />
                  <TopFactors breakdown={result.impact_score_detail.breakdown} />
                  {exposureCounts && (
                    <div className="flex items-center gap-3 mt-2 text-[11px] text-inksoft">
                      <span className="flex items-center gap-1"><School className="w-3 h-3 text-orange-400" /> {exposureCounts.schools}</span>
                      <span className="flex items-center gap-1"><Cross className="w-3 h-3 text-orange-400" /> {exposureCounts.hospitals}</span>
                      <span className="flex items-center gap-1"><Building2 className="w-3 h-3 text-orange-400" /> {formatNumber(exposureCounts.buildings, 0)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            {result.official_alert && <div className="mt-5"><OfficialAlertBox alert={result.official_alert} /></div>}
            {result.reasons?.length > 0 && (
              <div className="mt-5 pt-5 border-t border-border/40">
                <div className="text-[10px] text-inkmuted font-mono uppercase mb-2">
                  Why is this {result.status_label}?
                </div>
                <ul className="space-y-1.5">
                  {result.reasons.map((r, i) => (
                    <li key={i} className="text-xs text-inksoft leading-relaxed">
                      <span className="text-inkfaint font-mono mr-1.5">•</span>{r.detail}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Unified timeline — the "next level" addition combining NWS
              alerts + real threshold-crossing moments from today's Heat
              Story observations, previously only visible split across
              separate cards with no shared chronology. */}
          <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl">
            <div className="flex items-center gap-2 pb-4 border-b border-border">
              <Clock3 className="w-4 h-4 text-orange-400" />
              <h3 className="text-base font-bold text-ink">Today's Timeline</h3>
            </div>
            <div className="mt-4">
              <ActiveTimeline city={city} userSettings={userSettings} />
            </div>
          </div>

          {/* Tactical Plan gets its own full-width row — the thing an
              operator actually needs to act on, not squeezed to
              half-width next to Priority Ranking. */}
          <TacticalPlan actions={result.actions} onOpenAIAgent={onOpenAIAgent} cityName={city.name} cityId={city.id} />

          <VulnerableAssets sites={result.vulnerable_sites} cityName={city.name} />
        </>
      )}

      {/* Raw NWS alert detail — same card used on the Overview tab, kept
          here too since Emergency Mode is where an operator will most
          want the underlying official source, not just Thermora's
          derived status above. */}
      <AlertsCard city={city} onNavigateTab={() => {}} hideEmergencyLink />
    </div>
  );
};