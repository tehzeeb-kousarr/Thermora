// Each scheme is a set of RGB stops sampled at t=[0..1] (cool -> hot / low
// -> high). Real gradients, not decoration — this is what turns a raw
// value into the fill color of a tile that actually came back from
// FortyGuard.
export const COLOR_SCHEMES = {
  warm: { label: 'Warm', stops: [[34, 197, 94], [234, 179, 8], [249, 115, 22], [239, 68, 68]] },
  spectral: { label: 'Spectral', stops: [[59, 130, 246], [34, 197, 94], [234, 179, 8], [249, 115, 22], [239, 68, 68]] },
  diverging: { label: 'Diverging', stops: [[37, 99, 235], [226, 232, 240], [220, 38, 38]] },
};

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function colorAtPosition(scheme, t) {
  const stops = COLOR_SCHEMES[scheme]?.stops || COLOR_SCHEMES.warm.stops;
  const clamped = Math.max(0, Math.min(1, t));
  const segments = stops.length - 1;
  const segLen = 1 / segments;
  const segIdx = Math.min(segments - 1, Math.floor(clamped / segLen));
  const localT = (clamped - segIdx * segLen) / segLen;
  const [r1, g1, b1] = stops[segIdx];
  const [r2, g2, b2] = stops[segIdx + 1];
  return `rgb(${Math.round(lerp(r1, r2, localT))}, ${Math.round(lerp(g1, g2, localT))}, ${Math.round(lerp(b1, b2, localT))})`;
}

// Builds class breaks either as equal-width intervals across [min, max]
// ("Equal Interval") or as equal-count buckets from the actual tile value
// distribution ("Quantile") — both operate on data already in memory, no refetch.
export function buildBreaks(values, min, max, count, mode) {
  if (mode === 'quantile' && values.length) {
    const sorted = [...values].sort((a, b) => a - b);
    const breaks = [sorted[0]];
    for (let i = 1; i < count; i++) {
      const idx = Math.min(sorted.length - 1, Math.floor((i / count) * sorted.length));
      breaks.push(sorted[idx]);
    }
    breaks.push(sorted[sorted.length - 1]);
    return breaks;
  }
  const span = max - min || 1;
  return Array.from({ length: count + 1 }, (_, i) => min + (i / count) * span);
}

export function bucketIndexFor(value, breaks) {
  if (value == null || Number.isNaN(value)) return -1;
  for (let i = 0; i < breaks.length - 1; i++) {
    if (value <= breaks[i + 1] || i === breaks.length - 2) return i;
  }
  return breaks.length - 2;
}
