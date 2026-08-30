import React, { useState } from 'react';

// Same convention as MiniBarChart.jsx — pure SVG, no charting library, so
// it stays on the app's own theme tokens instead of a mismatched default
// style. Plots exactly ONE point (this city's current Risk vs. Exposure),
// not a scatter of many — "quadrant" here means the four labeled regions
// the single point falls into, which is the actual thing ImpactScoreCard
// wants a reader to take away at a glance: not just "impact is 62", but
// "high risk, moderate exposure" as a shape you can see.

const SIZE = 220;
const PAD = 34; // room for axis labels outside the plot area
const PLOT = SIZE - PAD * 2;

function toPlotX(value) {
  return PAD + (Math.max(0, Math.min(100, value)) / 100) * PLOT;
}
function toPlotY(value) {
  // SVG y grows downward; 100 (high exposure) should plot at the TOP.
  return PAD + PLOT - (Math.max(0, Math.min(100, value)) / 100) * PLOT;
}

const QUADRANTS = [
  { key: 'ur', x: 0.5, y: 0, w: 0.5, h: 0.5, label: 'High Risk\nHigh Exposure', fill: 'rgba(248,113,113,0.06)' },
  { key: 'ul', x: 0, y: 0, w: 0.5, h: 0.5, label: 'Low Risk\nHigh Exposure', fill: 'rgba(251,191,36,0.05)' },
  { key: 'lr', x: 0.5, y: 0.5, w: 0.5, h: 0.5, label: 'High Risk\nLow Exposure', fill: 'rgba(251,191,36,0.05)' },
  { key: 'll', x: 0, y: 0.5, w: 0.5, h: 0.5, label: 'Low Risk\nLow Exposure', fill: 'rgba(52,211,153,0.06)' },
];

// Which of the four labeled regions a point falls in, in plain words —
// used only for the hover tooltip below, purely descriptive of the two
// numbers already being plotted (never a new/derived score).
function quadrantLabel(riskScore, exposureScore) {
  const highRisk = riskScore >= 50;
  const highExposure = exposureScore >= 50;
  if (highRisk && highExposure) return 'High Risk, High Exposure';
  if (!highRisk && highExposure) return 'Low Risk, High Exposure';
  if (highRisk && !highExposure) return 'High Risk, Low Exposure';
  return 'Low Risk, Low Exposure';
}

// riskScore / exposureScore: 0-100. colorHex: the point's fill, passed in
// by the caller already matching the same risk-color convention used
// everywhere else (RISK_COLOR_CLASSES) — this component doesn't invent
// its own color scale.
export function RiskExposureScatter({ riskScore, exposureScore, colorHex = '#94a3b8' }) {
  const [hovered, setHovered] = useState(false);
  if (riskScore == null || exposureScore == null) return null;

  const px = toPlotX(riskScore);
  const py = toPlotY(exposureScore);
  // Percentage position within the SIZE×SIZE viewBox, for placing the HTML
  // tooltip (a real DOM element, not SVG) at the same spot as the point.
  const pxPct = (px / SIZE) * 100;
  const pyPct = (py / SIZE) * 100;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-full max-w-[240px]">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="w-full h-auto" role="img" aria-label="Risk versus exposure scatter">
          {QUADRANTS.map((q) => (
            <rect
              key={q.key}
              x={PAD + q.x * PLOT} y={PAD + q.y * PLOT}
              width={q.w * PLOT} height={q.h * PLOT}
              fill={q.fill}
            />
          ))}

          {/* Quadrant divider lines at the midpoint of each axis */}
          <line x1={PAD} y1={PAD + PLOT / 2} x2={PAD + PLOT} y2={PAD + PLOT / 2} stroke="currentColor" className="text-border" strokeWidth="1" strokeDasharray="3 3" />
          <line x1={PAD + PLOT / 2} y1={PAD} x2={PAD + PLOT / 2} y2={PAD + PLOT} stroke="currentColor" className="text-border" strokeWidth="1" strokeDasharray="3 3" />

          {/* Plot border */}
          <rect x={PAD} y={PAD} width={PLOT} height={PLOT} fill="none" stroke="currentColor" className="text-border" strokeWidth="1" />

          {/* Axis tick labels */}
          {[0, 50, 100].map((t) => (
            <text key={`x-${t}`} x={toPlotX(t)} y={PAD + PLOT + 14} textAnchor="middle" className="fill-inkfaint" style={{ fontSize: 8, fontFamily: 'monospace' }}>{t}</text>
          ))}
          {[0, 50, 100].map((t) => (
            <text key={`y-${t}`} x={PAD - 8} y={toPlotY(t) + 3} textAnchor="end" className="fill-inkfaint" style={{ fontSize: 8, fontFamily: 'monospace' }}>{t}</text>
          ))}

          {/* Axis titles */}
          <text x={PAD + PLOT / 2} y={SIZE - 4} textAnchor="middle" className="fill-inkmuted" style={{ fontSize: 9, fontFamily: 'monospace', letterSpacing: 0.5 }}>RISK SCORE →</text>
          <text x={10} y={PAD + PLOT / 2} textAnchor="middle" className="fill-inkmuted" style={{ fontSize: 9, fontFamily: 'monospace', letterSpacing: 0.5 }} transform={`rotate(-90 10 ${PAD + PLOT / 2})`}>EXPOSURE →</text>

          {/* The point — a soft glow ring behind a solid dot, matching the
              app's general "colored glow" aesthetic used on gauges elsewhere.
              A larger, invisible hit-circle sits on top so hovering near the
              point (not just its exact 5px radius) reveals the tooltip. */}
          <circle cx={px} cy={py} r="10" fill={colorHex} opacity={hovered ? 0.4 : 0.25} style={{ transition: 'opacity 0.15s ease' }} />
          <circle cx={px} cy={py} r={hovered ? 6 : 5} fill={colorHex} stroke="white" strokeOpacity="0.4" strokeWidth="1" style={{ transition: 'r 0.15s ease' }} />
          <circle
            cx={px} cy={py} r="16" fill="transparent"
            className="cursor-default"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          />
        </svg>

        {/* Styled HTML tooltip, positioned to match the SVG point above —
            kept out of the SVG itself (foreignObject is finicky across
            browsers) but visually anchored to it via the same % coords. */}
        {hovered && (
          <div
            className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full opacity-100 transition-opacity duration-150 whitespace-nowrap"
            style={{ left: `${pxPct}%`, top: `calc(${pyPct}% - 10px)` }}
          >
            <div className="px-3 py-2 rounded-xl bg-zinc-900 border border-border shadow-2xl text-[10px] font-mono text-ink leading-relaxed">
              <div className="font-bold" style={{ color: colorHex }}>{quadrantLabel(riskScore, exposureScore)}</div>
              <div>Risk: <span className="text-ink font-semibold">{Math.round(riskScore)}</span> / 100</div>
              <div>Exposure: <span className="text-ink font-semibold">{Math.round(exposureScore)}</span> / 100</div>
            </div>
            <div className="w-2.5 h-2.5 bg-zinc-900 border-r border-b border-border rotate-45 absolute left-1/2 -translate-x-1/2 -bottom-[5px]" />
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 mt-1 text-center">
        <span className="text-[9px] font-mono text-inkfaint">Risk: <span className="text-inksoft font-semibold">{Math.round(riskScore)}</span></span>
        <span className="text-[9px] font-mono text-inkfaint">Exposure: <span className="text-inksoft font-semibold">{Math.round(exposureScore)}</span></span>
      </div>
    </div>
  );
}
