import React, { useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';
import { Reveal } from './Reveal';

const FAQS = [
  {
    q: 'What data sources power Thermora?',
    a: 'Three complementary sources, kept deliberately disciplined: FortyGuard supplies hyperlocal temperature and environmental intelligence ("what the heat is"), OpenStreetMap supplies spatial exposure context like schools, hospitals, and roads ("who/what is exposed"), and NWS supplies official alerts and advisories ("what authorities are officially saying"). Thermora fuses the three into a decision layer on top.',
  },
  {
    q: 'How is the Risk Score actually calculated?',
    a: 'It\'s a composite of several physical drivers — surface temperature, heat index, wet-bulb stress, solar irradiance, and continuous persistence — each contributing a weighted share, alongside a confidence value. Every score comes with its underlying drivers listed, so nothing is a black box.',
  },
  {
    q: 'What\'s the difference between the four Heat Map layers?',
    a: 'Temperature shows the current reading. Exceedance shows how many hours a location has spent above a chosen threshold. Persistence shows the longest continuous stretch of dangerous heat. Peak Time shows when a location typically becomes hottest. Together they answer "how hot," "how long," and "when" — not just one snapshot.',
  },
  {
    q: 'Does Thermora replace on-the-ground judgment?',
    a: 'No — it\'s built to inform decisions, not make them unilaterally. Recommendations are meant to give operators, emergency directors, and facility managers a faster, better-grounded starting point, with the reasoning always visible so it can be checked against local knowledge.',
  },
  {
    q: 'Can Thermora integrate with our existing tools?',
    a: 'The platform is a documented REST API (FastAPI) underneath the dashboard — every risk score, emergency ranking, and recommendation the UI shows is available the same way to any system that calls it. There\'s no built-in SMS or dispatch product yet; today, integration means wiring your own tooling up to that API.',
  },
  {
    q: 'Is historical data and trend analysis available?',
    a: 'Yes, through Research Mode — mean, maximum, persistence, and exceedance can all be tracked over custom time ranges, so you can evaluate whether mitigation efforts (tree canopy, cool roofing, cooling center placement) are measurably changing outcomes over time.',
  },
  {
    q: 'How often does the data refresh?',
    a: 'The platform is designed around continuous, near-real-time updates from FortyGuard\'s sensing layer, rather than a single daily reading — conditions on the dashboard are meant to reflect what\'s happening now, not what happened this morning.',
  },
];

const FAQItem = ({ item, isOpen, onToggle }) => (
  <div className="border-b border-border last:border-b-0">
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-4 py-5 text-left cursor-pointer group"
    >
      <span className="text-sm sm:text-base font-bold text-ink group-hover:text-orange-300 transition-colors">
        {item.q}
      </span>
      <ChevronDown
        className={`w-4 h-4 text-inkmuted shrink-0 transition-transform duration-300 ${
          isOpen ? 'rotate-180 text-orange-400' : ''
        }`}
      />
    </button>
    {/* CSS-only smooth expand/collapse via grid-template-rows, no JS height measurement */}
    <div
      className="grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
      style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}
    >
      <div className="overflow-hidden">
        <p className="text-xs sm:text-sm text-inkmuted leading-relaxed pb-5 pr-8">{item.a}</p>
      </div>
    </div>
  </div>
);

export const FAQSection = () => {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <section id="faq" className="py-20 sm:py-24 bg-surface/40 border-y border-border scroll-mt-20">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <Reveal className="text-center mb-12">
          <span className="inline-flex items-center gap-1.5 text-xs font-mono font-bold uppercase tracking-widest text-orange-400 px-3 py-1 rounded-full bg-orange-500/10 border border-orange-500/20">
            <HelpCircle className="w-3.5 h-3.5" />
            FAQ
          </span>
          <h2 className="text-3xl sm:text-4xl font-black text-ink mt-4 tracking-tight font-display">
            Frequently asked questions
          </h2>
          <p className="text-inkmuted text-sm sm:text-base mt-3">
            Straightforward answers about how Thermora sources data, models risk, and fits into
            existing operations.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="rounded-[2rem] bg-surface/60 border border-border px-6 sm:px-8 shadow-xl">
            {FAQS.map((item, idx) => (
              <FAQItem
                key={item.q}
                item={item}
                isOpen={openIndex === idx}
                onToggle={() => setOpenIndex(openIndex === idx ? -1 : idx)}
              />
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
};