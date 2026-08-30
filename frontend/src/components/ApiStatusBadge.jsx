import React from 'react';
import { useApiStatus } from '../hooks/useApiStatus';

const CONFIG = {
  live: { color: 'bg-emerald-400', text: 'text-emerald-400', label: 'FortyGuard Live', pulse: true },
  degraded: { color: 'bg-amber-400', text: 'text-amber-400', label: 'FortyGuard Degraded', pulse: true },
  down: { color: 'bg-red-500', text: 'text-red-400', label: 'FortyGuard Down', pulse: true },
  unreachable: { color: 'bg-red-500', text: 'text-red-400', label: 'Backend Unreachable', pulse: true },
  unknown: { color: 'bg-inkfaint', text: 'text-inkmuted', label: 'Connecting…', pulse: true },
};

export const ApiStatusBadge = () => {
  const { state, detail } = useApiStatus();
  const cfg = CONFIG[state] || CONFIG.unknown;

  const title = detail?.last_error
    ? `Last error: ${detail.last_error}${detail.last_error_at ? ` (${detail.last_error_at})` : ''}`
    : detail?.last_success_at
      ? `Last success: ${detail.last_success_at}`
      : 'No FortyGuard request has completed yet this session — navigate to a live view (e.g. Dashboard or Heatmap) to trigger one.';

  return (
    <div title={title} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface2/60 border border-border text-[10px] font-mono font-semibold cursor-help">
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.color} ${cfg.pulse ? 'animate-pulse' : ''}`} />
      <span className={cfg.text}>{cfg.label}</span>
    </div>
  );
};
