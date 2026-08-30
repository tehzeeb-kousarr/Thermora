import React from 'react';
import { Users, School, Cross, Building2, Route, RefreshCw, AlertTriangle, Lock, ArrowRight } from 'lucide-react';
import { useExposure } from '../../hooks/useExposure';
import { defaultBBoxForCity } from '../../data/cities';
import { formatNumber } from '../../lib/thermalFormat';

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="p-3 bg-app/70 rounded-xl border border-border flex items-center gap-2.5">
      <Icon className="w-4 h-4 text-orange-400 shrink-0" />
      <div className="min-w-0">
        <div className="text-lg font-black text-ink leading-none">{value ?? '—'}</div>
        <div className="text-[10px] text-inkmuted font-mono uppercase truncate">{label}</div>
      </div>
    </div>
  );
}

// Phase 6 — "who/what is exposed", raw structured retrieval only. This
// card intentionally stays honest counts, not a risk assessment — Phase 9
// (People Impact Score, see ImpactScoreCard above on the Dashboard)
// is what combines this data with the Heat Risk Score.
export function ExposureCard({ city, onOpenAIAgent, onNavigateTab }) {
  const bbox = defaultBBoxForCity(city);
  const { points, density, fetchedAt, source, loading, error, refresh } = useExposure(bbox);
  const fromSeedFile = source === 'seed_file';
  const [refreshing, setRefreshing] = React.useState(false);

  const schools = points.filter((p) => p.type === 'school').length;
  const hospitals = points.filter((p) => p.type === 'hospital').length;

  const handleRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  return (
    <div className="p-6 sm:p-8 rounded-[2rem] bg-surface/80 border border-border shadow-2xl">
      <div className="uppercase text-[11px] tracking-[0.2em] text-inkfaint font-bold mb-4 pb-2 border-b border-border/60 flex items-center justify-between">
        <span className="flex items-center gap-2"><Users className="w-3.5 h-3.5" /> Nearby Exposure (OSM)</span>
        <button
          onClick={handleRefresh}
          disabled={refreshing || loading}
          className="normal-case tracking-normal text-inkfaint/80 hover:text-orange-300 font-mono text-[10px] flex items-center gap-1 cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${refreshing || loading ? 'animate-spin' : ''}`} /> {loading ? 'Fetching…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <p className="text-xs text-red-400 font-mono flex items-center gap-1.5 mb-3"><AlertTriangle className="w-3.5 h-3.5" /> {error}</p>
      )}

      <div className="grid grid-cols-2 gap-2.5">
        <Stat icon={School} label="Schools" value={schools} />
        <Stat icon={Cross} label="Hospitals / Clinics" value={hospitals} />
        <Stat icon={Building2} label="Buildings" value={density ? formatNumber(density.building_count, 0) : null} />
        <Stat icon={Route} label="Roads" value={density ? formatNumber(density.road_count, 0) : null} />
      </div>

      {/* These counts are anonymous by design (see the honesty note
          below) — the actual named sites already exist one tab over, in
          Emergency Mode's own VulnerableAssets section (real OSM
          name/type data, not duplicated here). Point there instead of
          re-building a second naming/map UI for the same underlying
          data. */}
      {onNavigateTab && (schools > 0 || hospitals > 0) && (
        <button
          onClick={() => onNavigateTab('emergency')}
          className="w-full mt-2.5 flex items-center justify-between gap-2 p-2.5 rounded-xl bg-app/50 border border-border hover:border-orange-500/40 hover:bg-orange-500/5 transition-all cursor-pointer group"
        >
          <span className="text-[11px] text-inksoft font-semibold">
            See the {schools + hospitals} named site{schools + hospitals === 1 ? '' : 's'} in Emergency
          </span>
          <ArrowRight className="w-3.5 h-3.5 text-inkfaint group-hover:text-orange-400 group-hover:translate-x-0.5 transition-all shrink-0" />
        </button>
      )}

      <div className="flex items-start gap-2 mt-4 p-3 rounded-xl bg-surface2/60 border border-border">
        <Lock className="w-3.5 h-3.5 text-inkmuted mt-0.5 shrink-0" />
        <p className="text-[11px] text-inkmuted">
          This is the raw inventory, not a risk assessment — see the <span className="text-inksoft font-semibold">People Impact Score</span> card
          above for how this combines with the <span className="text-inksoft font-semibold">Heat Risk Score</span> into one priority number.
        </p>
      </div>

      <p className="text-[10px] font-mono text-inkfaint mt-3">
        Source: {fromSeedFile ? 'Offline seed file (Overpass unavailable when last tried)' : 'OpenStreetMap / Overpass'} (~2.2km AOI around {city.name}){fetchedAt && <> · fetched {new Date(fetchedAt).toLocaleDateString()}</>}
      </p>
      <button onClick={() => onOpenAIAgent()} className="text-xs text-orange-400 hover:text-orange-300 underline mt-3 cursor-pointer">
        Ask the agent about this location instead
      </button>
    </div>
  );
}