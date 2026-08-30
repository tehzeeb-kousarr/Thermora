import React from 'react';
import { RevealGroup, RevealItem } from './Reveal';

const STEPS = [
  ['01', 'Detect', 'Hyperlocal thermal data and raw conditions.'],
  ['02', 'Understand', 'Thermora AI risk engine analysis.'],
  ['03', 'Predict', 'Heat trends and evolving context forecasts.'],
  ['04', 'Act', 'Direct prioritized decision support.'],
];

/**
 * Thin four-up "how it flows" strip that sits directly under the hero.
 * A faint warm gradient line on the top edge ties it back to the terrain
 * glow above it, then it drops into a flat, quiet panel — a deliberate
 * beat of calm after the animated hero.
 */
export const StepStrip = () => {
  return (
    <div className="relative w-full border-t border-border bg-surface/60">
      {/* Warm hairline glow along the top edge, echoing the hero's terrain colors */}
      <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-orange-500/50 to-transparent" />

      <RevealGroup className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 grid grid-cols-2 md:grid-cols-4 gap-6 sm:gap-8">
        {STEPS.map(([num, title, desc]) => (
          <RevealItem key={num} className="flex items-center space-x-4">
            <span className="text-2xl font-black text-ink/10 italic font-mono">{num}</span>
            <div>
              <p className="text-xs font-bold text-ink uppercase tracking-wider">{title}</p>
              <p className="text-[11px] text-inkmuted leading-tight">{desc}</p>
            </div>
          </RevealItem>
        ))}
      </RevealGroup>
    </div>
  );
};
