import React from 'react';
import { Reveal, RevealGroup, RevealItem } from './Reveal';

const BLOCKS = [
  {
    num: '01',
    title: 'FortyGuard API',
    description:
      'Hyperlocal temperatures, surface albedo, continuous persistence curves, and diurnal peak timings.',
    tag: '"What the heat is"',
    color: 'orange',
  },
  {
    num: '02',
    title: 'OSM & Exposure',
    description:
      'Schools, hospitals, eldercare facilities, industrial logistics yards, and dense residential blocks.',
    tag: '"Who / what is exposed"',
    color: 'blue',
  },
  {
    num: '03',
    title: 'NWS',
    description:
      'Official Excessive Heat Warnings, Watches, Advisories, and common alerting protocol boundaries.',
    tag: '"Official authorities context"',
    color: 'red',
  },
];

const COLOR_MAP = {
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400' },
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400' },
  red: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
};

export const ArchitectureSection = () => {
  return (
    <section className="py-16 sm:py-20 bg-surface/40 border-y border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <Reveal className="text-center max-w-3xl mx-auto">
          <span className="text-xs font-mono font-bold uppercase tracking-widest text-orange-400 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20">
            The Commercial Architecture
          </span>
          <h2 className="text-3xl sm:text-4xl font-black text-ink mt-4 tracking-tight font-display">
            Thermora turns temperature data into decisions.
          </h2>
          <p className="text-inkmuted text-sm sm:text-base mt-3">
            FortyGuard provides the eyes. OSM provides the local context. NWS provides the
            official alerts. <strong className="text-ink font-bold">Thermora provides the brain.</strong>
          </p>
        </Reveal>

        {/* 4 Block Pipeline */}
        <RevealGroup className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-12" stagger={0.09}>
          {BLOCKS.map((block) => {
            const c = COLOR_MAP[block.color];
            return (
              <RevealItem key={block.num}>
                <div className="h-full bg-app/80 rounded-2xl p-6 border border-border hover:border-borderstrong hover:-translate-y-1 transition-all duration-300 relative">
                  <div
                    className={`w-8 h-8 rounded-xl ${c.bg} border ${c.border} flex items-center justify-center ${c.text} font-mono font-bold text-sm mb-3`}
                  >
                    {block.num}
                  </div>
                  <h4 className="text-base font-bold text-ink">{block.title}</h4>
                  <p className="text-xs text-inkmuted mt-2 leading-relaxed">{block.description}</p>
                  <div className={`mt-4 pt-3 border-t border-border text-[11px] font-mono ${c.text} font-semibold`}>
                    {block.tag}
                  </div>
                </div>
              </RevealItem>
            );
          })}

          <RevealItem>
            <div className="h-full bg-gradient-to-b from-orange-950/40 to-app rounded-2xl p-6 border border-orange-500/40 relative shadow-lg shadow-orange-500/10 hover:-translate-y-1 transition-all duration-300">
              <div className="w-8 h-8 rounded-xl bg-orange-500/20 border border-orange-500/50 flex items-center justify-center text-orange-300 font-mono font-bold text-sm mb-3">
                04
              </div>
              <h4 className="text-base font-bold text-orange-200">Thermora Engine</h4>
              <p className="text-xs text-inksoft mt-2 leading-relaxed">
                Risk calculation, heat story causal attribution, emergency priority rankings, and
                tactical work windows.
              </p>
              <div className="mt-4 pt-3 border-t border-orange-500/30 text-[11px] font-mono text-orange-300 font-bold">
                "What to do next"
              </div>
            </div>
          </RevealItem>
        </RevealGroup>
      </div>
    </section>
  );
};
