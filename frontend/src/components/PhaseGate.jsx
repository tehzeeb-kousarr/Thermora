import React from 'react';
import { Lock } from 'lucide-react';

// Honest placeholder shown instead of fabricated numbers. This feature's
// underlying data (OSM exposure points, NWS alerts, Risk/Impact Engine,
// or LLM-generated narrative) hasn't been built yet — see THERMORA_PHASES.md.
export const PhaseGate = ({ title, requires, children }) => {
  return (
    <div className="flex flex-col items-center justify-center text-center p-10 rounded-2xl border border-dashed border-border bg-surface/40 gap-3 max-w-xl mx-auto">
      <div className="w-10 h-10 rounded-full bg-surface2 flex items-center justify-center">
        <Lock className="w-4 h-4 text-inkmuted" />
      </div>
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <p className="text-xs text-inkmuted max-w-sm">
        This requires <span className="font-semibold text-inksoft">{requires}</span>,
        which isn't built yet. No placeholder numbers are shown here on purpose —
        only live FortyGuard data is displayed anywhere in Thermora right now.
      </p>
      {children}
    </div>
  );
};
