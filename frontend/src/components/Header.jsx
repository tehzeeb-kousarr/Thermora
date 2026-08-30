import React, { useState } from 'react';
import { Search, MapPin, ShieldAlert, Sparkles, ChevronDown, Menu } from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { ApiStatusBadge } from './ApiStatusBadge';

export const Header = ({
  activeCity,
  cities = [],
  onSelectCity,
  onOpenEmergency,
  onOpenAIAgent,
  userSettings,
  onToggleMobileSidebar
}) => {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const filteredCities = cities.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()) || c.state.toLowerCase().includes(searchQuery.toLowerCase()));
  // Header chrome sits above every ordinary tab's content, including
  // HeatMapView's in-page floating controls (z-[1000], calibrated to sit
  // above Leaflet's own internal control layer) — z-[1200]/1210 here is
  // comfortably above any current or future per-tab z-index so the
  // dropdown can never again render behind a specific view's own overlays.
  // True global overlays that should cover the header too (AuthModal,
  // AIAgentDrawer) are bumped even higher, to z-[1300].
  return <header className="h-16 bg-surface/50 backdrop-blur-md border-b border-border px-4 sm:px-6 flex items-center justify-between z-[1200] sticky top-0 text-ink">
      {/* Left: Location Switcher & Live Status */}
      <div className="flex items-center gap-2 sm:gap-4">
        {/* Mobile Sidebar Hamburger Toggle */}
        {onToggleMobileSidebar && <button id="mobile-sidebar-toggle-btn" onClick={onToggleMobileSidebar} className="md:hidden p-2 rounded-xl bg-surface2/80 border border-borderstrong/60 hover:bg-surface3 text-inksoft hover:text-ink transition-all cursor-pointer" aria-label="Toggle Navigation Menu">
            <Menu className="w-4 h-4" />
          </button>}

        {/* City Dropdown Selector */}
        <div className="relative">
          <button id="header-location-dropdown-btn" onClick={() => setDropdownOpen(!dropdownOpen)} className="flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-full bg-surface2/80 border border-borderstrong/60 hover:border-orange-500/50 text-xs sm:text-sm font-semibold text-ink transition-all cursor-pointer shadow-sm">
            <MapPin className="w-3.5 h-3.5 text-orange-400" />
            <span className="truncate max-w-[120px] sm:max-w-none">{activeCity.name}, {activeCity.state}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-inkmuted transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {dropdownOpen && <div className="absolute left-0 mt-2 w-72 rounded-2xl bg-surface/95 border border-border shadow-2xl p-2 z-[1210] animate-fadeIn backdrop-blur-xl">
              <div className="relative mb-2">
                <Search className="w-3.5 h-3.5 text-inkmuted absolute left-3 top-1/2 -translate-y-1/2" />
                <input type="text" placeholder="Search locations..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="w-full bg-surface2 border-none rounded-full pl-8 pr-3 py-1.5 text-xs text-ink placeholder:text-inkfaint focus:outline-none focus:ring-1 focus:ring-orange-500" />
              </div>

              <div className="max-h-60 overflow-y-auto space-y-1">
                {filteredCities.map(city => <button key={city.id} onClick={() => {
              onSelectCity(city.id);
              setDropdownOpen(false);
            }} className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs transition-all text-left cursor-pointer ${city.id === activeCity.id ? 'bg-orange-500/15 text-orange-300 font-semibold border border-orange-500/30' : 'hover:bg-surface2/80 text-inksoft'}`}>
                    <div className="min-w-0">
                      <div className="font-medium text-ink truncate">{city.name}</div>
                      <div className="text-[10px] text-inkmuted">{city.state}</div>
                    </div>
                  </button>)}
              </div>
            </div>}
        </div>

        <div className="hidden lg:block h-5 w-px bg-surface2"></div>

        {/* Live Status Pill */}
        <div className="hidden sm:flex items-center gap-2.5 text-sm text-inkmuted font-medium uppercase tracking-widest text-[11px]">
          <ApiStatusBadge />
        </div>
      </div>

      {/* Right: Role Badge & Action Controls */}
      <div className="flex items-center gap-3">
        {/* Theme Toggle */}
        <ThemeToggle />

        {/* Thermora AI Intelligence Trigger */}
        <button id="sidebar-ai-agent-btn" onClick={() => {
          onOpenAIAgent();
        }}  className="px-3.5 py-1.5 rounded-full bg-gradient-to-r from-orange-500/10 to-red-500/10 hover:from-orange-500/20 hover:to-red-500/20 border border-orange-500/30 text-orange-300 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-[0_0_15px_rgba(249,115,22,0.15)]">
          <Sparkles className="w-3.5 h-3.5 text-orange-400" />
          <span className="hidden xl:inline">AI Agent</span>
        </button>

        {/* Emergency Mode Direct Button */}
        <button id="header-emergency-mode-btn" onClick={onOpenEmergency} className="px-3.5 py-1.5 rounded-full bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-red-400 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow-[0_0_15px_rgba(239,68,68,0.25)] animate-pulse">
          <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
          <span className="hidden sm:inline">Emergency</span>
        </button>
      </div>
    </header>;
};
