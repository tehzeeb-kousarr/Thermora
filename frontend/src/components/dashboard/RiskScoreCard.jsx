import React, { useEffect, useState } from 'react';
import { Gauge, Info, RefreshCw, AlertTriangle, ChevronDown, ChevronUp, Users, HardHat, Wheat, Briefcase, CheckCircle2 } from 'lucide-react';
import { fetchRiskScore, fetchAdvisor, fetchAdvisorPersonas } from '../../api/thermoraApi';
import { formatNumber } from '../../lib/thermalFormat';
import { RISK_COLOR_CLASSES as COLOR_CLASSES } from '../../lib/riskColors';

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
            {formatNumber(factor.raw_value, 1)}{factor.unit} · sub-score {factor.sub_score}/100 · weight {Math.round(factor.weight * 100)}%
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

const PERSONA_ICONS = { resident: Users, outdoor_worker: HardHat, farmer: Wheat, business: Briefcase };

// Phase 13 — Local Heat Advisor, folded directly into the card whose data
// it transforms rather than living as its own page. This intentionally
// only offers personas Emergency Mode doesn't already serve (resident,
// outdoor worker, farmer, business) — a "city official"/"emergency
// manager" persona would just be a thinner rehash of emergency_score.py's
// own factor-conditioned action list (which also has NWS + Impact Score
// context this card doesn't), so it isn't offered here. Fetches
// /api/cities/{id}/advisor — same location_features read the score above
// already did, no additional FortyGuard/exposure call.
function LocalAdvisorSection({ cityId, date, refreshToken }) {
  const [personas, setPersonas] = useState([]);
  const [persona, setPersona] = useState('resident');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchAdvisorPersonas().then((r) => setPersonas(r.personas || [])).catch(() => setPersonas([]));
  }, []);

  useEffect(() => {
    if (!date) { setResult(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    fetchAdvisor(cityId, persona, date)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setResult(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cityId, persona, date, refreshToken]);

  if (!date || personas.length === 0) return null;

  return (
    <div className="mt-5 pt-4 border-t border-border/60">
      <div className="text-[10px] text-inkmuted font-mono uppercase mb-2 flex items-center gap-1.5">
        <Gauge className="w-3 h-3" /> Local Advisor — same score, per audience
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {personas.map((p) => {
          const Icon = PERSONA_ICONS[p.key] || Users;
          const isActive = persona === p.key;
          return (
            <button
              key={p.key}
              onClick={() => setPersona(p.key)}
              className={`px-2.5 py-1.5 rounded-lg text-[11px] font-semibold flex items-center gap-1.5 transition-all cursor-pointer border ${
                isActive
                  ? 'bg-orange-600 border-orange-600 text-white'
                  : 'bg-app/50 border-border text-inkmuted hover:text-ink'
              }`}
            >
              <Icon className="w-3 h-3" /> {p.label}
            </button>
          );
        })}
      </div>

      {loading && (
        <p className="text-[11px] text-inkmuted font-mono flex items-center gap-1.5"><RefreshCw className="w-3 h-3 animate-spin" /> Loading…</p>
      )}

      {!loading && result?.available && result.precautions.length > 0 && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <span className="text-[9px] font-mono text-inkfaint/70 uppercase">
              {result.wording_source === 'llm' ? 'AI-worded · Groq' : 'Template-worded'}
            </span>
          </div>
          {result.precautions.map((p) => {
            const c = COLOR_CLASSES[p.color] || COLOR_CLASSES.slate;
            return (
              <div key={p.factor} className="p-2.5 rounded-xl bg-app/50 border border-border/70 flex items-start gap-2">
                <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full border shrink-0 mt-0.5 ${c.bg} ${c.text}`}>
                  {p.tier}
                </span>
                <p className="text-[11px] text-inksoft leading-relaxed">{p.text}</p>
              </div>
            );
          })}
        </div>
      )}

      {!loading && result?.available && result.precautions.length === 0 && (
        <p className="text-[11px] text-emerald-300 flex items-center gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {result.no_precautions_reason}
        </p>
      )}

      {!loading && result && !result.available && (
        <p className="text-[11px] text-inkfaint font-mono">{result.reason}</p>
      )}
    </div>
  );
}

// Phase 8 — deterministic, explainable Heat Risk Score. Every number here
// is traceable to a specific factor with a stated reason (see FactorRow's
// expandable "why") — this is never a single opaque number, by design.
// refreshToken: bump it (any new value) to force a re-fetch of the same
// city/date — e.g. after a riskBoost fetch in the (separate) Heat Map tab
// populated a new location_features factor (exceedance/persistence) that
// a plain `date` dependency wouldn't notice, since the date itself didn't
// change. See liveDataStore.js's subscribeRiskFactorsUpdated for how
// DashboardView actually gets notified to bump this across tabs.
export function RiskScoreCard({ city, date, refreshToken }) {
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
    fetchRiskScore(city.id, date)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((err) => { if (!cancelled) setError(err.message || String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [city.id, date, refreshToken]);

  return (
    <div className="p-6 sm:p-8 rounded-[2rem] bg-surface/80 border border-border shadow-2xl">
      <div className="uppercase text-[11px] tracking-[0.2em] text-inkfaint font-bold mb-4 pb-2 border-b border-border/60 flex items-center justify-between">
        <span className="flex items-center gap-2"><Gauge className="w-3.5 h-3.5" /> Heat Risk Score</span>
        <span className="normal-case tracking-normal text-inkfaint/80 font-mono text-[10px]">{date || 'no date yet'}</span>
      </div>

      {!date && (
        <p className="text-xs text-inkmuted font-mono">Generate a heatmap in the Heat Map tab first — the score reads from whatever's already been fetched for a date.</p>
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
                {result.level} Risk
              </div>
              {result.context?.mean_temp_c != null && (
                <p className="text-[11px] text-inkmuted font-mono mt-2">
                  Mean {formatNumber(result.context.mean_temp_c, 1)}°C
                  {result.context.max_temp_c != null && <> · Peak {formatNumber(result.context.max_temp_c, 1)}°C</>}
                  {result.context.humidity_pct != null && <> · {formatNumber(result.context.humidity_pct, 0)}% humidity</>}
                  {result.temperature_reading_hour && result.temperature_reading_hour !== 'DAY' && (
                    <> · reading from {result.temperature_reading_hour}</>
                  )}
                </p>
              )}
              {result.temperature_reading_hour && result.temperature_reading_hour !== 'DAY' && (
                <p className="text-[10px] text-inkfaint font-mono mt-0.5">
                  Temperature/heat index is a single-hour reading ({result.temperature_reading_hour}); Exceedance and Persistence below cover the full day regardless.
                </p>
              )}
              {result.renormalized && (
                <div className="text-[10px] text-amber-400/90 font-mono mt-1 space-y-1">
                  <p className="flex items-center gap-1">
                    <Info className="w-3 h-3" /> Missing: {result.missing_factors.join(', ')} — weights re-balanced across the rest.
                  </p>
                  {result.missing_factor_notes && Object.entries(result.missing_factor_notes).map(([label, note]) => (
                    <p key={label} className="pl-4 text-inkfaint normal-case tracking-normal">{label}: {note}</p>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="mt-5 pt-1">
            <div className="text-[10px] text-inkmuted font-mono uppercase mb-1.5 flex items-center justify-between flex-wrap gap-1">
              <span>Itemized breakdown (click any factor)</span>
            </div>
            {/* Weights legend — the per-factor "weight X%" line already
                exists inside each FactorRow below, but scattered one per
                row; this is the same real numbers (result.breakdown
                already reflects any re-normalization from a missing
                factor — see result.renormalized above) summarized in one
                scannable line instead of requiring five separate reads. */}
            <div className="flex flex-wrap gap-x-2 gap-y-1 mb-3 text-[10px] font-mono text-inkfaint">
              {result.breakdown.map((f, i) => (
                <span key={f.key} className="flex items-center gap-2">
                  <span><span className="text-inksoft font-semibold">{Math.round(f.weight * 100)}%</span> {f.label}</span>
                  {i < result.breakdown.length - 1 && <span className="text-inkfaint/50">·</span>}
                </span>
              ))}
            </div>
            {result.breakdown.map((f) => <FactorRow key={f.key} factor={f} />)}
          </div>

          <p className="text-[10px] font-mono text-inkfaint mt-4">
            Deterministic weighted formula over live temperature and environmental data — no model, no external call, no black box.
          </p>

          <LocalAdvisorSection cityId={city.id} date={date} refreshToken={refreshToken} />
        </div>
      )}
    </div>
  );
}