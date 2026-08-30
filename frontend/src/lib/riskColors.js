// Shared between RiskScoreCard (full breakdown, Dashboard) and
// TileRiskBadge (compact, Heat Map tile drawer) so "Moderate" etc. always
// means the same color everywhere in the app.
export const RISK_COLOR_CLASSES = {
  emerald: { ring: 'stroke-emerald-400', text: 'text-emerald-300', bg: 'bg-emerald-500/15 border-emerald-500/30', bar: 'bg-emerald-400', dot: 'bg-emerald-400' },
  amber: { ring: 'stroke-amber-400', text: 'text-amber-300', bg: 'bg-amber-500/15 border-amber-500/30', bar: 'bg-amber-400', dot: 'bg-amber-400' },
  orange: { ring: 'stroke-orange-400', text: 'text-orange-300', bg: 'bg-orange-500/15 border-orange-500/30', bar: 'bg-orange-400', dot: 'bg-orange-400' },
  red: { ring: 'stroke-red-400', text: 'text-red-300', bg: 'bg-red-500/15 border-red-500/30', bar: 'bg-red-400', dot: 'bg-red-400' },
  // Phase 10 fix — neutral fallback for missing/unknown status. Emergency
  // Mode used to fall back to `emerald` (safe green) when a status color
  // was missing, which is the worst possible failure mode for a component
  // whose entire job is flagging danger. Use this instead of emerald as
  // the default anywhere a color might not be present yet.
  slate: { ring: 'stroke-slate-400', text: 'text-slate-300', bg: 'bg-slate-500/15 border-slate-500/30', bar: 'bg-slate-400', dot: 'bg-slate-400' },
};