import React from 'react';
import { ShieldAlert, ShieldCheck, RefreshCw, AlertTriangle } from 'lucide-react';
import { fetchCityAlerts } from '../../api/thermoraApi';
import { getManualAlerts, subscribeManualAlerts, refreshAlerts } from '../../lib/alertsStore';

const SEVERITY_STYLES = {
  Extreme: 'bg-red-500/20 border-red-500/40 text-red-300',
  Severe: 'bg-orange-500/20 border-orange-500/40 text-orange-300',
  Moderate: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
  Minor: 'bg-blue-500/15 border-blue-500/30 text-blue-300',
};

function timeAgo(iso) {
  if (!iso) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// Phase 7 — the VERIFY step: "is this an officially recognized heat
// event?" Deliberately just displays what NWS says, source-labeled, with
// no Thermora-computed opinion layered on top (that's Phase 8's job, not
// built yet — see the narrower PhaseGate elsewhere on this page for that).
//
// This card is mounted in two places at once (Overview + Emergency Mode).
// A manual "Check now" refresh is stored in the shared alertsStore (keyed
// by city.id), not local component state, so both instances stay in sync
// immediately instead of only reconverging on a later background pass.
//
// This used to auto-fetch via useCityLatest(city.id) on mount — but that
// hook reads /api/cities/{id}/latest, which on a cache miss triggers
// scheduler.refresh_city_summary(), a REAL FortyGuard heatmap + env_params
// submission, purely as a side effect of also wanting NWS alerts. Since
// this card only ever displays the `alerts` field from that bundle, it
// was paying for two FortyGuard credits it never used, every time it
// mounted (i.e. every time Dashboard or Emergency Mode rendered). Now it
// fetches alerts directly via GET /api/cities/{id}/alerts, which is
// NWS-only — no FortyGuard involvement at all (see routers/alerts.py).
export function AlertsCard({ city, onNavigateTab, hideEmergencyLink = false }) {
  const [auto, setAuto] = React.useState(null); // { alerts, fetchedAt } | null
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [manual, setManual] = React.useState(() => getManualAlerts(city.id));
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState(null);

  React.useEffect(() => {
    setManual(getManualAlerts(city.id));
    return subscribeManualAlerts(city.id, setManual);
  }, [city.id]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetchCityAlerts(city.id, false)
      .then((result) => {
        if (cancelled) return;
        setAuto({ alerts: result.alerts || [], fetchedAt: result.fetched_at });
      })
      .catch((err) => { if (!cancelled) setLoadError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [city.id]);

  const activeAlerts = manual?.alerts ?? auto?.alerts ?? [];
  const activeFetchedAt = manual?.fetchedAt ?? auto?.fetchedAt ?? null;

  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await refreshAlerts(city.id); // broadcasts to every mounted AlertsCard for this city
    } catch (err) {
      setRefreshError(err.message || String(err));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="p-6 sm:p-8 rounded-[2rem] bg-surface/80 border border-border shadow-2xl">
      <div className="uppercase text-[11px] tracking-[0.2em] text-inkfaint font-bold mb-4 pb-2 border-b border-border/60 flex items-center justify-between">
        <span className="flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5" /> Official NWS Alert Status</span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="normal-case tracking-normal text-inkfaint/80 hover:text-orange-300 font-mono text-[10px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} /> {refreshing ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {loading && !manual && activeAlerts.length === 0 && (
        <p className="text-xs text-inkmuted font-mono">Loading…</p>
      )}

      {loadError && !manual && (
        <p className="text-xs text-red-400 font-mono flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {loadError}</p>
      )}

      {refreshError && (
        <p className="text-xs text-red-400 font-mono flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {refreshError}</p>
      )}

      {!loading && activeAlerts.length === 0 && !refreshError && !loadError && (
        <div className="flex items-center gap-2.5 text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-4 py-3">
          <ShieldCheck className="w-5 h-5 shrink-0" />
          <span className="text-sm font-semibold">No active NWS alerts for this area right now.</span>
        </div>
      )}

      {activeAlerts.length > 0 && (
        <div className="space-y-2.5">
          {activeAlerts.map((a, i) => (
            <div key={i} className={`p-3.5 rounded-xl border ${SEVERITY_STYLES[a.severity] || 'bg-surface2 border-border text-inksoft'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold">{a.alert_type}</span>
                {a.severity && <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-black/20">{a.severity}</span>}
              </div>
              {a.headline && <p className="text-xs mt-1 opacity-90">{a.headline}</p>}
              {a.area_desc && <p className="text-[10px] font-mono mt-1.5 opacity-70">{a.area_desc}</p>}
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] font-mono text-inkfaint mt-4">
        Source: National Weather Service (live) — official, independent of any Thermora estimate
        {activeFetchedAt && <> · updated {timeAgo(activeFetchedAt)}</>}
      </p>
      {!hideEmergencyLink && (
        <button onClick={() => onNavigateTab('emergency')} className="text-xs text-inkmuted hover:text-ink underline mt-3 flex items-center gap-1 cursor-pointer">
          <ShieldAlert className="w-3.5 h-3.5" /> View Emergency Mode status
        </button>
      )}
    </div>
  );
}
