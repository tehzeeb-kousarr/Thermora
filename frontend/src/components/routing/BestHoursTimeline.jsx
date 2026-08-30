import React, { useEffect, useState } from 'react';
import { Sun, RefreshCw, AlertTriangle } from 'lucide-react';
import { fetchBestHours } from '../../api/thermoraApi';
import { formatTemp } from '../../lib/thermalFormat';
import { RISK_COLOR_CLASSES } from '../../lib/riskColors';

const CATEGORY_TEXT = { safe: 'Safe', moderate: 'Moderate', risk: 'Risk', unknown: 'No data' };

// Phase 12.5e — this is the piece that was still missing: NOT "is this
// one route safe", but "which of the next 12 hours is actually the
// right time to leave at all", for whichever point the trip is
// currently anchored to (the origin once it's set, else the city
// center). Polls the same repository.get_heatmap forecast every route
// point-sample already uses — see backend/app/routers/best_hours.py.
export function BestHoursTimeline({ cityId, point, tempUnit = 'F', onPickHour }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchBestHours(cityId, point)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `point` is an object literal recreated on every parent render —
    // key off its coordinates instead so this doesn't refetch every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cityId, point?.lat, point?.lon]);

  if (loading) {
    return (
      <div className="p-3 rounded-xl border border-border bg-surface/40 flex items-center gap-2 text-[12px] text-inkfaint">
        <RefreshCw className="w-3.5 h-3.5 animate-spin" /> Loading the next 12 hours…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 flex items-start gap-1.5 text-[12px] text-amber-300">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>Couldn't load the best-hours timeline: {error}</span>
      </div>
    );
  }

  if (!data || !data.hours?.length) return null;

  const recommended = data.hours.find((h) => h.hour === data.recommended_hour);

  return (
    <div className="p-3.5 rounded-xl border border-border bg-surface/40 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-mono uppercase text-inkfaint">
          <Sun className="w-3.5 h-3.5" /> Best hours to travel · next {data.horizon_hours}h
        </span>
        {!point && <span className="text-[10px] text-inkfaint">at city center</span>}
      </div>

      {recommended && (
        <p className="text-[12px] text-inksoft">
          Best window: <span className="font-semibold text-ink">{recommended.local_hour_label}</span>
          {recommended.temperature_c != null && (
            <span className="text-inkfaint"> · {formatTemp(recommended.temperature_c, tempUnit)}</span>
          )}
        </p>
      )}

      <div className="flex gap-1">
        {data.hours.map((h) => {
          const classes = RISK_COLOR_CLASSES[h.color] || RISK_COLOR_CLASSES.slate;
          const isRecommended = h.hour === data.recommended_hour;
          return (
            <button
              key={h.hour}
              type="button"
              title={`${h.local_hour_label} — ${CATEGORY_TEXT[h.category] || h.category}${h.temperature_c != null ? ` · ${formatTemp(h.temperature_c, tempUnit)}` : ''}`}
              onClick={() => onPickHour?.(h.hour)}
              className={`flex-1 min-w-0 flex flex-col items-center gap-1 py-1.5 rounded-md border transition-transform cursor-pointer ${classes.bg} ${isRecommended ? 'ring-1 ring-orange-400 scale-105' : ''}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${classes.dot}`} />
              <span className={`text-[10px] font-mono font-semibold leading-tight ${classes.text}`}>
                {h.temperature_c != null ? formatTemp(h.temperature_c, tempUnit, 0) : '—'}
              </span>
              <span className="text-[9px] font-mono text-inkfaint truncate w-full text-center leading-tight">
                {h.local_hour_label.replace(' ', '')}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 text-[10px] text-inkfaint">
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Safe</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Moderate</span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-400" /> Risk</span>
      </div>
    </div>
  );
}