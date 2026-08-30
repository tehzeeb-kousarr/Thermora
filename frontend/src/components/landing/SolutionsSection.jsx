import React from 'react';
import { Building2, ShieldAlert, Users, CheckCircle2 } from 'lucide-react';
import { Reveal, RevealGroup, RevealItem } from './Reveal';

const SOLUTIONS = [
  {
    icon: Building2,
    color: 'orange',
    title: 'Municipal & City Resilience',
    description:
      'Target cooling resources to the exact microclimate hotspot blocks that need them, and track whether long-term mitigation efforts are actually moving the needle year over year.',
    points: ['Hotspot-Ranked Resource Targeting', 'Month-over-Month Trend Tracking'],
  },
  {
    icon: ShieldAlert,
    color: 'red',
    title: 'Emergency Services',
    description:
      'Prioritize response near high-persistence corridors with vulnerable senior housing and dense populations before conditions escalate, guided by a ranked, defensible priority list.',
    points: ['4-Question Emergency Mode', 'Cross-Checked Against Official NWS Alerts'],
  },
  {
    icon: Users,
    color: 'emerald',
    title: 'Construction & Facility Ops',
    description:
      'Give crews wet-bulb-informed, persona-specific precautions — for residents, outdoor workers, farmers, or facility operators — instead of one generic heat-safety bulletin for everyone.',
    points: ['Persona-Tailored Local Advisor', 'Ask AI to Explain Any Reading, On Demand'],
  },
];

const COLOR_MAP = {
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400' },
  red: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
};

export const SolutionsSection = () => {
  return (
    <section id="solutions" className="py-20 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 scroll-mt-20">
      <Reveal className="text-center max-w-2xl mx-auto mb-14">
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-orange-400 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20">
          Solutions
        </span>
        <h2 className="text-3xl sm:text-4xl font-black text-ink mt-4 tracking-tight font-display">
          Built for high-stakes thermal operations
        </h2>
        <p className="text-inkmuted text-sm sm:text-base mt-3">
          Tailored decision environments for public leaders, emergency teams, and site operators —
          the same engine, shaped around each team's actual decisions.
        </p>
      </Reveal>

      <RevealGroup className="grid grid-cols-1 md:grid-cols-3 gap-6" stagger={0.1}>
        {SOLUTIONS.map((sol) => {
          const Icon = sol.icon;
          const c = COLOR_MAP[sol.color];
          return (
            <RevealItem key={sol.title}>
              <div className="h-full bg-surface/60 rounded-[2rem] p-7 border border-border hover:border-borderstrong hover:-translate-y-1 transition-all duration-300">
                <div className={`w-10 h-10 rounded-2xl ${c.bg} border ${c.border} flex items-center justify-center ${c.text} mb-4`}>
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="text-lg font-bold text-ink">{sol.title}</h4>
                <p className="text-xs text-inksoft mt-2 leading-relaxed">{sol.description}</p>
                <ul className="mt-4 space-y-2 text-xs text-inkmuted font-mono">
                  {sol.points.map((p) => (
                    <li key={p} className="flex items-center gap-1.5 text-inksoft">
                      <CheckCircle2 className={`w-3.5 h-3.5 ${c.text}`} />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            </RevealItem>
          );
        })}
      </RevealGroup>
    </section>
  );
};