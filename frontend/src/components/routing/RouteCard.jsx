import React from 'react';
import { Clock, Route as RouteIcon, Thermometer, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatTemp } from '../../lib/thermalFormat';
import { RISK_COLOR_CLASSES } from '../../lib/riskColors';

const LABEL_META = {
  fastest: { text: 'Fastest', className: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  coolest: { text: 'Coolest', className: 'bg-green-500/15 text-green-300 border-green-500/30' },
  balanced: { text: 'Balanced', className: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
};

// heat_category (route_heat_scoring.heat_category) -> plain-language
// text next to its color. Colors come from RISK_COLOR_CLASSES — the
// same emerald/amber/red/slate map RiskScoreCard and TileRiskBadge
// already use, so "safe/moderate/risk" here means the same colors as
// "Low/Moderate/High" elsewhere in the app, not a second, disagreeing
// palette.
const HEAT_CATEGORY_TEXT = {
  safe: 'Safe',
  moderate: 'Moderate',
  risk: 'Risk',
  unknown: 'No data',
};

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

function formatDistance(meters, unit) {
  if (unit === 'F') {
    const miles = meters / 1609.34;
    return `${miles.toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

export function RouteCard({ route, isSelected, onSelect, tempUnit = 'F', isOnlyRoute = false, isHiddenFromMap = false }) {
  const labels = route.labels || [];
  const hasHeatData = route.avg_temp_c != null;
  const hasOutOfHorizon = route.points_out_of_horizon > 0;
  const heatCategory = route.heat_category || (hasHeatData ? null : 'unknown');
  const heatColorClasses = RISK_COLOR_CLASSES[route.heat_category_color] || RISK_COLOR_CLASSES.slate;

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-3.5 rounded-xl border transition-colors cursor-pointer ${
        isSelected ? 'bg-surface2 border-orange-500/50 shadow-[0_0_0_1px_rgba(249,115,22,0.2)]' : 'bg-surface/50 border-border hover:bg-surface2/60'
      } ${isHiddenFromMap ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex flex-wrap gap-1.5">
          {/* Phase 12.5f — FASTEST/COOLEST/BALANCED are COMPARATIVE labels:
              they only mean something when there's another candidate route
              to compare against. With exactly one route, every label lands
              on it by definition (nothing to lose to), which read as three
              fake "wins" rather than real routing intelligence. Collapse
              them into one honest, neutral note instead — the heat_category
              badge below still shows (that's a property of THIS route on
              its own, not a comparison, so it stays meaningful either way). */}
          {isOnlyRoute ? (
            <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border bg-surface2 text-inkfaint border-border">
              Only route found
            </span>
          ) : (
            <>
              {labels.length === 0 && (
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border bg-surface2 text-inkfaint border-border">Option</span>
              )}
              {labels.map((label) => {
                const meta = LABEL_META[label] || { text: label, className: 'bg-surface2 text-inkfaint border-border' };
                return (
                  <span key={label} className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded-full border ${meta.className}`}>
                    {meta.text}
                  </span>
                );
              })}
            </>
          )}
        </div>
        <span className="text-[10px] font-mono text-inkfaint uppercase">{route.provider}</span>
      </div>

      {isHiddenFromMap && (
        <p className="text-[10px] text-inkfaint mb-2">Not currently shown on the map — pick it, or raise the count above the map.</p>
      )}

      {heatCategory && (
        <div className={`inline-flex items-center gap-1 mb-2 px-2 py-0.5 rounded-full border text-[10px] font-mono uppercase ${heatColorClasses.bg} ${heatColorClasses.text}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${heatColorClasses.dot}`} />
          {HEAT_CATEGORY_TEXT[heatCategory] || heatCategory}
        </div>
      )}

      <div className="flex items-center gap-4 mb-2">
        <div className="flex items-center gap-1.5 text-ink">
          <Clock className="w-3.5 h-3.5 text-inkmuted" />
          <span className="text-sm font-semibold">{formatDuration(route.duration_s)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-inksoft">
          <RouteIcon className="w-3.5 h-3.5 text-inkmuted" />
          <span className="text-sm">{formatDistance(route.distance_m, tempUnit)}</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Thermometer className="w-3.5 h-3.5 text-inkmuted" />
        {hasHeatData ? (
          <span className="text-sm text-inksoft">
            Avg exposure <span className="font-semibold text-ink">{formatTemp(route.avg_temp_c, tempUnit)}</span>
            {route.max_temp_c != null && <span className="text-inkfaint"> · peak {formatTemp(route.max_temp_c, tempUnit)}</span>}
          </span>
        ) : (
          <span className="text-sm text-inkfaint">No forecast available for this trip's timing</span>
        )}
      </div>

      {hasOutOfHorizon && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-amber-300/90">
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span>{route.points_out_of_horizon} of {route.points_total} sampled points fall beyond FortyGuard's 12-hour forecast window</span>
        </div>
      )}
      {!hasOutOfHorizon && hasHeatData && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-inkfaint">
          <CheckCircle2 className="w-3 h-3 shrink-0 text-green-400/80" />
          <span>Full trip covered by the 12-hour forecast window ({route.points_scored}/{route.points_total} points)</span>
        </div>
      )}
    </button>
  );
}