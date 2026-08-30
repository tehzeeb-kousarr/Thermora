import React, { useEffect, useState } from 'react';
import { Target, RefreshCw, AlertTriangle, ChevronDown, ChevronUp, School, Cross, Building2 } from 'lucide-react';
import { fetchImpactScore } from '../../api/thermoraApi';
import { formatNumber } from '../../lib/thermalFormat';
import { RISK_COLOR_CLASSES as COLOR_CLASSES } from '../../lib/riskColors';
import { RiskExposureScatter } from '../charts/ScatterQuadrant';

const RISK_COLOR_HEX = { emerald: '#34d399', amber: '#fbbf24', orange: '#fb923c', red: '#f87171', slate: '#94a3b8' };

function ScoreGauge({ score, color }) {
  const c = COLOR_CLASSES[color] || COLOR_CLASSES.emerald;
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  return (
    <div className="relative w-28 h-28 shrink-0">
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
        <circle cx="50" cy="50" r={radius} fill="none" strokeWidth="8" className="stroke-surface2" />
        <circle
          cx="50" cy="50" r={radius} fill="none" strokeWidth="8" strokeLinecap="round"
          className={c.ring} strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-3xl font-black ${c.text}`}>{score}</span>
        <span className="text-[9px] text-inkfaint font-mono uppercase">/ 100</span>
      </div>
    </div>
  );
}

function FactorRow({ factor }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-border/50 last:border-0 py-2">
      <button onClick={() => setExpanded((e) => !e)} className="w-full flex items-center justify-between gap-2 cursor-pointer text-left">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-inksoft">{factor.label}</div>
          <div className="text-[10px] text-inkfaint font-mono">
            {formatNumber(factor.raw_value, factor.key === 'heat_risk' ? 1 : 0)} · sub-score {factor.sub_score}/100 · weight {Math.round(factor.weight * 100)}%
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-16 h-1.5 bg-surface2 rounded-full overflow-hidden">
            <div className="h-full bg-orange-400/80" style={{ width: `${factor.sub_score}%` }} />
          </div>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-inkfaint" /> : <ChevronDown className="w-3.5 h-3.5 text-inkfaint" />}
        </div>
      </button>
      {expanded && <p className="text-[10px] text-inkmuted mt-1.5 pl-0.5">{factor.why}</p>}
    </div>
  );
}

// Phase 9 — People Impact Score. Combines Phase 8's Heat Risk Score with
// Phase 6's OSM exposure (schools/hospitals/density) for the same AOI:
// "heat alone ≠ priority; exposure matters." Same refreshToken pattern as
// RiskScoreCard — bump it when a riskBoost fetch (Heat Map tab) or an
// Exposure refresh changes an upstream input this card depends on.
export function ImpactScoreCard({ city, date, refreshToken }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(!!date);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!date) {
      setResult(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchImpactScore(city.id, date)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [city.id, date, refreshToken]);

  return (
    <div className="p-6 sm:p-8 rounded-[2rem] bg-surface/80 border border-border shadow-2xl">
      <div className="uppercase text-[11px] tracking-[0.2em] text-inkfaint font-bold mb-4 pb-2 border-b border-border/60 flex items-center justify-between">
        <span className="flex items-center gap-2"><Target className="w-3.5 h-3.5" /> People Impact Score</span>
        <span className="normal-case tracking-normal text-inkfaint/80 font-mono text-[10px]">{date || 'no date yet'}</span>
      </div>

      {!date && (
        <p className="text-xs text-inkmuted font-mono">Generate a heatmap in the Heat Map tab first — this reads the same Risk Score data, plus exposure for this location.</p>
      )}

      {date && loading && (
        <p className="text-xs text-inkmuted font-mono flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Computing…</p>
      )}

      {error && (
        <p className="text-xs text-red-400 font-mono flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> {error}</p>
      )}

      {result && !result.available && (
        <p className="text-xs text-inkmuted font-mono">{result.reason}</p>
      )}

      {result?.available && (
        <div>
          <div className="flex items-center gap-5">
            <ScoreGauge score={result.score} color={result.color} />
            <div>
              <div className={`inline-block px-2.5 py-1 rounded-lg text-xs font-bold border ${COLOR_CLASSES[result.color]?.bg}`}>
                {result.level} Priority
              </div>
              <p className="text-[11px] text-inkmuted font-mono mt-2">
                Heat Risk {formatNumber(result.heat_risk_score, 1)}/100 ({result.heat_risk_level})
              </p>
              <div className="flex items-center gap-3 mt-2 text-[11px] text-inksoft">
                <span className="flex items-center gap-1"><School className="w-3 h-3 text-orange-400" /> {result.exposure_counts.schools}</span>
                <span className="flex items-center gap-1"><Cross className="w-3 h-3 text-orange-400" /> {result.exposure_counts.hospitals}</span>
                <span className="flex items-center gap-1"><Building2 className="w-3 h-3 text-orange-400" /> {formatNumber(result.exposure_counts.buildings, 0)}</span>
              </div>
              {result.exposure_stale && (
                <p className="text-[10px] text-amber-400/90 font-mono mt-1">Exposure data is stale — refresh it from the Exposure card below.</p>
              )}
            </div>
          </div>

          <div className="mt-5 pt-1">
            <div className="text-[10px] text-inkmuted font-mono uppercase mb-1">Itemized breakdown (click any factor)</div>
            {result.breakdown.map((f) => <FactorRow key={f.key} factor={f} />)}
          </div>

          {(() => {
            // Combines the two non-heat-risk breakdown factors into one
            // "Exposure" axis, weighted the same way impact_score.py
            // itself weights them (0.30 vulnerable_sites / 0.20
            // population_density → renormalized to a 0-100 axis) — not a
            // separately-invented number, just those two real sub_scores
            // recombined for a 2D view instead of one multiplied one.
            const vulnerable = result.breakdown.find((b) => b.key === 'vulnerable_sites');
            const density = result.breakdown.find((b) => b.key === 'population_density');
            if (!vulnerable || !density) return null;
            const exposureAxis = (vulnerable.sub_score * vulnerable.weight + density.sub_score * density.weight) / (vulnerable.weight + density.weight);
            return (
              <div className="mt-5 pt-4 border-t border-border/60">
                <div className="text-[10px] text-inkmuted font-mono uppercase mb-2">Risk vs. Exposure</div>
                <RiskExposureScatter
                  riskScore={result.heat_risk_score}
                  exposureScore={exposureAxis}
                  colorHex={RISK_COLOR_HEX[result.color] || RISK_COLOR_HEX.slate}
                />
              </div>
            );
          })()}

          <p className="text-[10px] font-mono text-inkfaint mt-4">
            Deterministic weighted formula over the Heat Risk Score + OSM exposure data — no model, no black box.
          </p>
        </div>
      )}
    </div>
  );
}