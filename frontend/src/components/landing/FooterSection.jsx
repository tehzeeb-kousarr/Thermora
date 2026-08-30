import React from 'react';
import { Flame, ArrowRight, Github, Linkedin, Twitter, Mail } from 'lucide-react';

const PRODUCT_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#methodology', label: 'Methodology' },
  { href: '#solutions', label: 'Solutions' },
  { href: '#case-studies', label: 'Case Studies' },
];

const DATA_SOURCES = [
  'FortyGuard Temperature API',
  'OSM Exposure Layer',
  'NOAA / NWS Heat Alerts',
];

const COMPANY_LINKS = [
  { href: '#', label: 'About Thermora' },
  { href: '#', label: 'Contact' },
];

const LEGAL_LINKS = [
  { href: '#', label: 'Privacy Policy' },
  { href: '#', label: 'Terms of Service' },
];

const SOCIAL_LINKS = [
  { href: '#', label: 'X (Twitter)', Icon: Twitter },
  { href: '#', label: 'LinkedIn', Icon: Linkedin },
  { href: '#', label: 'GitHub', Icon: Github },
];

const FooterColumn = ({ title, children }) => (
  <div>
    <h4 className="text-[11px] font-bold uppercase tracking-[0.16em] text-inkfaint font-mono mb-4">
      {title}
    </h4>
    {children}
  </div>
);

export const FooterSection = ({ onOpenAuth }) => {
  return (
    <footer className="border-t border-border bg-app">
      {/* CTA banner */}
      <div className="border-b border-border/80 bg-gradient-to-b from-orange-950/10 to-transparent">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 flex flex-col lg:flex-row items-center justify-between gap-6">
          <div className="text-center lg:text-left">
            <h3 className="text-2xl sm:text-3xl font-black tracking-tight text-ink font-display">
              Ready to see your exposure map?
            </h3>
            <p className="mt-2 text-sm text-inkmuted max-w-md">
              Step into the live operational dashboard — no setup, real thermal data, right now.
            </p>
          </div>
          <button
            id="footer-enter-platform-btn"
            onClick={() => onOpenAuth('signup')}
            className="shrink-0 px-7 py-3.5 rounded-xl text-sm font-black text-zinc-950 bg-gradient-to-r from-orange-400 via-amber-400 to-orange-300 hover:from-orange-300 hover:to-amber-300 shadow-lg shadow-orange-500/25 hover:shadow-xl hover:shadow-orange-500/30 hover:-translate-y-0.5 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <span>Enter Platform</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Link columns */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 grid grid-cols-2 lg:grid-cols-12 gap-10">
        {/* Brand block */}
        <div className="col-span-2 lg:col-span-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-orange-500 to-red-600 p-0.5 flex items-center justify-center shadow-lg shadow-orange-500/20">
              <div className="w-full h-full bg-app rounded-[14px] flex items-center justify-center">
                <Flame className="w-5 h-5 text-orange-400" />
              </div>
            </div>
            <span className="text-lg font-black tracking-tight bg-gradient-to-r from-orange-400 via-amber-300 to-red-400 bg-clip-text text-transparent font-display">
              THERMORA
            </span>
          </div>
          <p className="mt-4 text-sm text-inkmuted leading-relaxed max-w-xs">
            Hyperlocal temperature intelligence for cities, communities &amp; operations —
            turning raw heat data into decisions that protect people.
          </p>
          <a
            href="mailto:ops@thermora.io"
            className="mt-5 inline-flex items-center gap-2 text-xs font-semibold text-inksoft hover:text-orange-300 transition-colors"
          >
            <Mail className="w-3.5 h-3.5" />
            ops@thermora.io
          </a>
        </div>

        <div className="col-span-1 lg:col-span-2">
          <FooterColumn title="Product">
            <ul className="space-y-3">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="text-sm text-inksoft hover:text-orange-300 transition-colors"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </FooterColumn>
        </div>

        <div className="col-span-1 lg:col-span-2">
          <FooterColumn title="Data Sources">
            <ul className="space-y-3">
              {DATA_SOURCES.map((source) => (
                <li key={source} className="text-sm text-inksoft">
                  {source}
                </li>
              ))}
            </ul>
          </FooterColumn>
        </div>

        <div className="col-span-1 lg:col-span-2">
          <FooterColumn title="Company">
            <ul className="space-y-3">
              {COMPANY_LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-inksoft hover:text-orange-300 transition-colors"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </FooterColumn>
        </div>

        <div className="col-span-1 lg:col-span-2">
          <FooterColumn title="Legal">
            <ul className="space-y-3">
              {LEGAL_LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-inksoft hover:text-orange-300 transition-colors"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </FooterColumn>
        </div>
      </div>

      {/* Bottom bar — status + social + copyright, echoing the ticker's
          live-monitoring visual language rather than a plain divider line */}
      <div className="border-t border-border/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <span className="text-xs text-inkfaint font-mono">
              © {new Date().getFullYear()} Thermora / FortyGuard Systems
            </span>
          </div>

          <div className="flex items-center gap-1">
            {SOCIAL_LINKS.map(({ href, label, Icon }) => (
              <a
                key={label}
                href={href}
                aria-label={label}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-inkmuted hover:text-orange-300 hover:bg-surface2 border border-transparent hover:border-border transition-all"
              >
                <Icon className="w-4 h-4" />
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
};