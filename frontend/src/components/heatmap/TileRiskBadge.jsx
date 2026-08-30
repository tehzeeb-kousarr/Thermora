import React, { useEffect, useState } from 'react';
import { Gauge, ArrowRight, Loader2 } from 'lucide-react';
import { fetchRiskScore } from '../../api/thermoraApi';
import { RISK_COLOR_CLASSES } from '../../lib/riskColors';

// Deliberately minimal — this is a glance, not the report. The full
// itemized breakdown (why each factor scored what it did) lives on
// Dashboard's RiskScoreCard; this just says "here's the number" and
// hands off there for anyone who wants the reasoning behind it.
export function TileRiskBadge({ cityId, date, refreshToken, onViewFull }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(!!date);

  useEffect(() => {
    if (!date) { setResult(null); setLoading(false); return undefined; }
    let cancelled = false;
    setLoading(true);
    fetchRiskScore(cityId, date)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setResult(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cityId, date, refreshToken]);

  if (!date) return null;

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-app/60 border border-border text-[11px] text-inkfaint font-mono">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Risk score…
      </div>
    );
  }

  if (!result?.available) return null; // nothing to show yet — not an error, just no data for this date

  const c = RISK_COLOR_CLASSES[result.color] || RISK_COLOR_CLASSES.emerald;

  return (
    <button
      onClick={onViewFull}
      className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors hover:brightness-110 ${c.bg}`}
      title="View full breakdown on Dashboard"
    >
      <span className="flex items-center gap-2">
        <Gauge className={`w-4 h-4 ${c.text}`} />
        <span className={`text-lg font-black ${c.text}`}>{result.score}</span>
        <span className="text-[10px] text-inkfaint font-mono">/100</span>
        <span className={`text-xs font-bold ${c.text}`}>{result.level} Risk</span>
      </span>
      <ArrowRight className={`w-3.5 h-3.5 ${c.text}`} />
    </button>
  );
}
