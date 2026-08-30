import React from 'react';
import { Map, BookOpen, Gauge, ShieldAlert, Sparkles, Scale, LineChart, Users2 } from 'lucide-react';
import { Reveal, RevealGroup, RevealItem } from './Reveal';

const FEATURES = [
  {
    icon: Map,
    color: 'orange',
    title: 'Multi-Layer Heat Mapping',
    description:
      'Beyond a single temperature snapshot: switch between Temperature, Exceedance, Persistence, and Peak-Time views to see not just how hot a place is, but how long it stays dangerous and when.',
  },
  {
    icon: BookOpen,
    color: 'amber',
    title: 'Heat Story',
    description:
      'A plain-language narrative of how heat built up over the day — what changed, why, and how today compares with yesterday — instead of a wall of raw numbers.',
  },
  {
    icon: Gauge,
    color: 'red',
    title: 'Composite Risk Scoring',
    description:
      'Temperature, heat index, wet-bulb stress, solar load, and persistence are fused into a single confidence-scored risk index, with every driver ranked by contribution — then reframed as tailored precautions for whoever\'s asking: residents, outdoor workers, farmers, or facility operators.',
  },
  {
    icon: ShieldAlert,
    color: 'red',
    title: 'Heat Emergency Mode',
    description:
      'When conditions cross critical thresholds, Thermora automatically re-prioritizes zones and answers four questions: Where? Why? Who is exposed? What should we do?',
  },
  {
    icon: Sparkles,
    color: 'orange',
    title: 'AI Decision Agent',
    description:
      'Ask direct operational questions — "Which areas need attention?", "Why is this zone hotter?" — and get a ranked, action-oriented brief instead of a chat transcript.',
  },
  {
    icon: Scale,
    color: 'blue',
    title: 'City & Time Comparison',
    description:
      'Put two or more cities side by side, or compare the same city across two different time windows — either way, an "Ask AI" button explains the difference in plain language, grounded in the real numbers on screen.',
  },
  {
    icon: LineChart,
    color: 'emerald',
    title: 'Research & Historical Trends',
    description:
      'Track mean, maximum, persistence, and exceedance over custom time ranges, with an "Ask AI" explanation and a one-click CSV export sitting right next to every chart.',
  },
  {
    icon: Users2,
    color: 'amber',
    title: 'Who/What Is Exposed',
    description:
      'Overlay schools, hospitals, care facilities, and outdoor workforces onto every hotspot, so a "hot place" becomes "a hot place where specific people are at risk."',
  },
];

const COLOR_MAP = {
  orange: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-400' },
  amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-400' },
  red: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-400' },
  blue: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-400' },
  emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400' },
};

export const FeaturesSection = () => {
  return (
    <section id="features" className="py-20 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 scroll-mt-20">
      <Reveal className="text-center max-w-2xl mx-auto mb-14">
        <span className="text-xs font-mono font-bold uppercase tracking-widest text-orange-400 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20">
          Features
        </span>
        <h2 className="text-3xl sm:text-4xl font-black text-ink mt-4 tracking-tight font-display">
          Everything you need to move from data to decision
        </h2>
        <p className="text-inkmuted text-sm sm:text-base mt-3">
          Each feature below answers a specific operational question, so nothing sits on screen
          without a clear purpose.
        </p>
      </Reveal>

      <RevealGroup className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5" stagger={0.07}>
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          const c = COLOR_MAP[feature.color];
          return (
            <RevealItem key={feature.title}>
              <div className="h-full bg-surface/60 rounded-[1.75rem] p-6 border border-border hover:border-borderstrong hover:-translate-y-1 hover:shadow-xl transition-all duration-300 group">
                <div
                  className={`w-11 h-11 rounded-2xl ${c.bg} border ${c.border} flex items-center justify-center ${c.text} mb-4 group-hover:scale-110 transition-transform duration-300`}
                >
                  <Icon className="w-5 h-5" />
                </div>
                <h4 className="text-sm font-bold text-ink leading-snug">{feature.title}</h4>
                <p className="text-xs text-inkmuted mt-2.5 leading-relaxed">{feature.description}</p>
              </div>
            </RevealItem>
          );
        })}
      </RevealGroup>
    </section>
  );
};