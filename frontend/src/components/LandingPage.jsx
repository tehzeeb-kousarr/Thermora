import React, { useState, useEffect } from 'react';
import { Flame, ArrowRight, Sparkles } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { HeroSection } from './landing/HeroSection';
import { ArchitectureSection } from './landing/ArchitectureSection';
import { FeaturesSection } from './landing/FeaturesSection';
import { MethodologySection } from './landing/MethodologySection';
import { SolutionsSection } from './landing/SolutionsSection';
import { CaseStudiesSection } from './landing/CaseStudiesSection';
import { FAQSection } from './landing/FAQSection';
import { FooterSection } from './landing/FooterSection';

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#methodology', label: 'Methodology' },
  { href: '#solutions', label: 'Solutions' },
  { href: '#case-studies', label: 'Case Studies' },
  { href: '#faq', label: 'FAQ' },
];

export const LandingPage = ({ cities = [], onEnterDashboard, onOpenAuth }) => {
  const [selectedDemoCity, setSelectedDemoCity] = useState(cities[0]?.id);
  useEffect(() => { if (!selectedDemoCity && cities[0]) setSelectedDemoCity(cities[0].id); }, [cities, selectedDemoCity]);
  const activeDemo = cities.find((c) => c.id === selectedDemoCity) || cities[0];

  return (
    <div className="min-h-screen bg-app text-ink font-sans selection:bg-orange-500/30 selection:text-orange-200 scroll-smooth">

      {/* Navigation */}
      <header className="border-b border-border/80 backdrop-blur-xl bg-app/80 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-orange-500 to-red-600 p-0.5 flex items-center justify-center shadow-lg shadow-orange-500/20">
              <div className="w-full h-full bg-app rounded-[14px] flex items-center justify-center">
                <Flame className="w-5 h-5 text-orange-400" />
              </div>
            </div>
            <div>
              <span className="text-xl font-black tracking-tight bg-gradient-to-r from-orange-400 via-amber-300 to-red-400 bg-clip-text text-transparent font-display">
                THERMORA
              </span>
              <span className="hidden sm:inline-block ml-2 text-[10px] uppercase font-mono tracking-widest text-inkmuted px-2 py-0.5 rounded-full bg-surface border border-border">
                Decision OS
              </span>
            </div>
          </div>

          {/* Section nav links (desktop only) */}
          <nav className="hidden lg:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="px-3 py-2 rounded-lg text-xs font-semibold text-inkmuted hover:text-ink hover:bg-surface2 transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <ThemeToggle />

            <button
              id="landing-signin-btn"
              onClick={() => onOpenAuth('signin')}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-inksoft hover:text-ink bg-surface hover:bg-surface2 border border-border transition-all cursor-pointer"
            >
              Sign In
            </button>

            <button
              id="landing-signup-btn"
              onClick={() => onOpenAuth('signup')}
              className="px-5 py-2 rounded-xl text-xs font-bold text-zinc-950 bg-gradient-to-r from-orange-400 via-amber-400 to-orange-300 hover:from-orange-300 hover:to-amber-300 shadow-md shadow-orange-500/20 transition-all cursor-pointer hidden sm:flex items-center gap-1"
            >
              <span>Operator Sign Up</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <HeroSection
        CITIES={cities}
        selectedDemoCity={selectedDemoCity}
        setSelectedDemoCity={setSelectedDemoCity}
        activeDemo={activeDemo}
        onOpenAuth={onOpenAuth}
      />

      <FeaturesSection />

      <ArchitectureSection />

      <MethodologySection />

      <SolutionsSection />

      <CaseStudiesSection />

      <FAQSection />

      <FooterSection onOpenAuth={onOpenAuth} />
    </div>
  );
};