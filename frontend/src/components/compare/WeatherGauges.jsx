import React from 'react';

// Small, self-contained SVG widgets used inside the Compare Cities
// "Detailed" weather card — a UV ring, a wind compass, and a humidity
// bar-meter, in the same spirit as a consumer forecast widget's little
// dials, but drawn to match this app's dark surface/border/ink tokens
// instead of copying a light-theme reference 1:1.

// --- UV Index ring ----------------------------------------------------

const UV_BANDS = [
  { max: 2, color: '#4ade80', label: 'Low' },
  { max: 5, color: '#facc15', label: 'Moderate' },
  { max: 7, color: '#fb923c', label: 'High' },
  { max: 10, color: '#f87171', label: 'Very High' },
  { max: Infinity, color: '#c084fc', label: 'Extreme' },
];

function uvBand(value) {
  return UV_BANDS.find((b) => value <= b.max) || UV_BANDS[UV_BANDS.length - 1];
}

export function UVGauge({ value }) {
  if (value == null) return null;
  const band = uvBand(value);
  const pct = Math.max(0, Math.min(1, value / 11));
  const r = 26;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * pct;

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div className="relative w-16 h-16">
        <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90 absolute inset-0">
          <circle cx="32" cy="32" r={r} fill="none" stroke="#2a2a2a" strokeWidth="6" />
          <circle
            cx="32" cy="32" r={r} fill="none" stroke={band.color} strokeWidth="6"
            strokeDasharray={`${dash} ${circumference - dash}`} strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-black text-ink leading-none">{value}</span>
        </div>
      </div>
      <div className="flex flex-col items-center">
        <span className="text-[8px] font-mono text-inkfaint uppercase tracking-wide">UV Index</span>
        <span className="text-[8.5px] font-mono font-bold" style={{ color: band.color }}>{band.label}</span>
      </div>
    </div>
  );
}

// --- Wind compass -------------------------------------------------------

// Standard Beaufort scale, collapsed to short labels — same idea as the
// "Force: 2 (Light Breeze)" caption in the reference widget.
function beaufort(mph) {
  if (mph == null) return null;
  const scale = [
    { max: 1, force: 0, label: 'Calm' },
    { max: 3, force: 1, label: 'Light Air' },
    { max: 7, force: 2, label: 'Light Breeze' },
    { max: 12, force: 3, label: 'Gentle Breeze' },
    { max: 18, force: 4, label: 'Moderate Breeze' },
    { max: 24, force: 5, label: 'Fresh Breeze' },
    { max: 31, force: 6, label: 'Strong Breeze' },
    { max: 38, force: 7, label: 'Near Gale' },
    { max: 46, force: 8, label: 'Gale' },
    { max: Infinity, force: 9, label: 'Severe Gale+' },
  ];
  return scale.find((s) => mph <= s.max) || scale[scale.length - 1];
}

export function WindCompass({ speedMph, gustMph, directionDeg }) {
  if (speedMph == null) return null;
  const force = beaufort(speedMph);
  const hasDirection = directionDeg != null;

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r="28" fill="none" stroke="#2a2a2a" strokeWidth="1.5" />
        {['N', 'E', 'S', 'W'].map((label, i) => {
          const angle = i * 90;
          const rad = (angle - 90) * (Math.PI / 180);
          const x = 32 + 22 * Math.cos(rad);
          const y = 32 + 22 * Math.sin(rad);
          return (
            <text key={label} x={x} y={y + 2.5} textAnchor="middle" fontSize="6.5" fontFamily="monospace" fill="#777">
              {label}
            </text>
          );
        })}
        {hasDirection && (
          <g transform={`rotate(${directionDeg} 32 32)`}>
            <line x1="32" y1="32" x2="32" y2="12" stroke="#fb923c" strokeWidth="2.5" strokeLinecap="round" />
            <polygon points="32,7 28,15 36,15" fill="#fb923c" />
          </g>
        )}
        <circle cx="32" cy="32" r="3" fill="#fb923c" />
      </svg>
      <div className="flex flex-col items-center mt-0.5">
        <span className="text-sm font-black text-ink leading-none">
          {speedMph}<span className="text-[9px] font-mono text-inkmuted"> mph</span>
        </span>
        {gustMph != null && <span className="text-[8px] font-mono text-inkfaint">Gust {gustMph}</span>}
        {force && <span className="text-[8px] font-mono text-inkfaint">Force {force.force} · {force.label}</span>}
      </div>
    </div>
  );
}

// --- Humidity bar-meter ---------------------------------------------------

export function HumidityBars({ pct, dewPointF }) {
  if (pct == null) return null;
  const totalBars = 8;
  const filled = Math.round((pct / 100) * totalBars);

  return (
    <div className="flex flex-col items-center gap-1 shrink-0">
      <div className="flex items-end gap-[2.5px] h-10">
        {Array.from({ length: totalBars }).map((_, i) => {
          const isFilled = i >= totalBars - filled;
          const h = 6 + i * 3.5;
          return (
            <div
              key={i}
              className="w-[5px] rounded-sm"
              style={{
                height: `${h}px`,
                backgroundColor: isFilled ? '#38bdf8' : '#2a2a2a',
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-col items-center">
        <span className="text-sm font-black text-ink leading-none">{pct}%</span>
        <span className="text-[8px] font-mono text-inkfaint uppercase tracking-wide">Humidity</span>
        {dewPointF != null && <span className="text-[8px] font-mono text-inkfaint">Dew point {dewPointF}°F</span>}
      </div>
    </div>
  );
}

// Row wrapper — renders whichever of the three gauges have data, so a
// city missing one field (e.g. no UV coverage for that date) just shows
// the others instead of leaving a gap.
export function WeatherGaugeRow({ weather }) {
  if (!weather) return null;
  const { uv_index_max, wind_max_mph, wind_gusts_max_mph, wind_direction_deg, humidity_max_pct, dew_point_f } = weather;
  if (uv_index_max == null && wind_max_mph == null && humidity_max_pct == null) return null;
  return (
    <div className="flex items-start justify-around gap-2 py-1.5 flex-wrap">
      <UVGauge value={uv_index_max} />
      <WindCompass speedMph={wind_max_mph} gustMph={wind_gusts_max_mph} directionDeg={wind_direction_deg} />
      <HumidityBars pct={humidity_max_pct} dewPointF={dew_point_f} />
    </div>
  );
}
