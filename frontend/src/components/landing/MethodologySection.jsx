import React from 'react';
import { Database, Layers3, Cpu, ClipboardList, BadgeCheck } from 'lucide-react';
import { Reveal } from './Reveal';

const STEPS = [
  {
    icon: Database,
    title: 'Ingest',
    description:
      'Hyperlocal temperature, humidity, solar irradiance, and surface conditions are pulled continuously from the FortyGuard sensing layer — not a single daily reading, but a live stream.',
  },
  {
    icon: Layers3,
    title: 'Contextualize',
    description:
      'Spatial exposure data from OpenStreetMap is layered on top: schools, hospitals, care facilities, roads, and green space, so raw heat is tied to the people and places near it.',
  },
  {
    icon: Cpu,
    title: 'Model',
    description:
      'A composite risk score is calculated from persistence, exceedance, solar load, and wet-bulb stress — each weighted and paired with a confidence value, never a single black-box number.',
  },
  {
    icon: ClipboardList,
    title: 'Recommend',
    description:
      'The score is translated into a concrete action plan: safe work windows, cooling-resource priorities, and a scheduled re-evaluation interval — not just a color on a map.',
  },
  {
    icon: BadgeCheck,
    title: 'Validate',
    description:
      'Every recommendation is cross-checked against official NOAA / NWS alerts, so Thermora\'s guidance stays grounded in authoritative context rather than modeled data alone.',
  },
];

export const MethodologySection = () => {
  return (
    <section id="methodology" className="py-20 sm:py-24 bg-surface/40 border-y border-border scroll-mt-20">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <Reveal className="text-center max-w-2xl mx-auto mb-16">
          <span className="text-xs font-mono font-bold uppercase tracking-widest text-orange-400 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20">
            Methodology
          </span>
          <h2 className="text-3xl sm:text-4xl font-black text-ink mt-4 tracking-tight font-display">
            How a reading becomes a recommendation
          </h2>
          <p className="text-inkmuted text-sm sm:text-base mt-3">
            Five deliberate stages turn a sensor reading into an accountable operational decision.
          </p>
        </Reveal>

        <div className="relative">
          {/* Connecting spine (desktop only) */}
          <div className="hidden sm:block absolute left-[27px] top-4 bottom-4 w-px bg-gradient-to-b from-orange-500/50 via-border to-transparent" />

          <div className="space-y-8 sm:space-y-10">
            {STEPS.map((step, idx) => {
              const Icon = step.icon;
              return (
                <Reveal key={step.title} delay={idx * 0.06} y={16}>
                  <div className="flex items-start gap-5 sm:gap-6">
                    <div className="relative shrink-0 z-10">
                      <div className="w-14 h-14 rounded-2xl bg-app border-2 border-orange-500/40 flex items-center justify-center text-orange-400 shadow-lg shadow-orange-500/10">
                        <Icon className="w-6 h-6" />
                      </div>
                      <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-orange-500 text-zinc-950 text-[10px] font-black flex items-center justify-center border-2 border-app">
                        {idx + 1}
                      </span>
                    </div>
                    <div className="pt-2.5">
                      <h4 className="text-base font-bold text-ink">{step.title}</h4>
                      <p className="text-sm text-inkmuted mt-1.5 leading-relaxed max-w-2xl">
                        {step.description}
                      </p>
                    </div>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
};
