import React, { useState } from 'react';
import { Factory, ShieldAlert, Tractor, ArrowRight } from 'lucide-react';
import { Reveal } from './Reveal';
import { motion, AnimatePresence } from 'motion/react';

const SCENARIOS = [
  {
    id: 'industrial',
    icon: Factory,
    tag: 'Industrial & Logistics',
    title: 'Industrial Heat Corridor Response',
    challenge:
      'A dense corridor of warehouses, ports, and uninsulated industrial facilities holds heat long after surrounding areas cool down, putting outdoor and loading-dock crews at sustained risk through the afternoon.',
    approach:
      'Thermora\'s persistence and exceedance layers isolate exactly which blocks stay dangerous longest, then cross-reference outdoor workforce density from the exposure layer to rank facilities by urgency.',
    outcome:
      'Shift planners get a concrete, defensible work-window recommendation instead of relying on a single citywide heat advisory that treats every block the same.',
  },
  {
    id: 'emergency',
    icon: ShieldAlert,
    tag: 'Emergency Services',
    title: 'Coastal Metro Emergency Coordination',
    challenge:
      'When an official Excessive Heat Warning is issued, emergency directors need to decide where to stage resources first — but a warning boundary alone doesn\'t say which neighborhoods are actually most vulnerable.',
    approach:
      'Emergency Mode combines live thermal persistence with proximity to hospitals, senior care facilities, and dense residential blocks to produce a ranked priority list the moment thresholds are crossed.',
    outcome:
      'Response teams get a clear, ordered list of where to act first, backed by the specific drivers behind each ranking — not a uniform red map.',
  },
  {
    id: 'agriculture',
    icon: Tractor,
    tag: 'Agriculture & Field Labor',
    title: 'Seasonal Field Labor Safety Program',
    challenge:
      'Outdoor agricultural work continues through peak summer heat, and generic daily forecasts don\'t capture how wet-bulb stress changes hour to hour across different fields and terrain.',
    approach:
      'Wet-bulb globe temperature and solar irradiance are tracked continuously, and Thermora recommends specific safe work windows and mandatory rest-cycle timing tailored to each site.',
    outcome:
      'Crew leads get a data-grounded shift plan they can act on directly, instead of a single blanket heat-safety bulletin for the whole region.',
  },
];

export const CaseStudiesSection = () => {
  const [activeId, setActiveId] = useState(SCENARIOS[0].id);
  const active = SCENARIOS.find((s) => s.id === activeId) || SCENARIOS[0];

  return (
    <section id="case-studies" className="py-20 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 scroll-mt-20">
      <Reveal className="text-center max-w-2xl mx-auto mb-4">
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-orange-400 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20">
          Case Studies
        </span>
        <h2 className="text-3xl sm:text-4xl font-black text-ink mt-4 tracking-tight font-display">
          Illustrative operational scenarios
        </h2>
        <p className="text-inkmuted text-sm sm:text-base mt-3">
          Representative examples of how the same underlying engine adapts to different
          operational needs. Presented for illustration, not as verified performance figures.
        </p>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-10 rounded-[2rem] bg-surface/60 border border-border shadow-2xl overflow-hidden">
          {/* Tab strip */}
          <div className="flex flex-col sm:flex-row border-b border-border">
            {SCENARIOS.map((s) => {
              const Icon = s.icon;
              const isActive = s.id === activeId;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className={`relative flex-1 flex items-center gap-3 px-6 py-5 text-left transition-colors cursor-pointer ${
                    isActive ? 'bg-app/60' : 'hover:bg-app/30'
                  }`}
                >
                  <div
                    className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                      isActive
                        ? 'bg-orange-500/20 border border-orange-500/40 text-orange-400'
                        : 'bg-surface2 border border-border text-inkmuted'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                  </div>
                  <div>
                    <div
                      className={`text-[10px] font-mono uppercase tracking-wider font-bold ${
                        isActive ? 'text-orange-400' : 'text-inkfaint'
                      }`}
                    >
                      {s.tag}
                    </div>
                    <div className={`text-sm font-bold ${isActive ? 'text-ink' : 'text-inksoft'}`}>
                      {s.title}
                    </div>
                  </div>
                  {isActive && (
                    <motion.div
                      layoutId="case-study-underline"
                      className="absolute bottom-0 left-0 right-0 h-0.5 bg-orange-500 sm:hidden"
                    />
                  )}
                  {isActive && (
                    <motion.div
                      layoutId="case-study-underline-side"
                      className="hidden sm:block absolute left-0 top-0 bottom-0 w-0.5 bg-orange-500"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Active scenario detail */}
          <div className="p-8 sm:p-10 min-h-[280px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={active.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                className="grid grid-cols-1 md:grid-cols-3 gap-8"
              >
                <div>
                  <h5 className="text-[11px] font-mono font-bold uppercase tracking-widest text-red-400 mb-2">
                    The Challenge
                  </h5>
                  <p className="text-sm text-inksoft leading-relaxed">{active.challenge}</p>
                </div>
                <div>
                  <h5 className="text-[11px] font-mono font-bold uppercase tracking-widest text-orange-400 mb-2">
                    Thermora's Approach
                  </h5>
                  <p className="text-sm text-inksoft leading-relaxed">{active.approach}</p>
                </div>
                <div>
                  <h5 className="text-[11px] font-mono font-bold uppercase tracking-widest text-emerald-400 mb-2">
                    The Outcome
                  </h5>
                  <p className="text-sm text-inksoft leading-relaxed">{active.outcome}</p>
                </div>
              </motion.div>
            </AnimatePresence>

            <div className="mt-8 pt-6 border-t border-border flex items-center justify-between">
              <span className="text-[11px] text-inkfaint font-mono uppercase tracking-wider">
                Scenario {SCENARIOS.findIndex((s) => s.id === activeId) + 1} of {SCENARIOS.length}
              </span>
              <button
                onClick={() => {
                  const idx = SCENARIOS.findIndex((s) => s.id === activeId);
                  setActiveId(SCENARIOS[(idx + 1) % SCENARIOS.length].id);
                }}
                className="text-xs font-bold text-orange-400 hover:text-orange-300 flex items-center gap-1.5 cursor-pointer transition-colors"
              >
                <span>Next scenario</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
};
