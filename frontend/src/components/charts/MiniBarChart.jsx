import React from 'react';

// Small, dependency-free bar charts shared across views. Pure SVG/CSS —
// no charting library needed — so they stay in sync with the app's own
// theme tokens (text-ink, border-border, orange/sky accents) instead of
// pulling in a mismatched default style.

const BAR_AREA_HEIGHT = 120; // px, the vertical space bars grow within

function scaleHeight(value, min, max) {
  if (value == null || Number.isNaN(value)) return 0;
  const range = max - min || 1;
  return Math.max(4, ((value - min) / range) * BAR_AREA_HEIGHT);
}

function fmt(value, decimals) {
  return value == null || Number.isNaN(value) ? '—' : value.toFixed(decimals);
}

// Floating, styled hover tooltip — CSS-only (Tailwind's group/group-hover),
// so each bar gets its own precisely-scoped hover target instead of one
// tooltip reacting to the whole chart. `tip` can be any node (a couple of
// stacked lines reads best: a bold title line + a value line). Exported so
// other bar-like visuals in the app (e.g. ResearchView's daily history
// bars) can use the same styled tooltip instead of the plain browser one.
export function ChartHoverTip({ tip, children, className = '' }) {
  if (!tip) return children;
  return (
    <div className={`relative group/tip cursor-default ${className}`}>
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2.5 z-30 opacity-0 scale-95 group-hover/tip:opacity-100 group-hover/tip:scale-100 transition-all duration-150 whitespace-nowrap">
        <div className="px-3 py-2 rounded-xl bg-zinc-900 border border-border shadow-2xl text-[10px] font-mono text-ink leading-relaxed">
          {tip}
        </div>
        <div className="w-2.5 h-2.5 bg-zinc-900 border-r border-b border-border rotate-45 absolute left-1/2 -translate-x-1/2 -bottom-[5px]" />
      </div>
    </div>
  );
}

// Two bars per group (e.g. "Window A" vs "Window B", or "This year" vs
// "Last year") side by side, one group per label. Used by TimeCompareView
// to give the Mean/Max/Min delta numbers above it an at-a-glance visual.
// Hover either bar for its exact reading — the group label + series name +
// value/unit, plus an optional per-group `hint` line if the caller passes
// one (e.g. what window that group's date/time actually was).
export function GroupedBarChart({ groups, seriesALabel = 'A', seriesBLabel = 'B', decimals = 0, unit = '' }) {
  const values = groups.flatMap((g) => [g.a, g.b]).filter((v) => v != null && !Number.isNaN(v));
  const max = values.length ? Math.max(...values) : 1;
  const min = Math.min(0, ...(values.length ? values : [0]));

  return (
    <div>
      <div className="flex items-end justify-around gap-3 sm:gap-8" style={{ height: BAR_AREA_HEIGHT + 30 }}>
        {groups.map((g) => (
          <div key={g.label} className="flex flex-col items-center gap-1.5 min-w-0">
            <div className="flex items-end gap-1.5" style={{ height: BAR_AREA_HEIGHT }}>
              <ChartHoverTip tip={g.a != null && (
                <>
                  <div className="font-bold text-orange-300">{seriesALabel}</div>
                  <div>{g.label}: <span className="text-ink font-semibold">{fmt(g.a, decimals)}{unit}</span></div>
                  {g.hint && <div className="text-inkfaint mt-0.5">{g.hint}</div>}
                </>
              )}>
                <div className="flex flex-col items-center justify-end h-full">
                  {g.a != null && <span className="text-[10px] font-mono text-orange-300 mb-1 whitespace-nowrap">{fmt(g.a, decimals)}{unit}</span>}
                  <div
                    className="w-5 sm:w-7 rounded-t-md bg-gradient-to-t from-orange-500 to-orange-400 transition-[filter] group-hover/tip:brightness-110"
                    style={{ height: scaleHeight(g.a, min, max) }}
                  />
                </div>
              </ChartHoverTip>
              <ChartHoverTip tip={g.b != null && (
                <>
                  <div className="font-bold text-sky-300">{seriesBLabel}</div>
                  <div>{g.label}: <span className="text-ink font-semibold">{fmt(g.b, decimals)}{unit}</span></div>
                  {g.hint && <div className="text-inkfaint mt-0.5">{g.hint}</div>}
                </>
              )}>
                <div className="flex flex-col items-center justify-end h-full">
                  {g.b != null && <span className="text-[10px] font-mono text-sky-300 mb-1 whitespace-nowrap">{fmt(g.b, decimals)}{unit}</span>}
                  <div
                    className="w-5 sm:w-7 rounded-t-md bg-gradient-to-t from-sky-500 to-sky-400 transition-[filter] group-hover/tip:brightness-110"
                    style={{ height: scaleHeight(g.b, min, max) }}
                  />
                </div>
              </ChartHoverTip>
            </div>
            <span className="text-[10px] font-mono text-inkfaint uppercase mt-1 whitespace-nowrap">{g.label}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-center gap-4 mt-3 pt-3 border-t border-border/60">
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-inkfaint">
          <span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-t from-orange-500 to-orange-400" /> {seriesALabel}
        </span>
        <span className="flex items-center gap-1.5 text-[10px] font-mono text-inkfaint">
          <span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-t from-sky-500 to-sky-400" /> {seriesBLabel}
        </span>
      </div>
    </div>
  );
}

// One bar per entry — for a single series across several categories
// (e.g. Coolest/Mean/Peak, or one bar per city). `bars`: [{ label, value,
// colorClass?, hint? }]. colorClass defaults to the orange gradient used
// elsewhere in the app; pass a different `from-*/to-*` pair per bar to
// distinguish entries (e.g. per-city colors in CompareView). Hover any
// bar for its exact value plus its optional `hint` line.
export function SimpleBarChart({ bars, decimals = 0, unit = '' }) {
  const values = bars.map((b) => b.value).filter((v) => v != null && !Number.isNaN(v));
  const max = values.length ? Math.max(...values) : 1;
  const min = Math.min(0, ...(values.length ? values : [0]));

  return (
    <div className="flex items-end justify-around gap-3 sm:gap-6" style={{ height: BAR_AREA_HEIGHT + 30 }}>
      {bars.map((b) => (
        <div key={b.label} className="flex flex-col items-center gap-1.5 flex-1 min-w-0">
          <ChartHoverTip tip={b.value != null && (
            <>
              <div className="font-bold text-inksoft">{b.label}</div>
              <div>Value: <span className="text-ink font-semibold">{fmt(b.value, decimals)}{unit}</span></div>
              {b.hint && <div className="text-inkfaint mt-0.5">{b.hint}</div>}
            </>
          )}>
            <div className="flex flex-col items-center justify-end" style={{ height: BAR_AREA_HEIGHT }}>
              {b.value != null && <span className="text-[10px] font-mono text-inksoft mb-1 whitespace-nowrap">{fmt(b.value, decimals)}{unit}</span>}
              <div
                className={`w-6 sm:w-9 rounded-t-md bg-gradient-to-t transition-[filter] group-hover/tip:brightness-110 ${b.colorClass || 'from-orange-500 to-orange-400'}`}
                style={{ height: scaleHeight(b.value, min, max) }}
              />
            </div>
          </ChartHoverTip>
          <span className="text-[10px] font-mono text-inkfaint uppercase mt-1 text-center whitespace-nowrap">{b.label}</span>
        </div>
      ))}
    </div>
  );
}
