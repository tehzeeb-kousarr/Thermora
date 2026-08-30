import React, { useCallback, useEffect, useState } from 'react';
import { Siren, AlertTriangle, ChevronRight } from 'lucide-react';
import { fetchEmergencyStatus } from '../../api/thermoraApi';
import { getMostRecentForCity, subscribeCity, subscribeRiskFactorsUpdated } from '../../lib/liveDataStore';

// Sits at the very top of Overview, above the page header — the one place
// on the whole dashboard that's impossible to miss. Reads the exact same
// Phase 10 endpoint (emergency_score.compute_emergency_status, via Phase
// 7 alerts + Phase 8 Risk + Phase 9 Impact) EmergencyModeView shows in
// full — this is deliberately just a compact pointer TO that view, not a
// second copy of its logic. Renders nothing at all for NORMAL status:
// a banner that's always visible regardless of severity trains people to
// stop looking at it, which defeats the point for the one time it
// actually matters.
export function EmergencyBanner({ city, onNavigateTab }) {
  const [result, setResult] = useState(null);

  // Same "most recently generated date for this city" the score cards
  // and EmergencyModeView itself already read from — keeps this banner's
  // idea of "current" identical to theirs, not a separate guess.
  const [entry, setEntry] = useState(() => getMostRecentForCity(city.id));
  useEffect(() => {
    setEntry(getMostRecentForCity(city.id));
    setResult(null); // stop showing the previous city's status while the new one loads
    return subscribeCity(city.id, setEntry);
  }, [city.id]);

  const [riskRefreshToken, setRiskRefreshToken] = useState(0);
  useEffect(
    () => subscribeRiskFactorsUpdated(city.id, () => setRiskRefreshToken((v) => v + 1)),
    [city.id]
  );

  const date = entry?.appliedQuery?.date ?? null;

  const load = useCallback(() => {
    if (!date) { setResult(null); return; }
    fetchEmergencyStatus(city.id, date)
      .then(setResult)
      .catch(() => {}); // a banner failing quietly is the right failure mode — EmergencyModeView still shows the real error
  }, [city.id, date]);

  useEffect(() => { load(); }, [load, riskRefreshToken]);

  // Stays current on its own, same 3-minute cadence as EmergencyModeView
  // — someone might sit on Overview all afternoon without ever visiting
  // the Emergency tab directly.
  useEffect(() => {
    const id = setInterval(load, 3 * 60 * 1000);
    return () => clearInterval(id);
  }, [load]);

  if (!result || result.status === 'NORMAL') return null;

  const isEmergency = result.status === 'EMERGENCY';

  return (
    <button
      onClick={() => onNavigateTab('emergency')}
      className={`w-full flex items-center gap-3 sm:gap-4 rounded-2xl border px-4 sm:px-5 py-3 sm:py-4 text-left cursor-pointer transition-all hover:brightness-110 ${
        isEmergency
          ? 'bg-red-500/15 border-red-500/40 animate-pulse'
          : 'bg-amber-500/10 border-amber-500/30'
      }`}
    >
      <div className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 border ${
        isEmergency ? 'bg-red-500/20 border-red-500/40' : 'bg-amber-500/15 border-amber-500/30'
      }`}>
        {isEmergency
          ? <Siren className="w-5 h-5 text-red-300" />
          : <AlertTriangle className="w-5 h-5 text-amber-300" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-black tracking-tight ${isEmergency ? 'text-red-300' : 'text-amber-300'}`}>
          {isEmergency ? 'Active Heat Emergency' : 'Elevated Heat Conditions — Watching'}
        </div>
        <div className="text-[11px] text-inkmuted font-mono mt-0.5 truncate">
          {result.reasons?.[0]?.detail || result.status_label}
        </div>
      </div>
      <span className={`shrink-0 text-xs font-semibold flex items-center gap-1 ${isEmergency ? 'text-red-300' : 'text-amber-300'}`}>
        {isEmergency ? 'Respond now' : 'View details'} <ChevronRight className="w-3.5 h-3.5" />
      </span>
    </button>
  );
}