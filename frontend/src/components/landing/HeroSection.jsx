import React from 'react';
import { Flame, ArrowRight, CheckCircle2, Radio, Sparkles, ChevronDown } from 'lucide-react';
import { motion } from 'motion/react';
import { StepStrip } from './StepStrip';
import ThermalTerrain3D from './ThermalTerrain3D';

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
};
const item = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
};

export const HeroSection = ({ CITIES, selectedDemoCity, setSelectedDemoCity, activeDemo, onOpenAuth }) => {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  return (
    <>
      {/* Hero Section */}
      <section className="relative overflow-hidden pt-16 pb-20 lg:pt-24 lg:pb-28">
        {/* Flat gradient backdrop — quiet dark vignette base */}
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-app via-app to-app" />
        <div className="absolute inset-0 -z-10 bg-gradient-to-r from-orange-950/10 via-transparent to-red-950/10" />

        {/* Interactive 3D signature visual — treated as a light source, not a
            layered image. mix-blend-mode: screen drops the dark background
            of the canvas entirely and lets only the warm bright terrain
            glow through, so it reads as ambient light rather than a shape
            fading out. z-0 keeps it behind the z-10 content per CSS
            stacking rules for positioned elements. */}
        <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
          {/* warm glow bloom sitting behind the terrain for extra light falloff */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse 55% 45% at 50% 32%, rgba(251,146,60,0.16), rgba(251,146,60,0) 70%)',
            }}
          />
          <div
            className="absolute inset-0 -bottom-24"
            style={{ mixBlendMode: 'screen' }}
          >
            <ThermalTerrain3D
              className="absolute inset-0 w-full h-full"
              opacity={0.05}
              fadeRadius={0.3}
              fadeSoftness={0.55}
            />
          </div>
          {/* gentle directional fade so edges settle into the page background */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-void/20 to-void" />
          <div className="absolute inset-0 bg-gradient-to-r from-void/80 via-transparent to-void/80" />
        </div>

        <motion.div
          className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center"
          variants={container}
          initial="hidden"
          animate="show"
        >
          <motion.div
            variants={item}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-surface/90 border border-border text-xs text-orange-300 font-mono mb-8 shadow-inner"
          >
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-led-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
            <span>Microclimate Intelligence</span>
          </motion.div>

          <motion.h1
            variants={item}
            className="text-4xl sm:text-6xl lg:text-7xl font-black tracking-tight text-ink max-w-4xl mx-auto leading-[1.08] font-display"
          >
            Understand Heat. <br />
            <span className="bg-gradient-to-r from-orange-400 via-amber-400 to-red-500 bg-clip-text text-transparent bg-[length:200%_auto]">
              Protect People.
            </span>
          </motion.h1>

          <motion.p
            variants={item}
            className="mt-6 text-lg sm:text-xl text-inksoft max-w-2xl mx-auto leading-relaxed font-normal"
          >
            Hyperlocal temperature intelligence for cities, communities &amp; operations. Thermora
            transforms raw sensor layers and spatial exposure data into{' '}
            <span className="text-orange-300 font-semibold">immediate, actionable decisions</span>.
          </motion.p>

          {/* Central Call to Action */}
          <motion.div variants={item} className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              id="hero-enter-thermora-btn"
              onClick={() => onOpenAuth('signin')}
              className="w-full sm:w-auto px-8 py-4 rounded-2xl text-base font-black text-zinc-950 bg-gradient-to-r from-orange-400 via-amber-400 to-orange-300 hover:from-orange-300 hover:to-amber-300 shadow-xl shadow-orange-500/25 hover:shadow-2xl hover:shadow-orange-500/30 hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 cursor-pointer"
            >
              <Flame className="w-5 h-5 text-zinc-950" />
              <span>Enter Thermora Dashboard</span>
              <ArrowRight className="w-5 h-5" />
            </button>

            {/* Demo city picker — was hardcoded to Houston regardless of selection; now actually respects selectedDemoCity */}
            <div className="relative w-full sm:w-auto">
              <div className="flex items-stretch rounded-2xl border border-border bg-surface/90 overflow-hidden">
                <button
                  id="hero-demo-city-picker-btn"
                  onClick={() => setPickerOpen(!pickerOpen)}
                  className="px-4 py-4 text-sm font-semibold text-ink hover:bg-surface2 transition-all flex items-center gap-2 cursor-pointer border-r border-border"
                >
                  <span>{activeDemo?.name || 'Choose city'}</span>
                  <ChevronDown className={`w-4 h-4 text-inkmuted transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
                </button>
                <button
                  id="hero-demo-mode-btn"
                  onClick={() => onOpenAuth('signup')}
                  className="px-5 py-4 text-base font-semibold text-ink hover:bg-surface2 border-borderstrong hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Radio className="w-4 h-4 text-emerald-400 animate-pulse" />
                  <span>Explore Demo</span>
                </button>
              </div>

              {pickerOpen && (
                <div className="absolute left-0 mt-2 w-56 rounded-2xl bg-surface border border-border shadow-2xl p-2 z-50">
                  {(CITIES || []).map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setSelectedDemoCity(c.id);
                        setPickerOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 rounded-xl text-xs transition-all cursor-pointer ${
                        c.id === selectedDemoCity ? 'bg-orange-500/15 text-orange-300 font-semibold' : 'hover:bg-surface2 text-inksoft'
                      }`}
                    >
                      {c.name}, {c.state}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>

          <motion.div
            variants={item}
            className="mt-8 flex flex-wrap items-center justify-center gap-6 text-xs text-inkmuted font-mono"
          >
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-orange-400" />
              Built with FortyGuard Temperature API
            </span>
          </motion.div>
        </motion.div>
      </section>
      <StepStrip />

  </>
  );
};