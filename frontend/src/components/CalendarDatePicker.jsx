import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// A popover calendar that only lets the user land on months that are in
// `availableMonths` and, within a month, on days that actually have stored
// data (fetched lazily via `fetchDatesForMonth` the first time that month is
// opened). This replaces two plain <select> dropdowns (Month, Date) with a
// single "click to open a real calendar" control — same underlying
// month/date constraints, just presented as a calendar instead of two lists.
export function CalendarDatePicker({
  value,                 // 'YYYY-MM-DD' or ''
  onChange,              // (dateStr) => void
  availableMonths = [],  // ['2025-06', '2025-07', ...] ascending — months with any stored data
  fetchDatesForMonth,    // async (monthKey: 'YYYY-MM') => string[] of 'YYYY-MM-DD'
  label = 'Date',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => (value ? value.slice(0, 7) : availableMonths[availableMonths.length - 1] || ''));
  const [datesInView, setDatesInView] = useState([]);
  const [loadingDates, setLoadingDates] = useState(false);
  const rootRef = useRef(null);
  const cache = useRef({});

  // Keep the calendar pointed at the month of the current value whenever
  // it changes from outside (e.g. a default gets set once data loads).
  useEffect(() => {
    if (!open && value) setViewMonth(value.slice(0, 7));
  }, [value, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const loadMonth = useCallback((m) => {
    if (!m || !fetchDatesForMonth) return;
    if (cache.current[m]) { setDatesInView(cache.current[m]); return; }
    setLoadingDates(true);
    fetchDatesForMonth(m)
      .then((r) => {
        const dates = Array.isArray(r) ? r : r?.dates || [];
        cache.current[m] = dates;
        setDatesInView(dates);
      })
      .catch(() => setDatesInView([]))
      .finally(() => setLoadingDates(false));
  }, [fetchDatesForMonth]);

  useEffect(() => {
    if (open && viewMonth) loadMonth(viewMonth);
  }, [open, viewMonth, loadMonth]);

  const monthIndex = availableMonths.indexOf(viewMonth);
  const canGoPrev = monthIndex > 0;
  const canGoNext = monthIndex >= 0 && monthIndex < availableMonths.length - 1;

  const [yy, mm] = viewMonth ? viewMonth.split('-').map(Number) : [null, null];

  const grid = useMemo(() => {
    if (!yy || !mm) return [];
    const startOffset = new Date(yy, mm - 1, 1).getDay();
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const cells = Array(startOffset).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }, [yy, mm]);

  const availableSet = useMemo(() => new Set(datesInView), [datesInView]);

  const displayLabel = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : 'Select a date';

  const isEmpty = availableMonths.length === 0;

  return (
    <div className="relative" ref={rootRef}>
      <span className="text-xs font-mono text-inkmuted flex items-center gap-1.5 mb-1">
        <CalendarDays className="w-3.5 h-3.5" /> {label}
      </span>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || isEmpty}
        className="bg-app/60 border border-border rounded-lg text-xs px-3 py-1.5 text-ink cursor-pointer flex items-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed hover:border-orange-500/50 transition-colors min-w-[152px] justify-between"
      >
        <span>{isEmpty ? 'No dates stored' : displayLabel}</span>
        <CalendarDays className="w-3.5 h-3.5 text-inkfaint shrink-0" />
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 w-64 p-3 rounded-2xl bg-surface border border-border shadow-2xl space-y-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => canGoPrev && setViewMonth(availableMonths[monthIndex - 1])}
              disabled={!canGoPrev}
              className="p-1 rounded-lg hover:bg-app/60 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4 text-inkmuted" />
            </button>
            <span className="text-xs font-bold text-ink">{yy ? `${MONTH_LABELS[mm - 1]} ${yy}` : '—'}</span>
            <button
              type="button"
              onClick={() => canGoNext && setViewMonth(availableMonths[monthIndex + 1])}
              disabled={!canGoNext}
              className="p-1 rounded-lg hover:bg-app/60 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              <ChevronRight className="w-4 h-4 text-inkmuted" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center">
            {DOW_LABELS.map((d, i) => <span key={i} className="text-[9px] font-mono text-inkfaint">{d}</span>)}
            {grid.map((d, i) => {
              if (d == null) return <span key={`blank-${i}`} />;
              const dateStr = `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const isAvailable = availableSet.has(dateStr);
              const isSelected = dateStr === value;
              return (
                <button
                  key={dateStr}
                  type="button"
                  disabled={!isAvailable}
                  onClick={() => { onChange(dateStr); setOpen(false); }}
                  className={`text-[10px] font-mono rounded-lg py-1 transition-all ${
                    isSelected
                      ? 'bg-orange-500 text-zinc-950 font-bold'
                      : isAvailable
                      ? 'text-ink hover:bg-orange-500/20 cursor-pointer border border-orange-500/30'
                      : 'text-inkfaint/30 cursor-not-allowed'
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>

          {loadingDates ? (
            <p className="text-[9px] text-inkfaint font-mono text-center">Loading available dates…</p>
          ) : datesInView.length === 0 ? (
            <p className="text-[9px] text-inkfaint font-mono text-center">No stored dates this month</p>
          ) : (
            <p className="text-[9px] text-inkfaint font-mono text-center">{datesInView.length} date{datesInView.length > 1 ? 's' : ''} on file — highlighted days only</p>
          )}
        </div>
      )}
    </div>
  );
}
