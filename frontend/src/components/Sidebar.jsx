import React from 'react';
import { Flame, LayoutDashboard, Map, BookOpen, ShieldAlert, Scale, Clock3, BarChart3, MapPin, Settings, Sparkles, LogOut, ExternalLink, ChevronRight, X, Navigation } from 'lucide-react';
import { ApiStatusBadge } from './ApiStatusBadge';
export const Sidebar = ({
  activeTab,
  onSelectTab,
  activeCity,
  userSettings,
  onOpenAIAgent,
  onExitToPublic,
  isEmergencyActive,
  isMobileOpen = false,
  onCloseMobile
}) => {
  const operationsNav = [{
    id: 'dashboard',
    label: 'Overview',
    icon: <LayoutDashboard className="w-4 h-4" />
  }, {
    id: 'heatmap',
    label: 'Heat Map',
    icon: <Map className="w-4 h-4" />,
    badge: 'FortyGuard'
  }, {
    id: 'heatstory',
    label: 'Heat Story',
    icon: <BookOpen className="w-4 h-4" />,
    badgeColor: 'bg-surface2 text-inkfaint border border-border'
  }, {
    id: 'routing',
    label: 'Heat-Safe Routes',
    icon: <Navigation className="w-4 h-4" />,
    badgeColor: 'bg-surface2 text-inkfaint border border-border'
  }, {
    id: 'emergency',
    label: 'Emergency',
    icon: <ShieldAlert className="w-4 h-4 text-red-400" />,
    isEmergency: true
  }];
  const analysisNav = [{
    id: 'compare',
    label: 'Compare Cities',
    icon: <Scale className="w-4 h-4" />
  }, {
    id: 'timecompare',
    label: 'Time Compare',
    icon: <Clock3 className="w-4 h-4" />
  }, {
    id: 'research',
    label: 'Research',
    icon: <BarChart3 className="w-4 h-4" />
  }, {
    id: 'locations',
    label: 'Locations',
    icon: <MapPin className="w-4 h-4" />
  }];
  const handleTabClick = tab => {
    onSelectTab(tab);
    if (onCloseMobile) {
      onCloseMobile();
    }
  };
  return <>
      {/* Mobile Backdrop */}
      {isMobileOpen && <div onClick={onCloseMobile} className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40 md:hidden animate-fadeIn" />}

      <aside className={`
        fixed inset-y-0 left-0 z-50 md:static md:z-auto
        w-64 border-r border-border bg-app md:bg-surface/20 p-5 
        flex flex-col justify-between h-screen shrink-0 text-inksoft select-none 
        overflow-y-auto no-scrollbar [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden
        transition-transform duration-300 ease-in-out shadow-2xl md:shadow-none
        ${isMobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div>
          {/* Brand Header */}
          <div className="flex items-center justify-between pb-5 mb-4 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 bg-gradient-to-br from-orange-500 to-red-600 rounded-lg flex items-center justify-center shadow-[0_0_15px_rgba(249,115,22,0.4)]">
                <span className="text-ink font-black text-lg">T</span>
              </div>
              <div>
                <span className="text-lg font-black tracking-tight uppercase italic text-ink">
                  THERMORA
                </span>
                <span className="block text-[9px] text-inkfaint uppercase tracking-widest font-bold">
                  Decision OS
                </span>
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button onClick={onExitToPublic} title="Back to Public Portal" className="p-1.5 text-inkfaint hover:text-ink hover:bg-surface2/60 rounded-lg transition-all cursor-pointer">
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
              {onCloseMobile && <button onClick={onCloseMobile} className="md:hidden p-1.5 text-inkfaint hover:text-ink hover:bg-surface2/60 rounded-lg transition-all cursor-pointer" aria-label="Close Navigation">
                  <X className="w-4 h-4" />
                </button>}
            </div>
          </div>

          {/* Operations Navigation */}
          <div className="text-[10px] text-inkfaint uppercase tracking-[0.2em] mb-2 font-bold px-2">
            Operations
          </div>
          <nav className="space-y-1">
            {operationsNav.map(item => {
            const isActive = activeTab === item.id;
            return <button key={item.id} id={`nav-${item.id}`} onClick={() => handleTabClick(item.id)} className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${isActive ? 'bg-orange-600 text-white font-semibold shadow-lg shadow-orange-900/30' : item.isEmergency ? 'hover:bg-surface2/50 text-red-400 hover:text-red-300' : 'hover:bg-surface2/50 text-inkmuted hover:text-ink'}`}>
                  <div className="flex items-center gap-3">
                    <span className={isActive ? 'text-ink' : item.isEmergency ? 'text-red-400' : 'text-inkmuted'}>
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </div>

                  {item.badge && <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full ${item.badgeColor || 'bg-surface2 text-inkmuted'}`}>
                      {item.badge}
                    </span>}
                </button>;
          })}
          </nav>

          {/* Analysis Navigation */}
          <div className="text-[10px] text-inkfaint uppercase tracking-[0.2em] mt-6 mb-2 font-bold px-2">
            Analysis
          </div>
          <nav className="space-y-1">
            {analysisNav.map(item => {
            const isActive = activeTab === item.id;
            return <button key={item.id} id={`nav-${item.id}`} onClick={() => handleTabClick(item.id)} className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${isActive ? 'bg-orange-600 text-white font-semibold shadow-lg shadow-orange-900/30' : 'hover:bg-surface2/50 text-inkmuted hover:text-ink'}`}>
                  <div className="flex items-center gap-3">
                    <span className={isActive ? 'text-ink' : 'text-inkmuted'}>
                      {item.icon}
                    </span>
                    <span>{item.label}</span>
                  </div>
                  {item.badge && <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-full bg-surface2 text-inkfaint border border-border">
                      {item.badge}
                    </span>}
                </button>;
          })}
          </nav>
        </div>

        {/* Footer Area: Settings, AI Agent & User Profile */}
        <div className="pt-4 mt-auto border-t border-border space-y-3">
          {/* Settings button */}
          <button id="nav-settings" onClick={() => handleTabClick('settings')} className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${activeTab === 'settings' ? 'bg-orange-600 text-white font-semibold shadow-lg shadow-orange-900/30' : 'hover:bg-surface2/50 text-inkmuted hover:text-ink'}`}>
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>

          {/* Thermora AI Agent trigger banner */}
          <button id="sidebar-ai-agent-btn" onClick={() => {
          onOpenAIAgent();
          if (onCloseMobile) onCloseMobile();
        }} className="w-full p-3 rounded-2xl bg-gradient-to-br from-orange-950/30 via-surface to-app border border-orange-500/30 hover:border-orange-500/60 transition-all text-left group cursor-pointer shadow-lg">
            <div className="flex items-center justify-between text-xs font-bold text-orange-400 mb-1">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-orange-400" />
                Thermora AI Agent
              </span>
              <ChevronRight className="w-3.5 h-3.5 text-orange-400 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <p className="text-[10px] text-inkmuted line-clamp-1 font-medium">
              “Which areas need immediate action?”
            </p>
          </button>

          {/* Operator User Profile Chip */}
          <div className="p-2.5 rounded-xl bg-surface/50 border border-border/80 flex items-center justify-between">
            <div className="flex items-center gap-2.5 overflow-hidden">
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center font-bold text-[11px] text-white shrink-0 shadow-sm">
                {userSettings.userName.charAt(0)}
              </div>
              <div className="overflow-hidden">
                <div className="text-xs font-semibold text-ink truncate">
                  {userSettings.userName}
                </div>
                <div className="text-[9px] text-inkfaint truncate font-mono">
                  {userSettings.role}
                </div>
              </div>
            </div>

            <button onClick={onExitToPublic} title="Sign Out" className="p-1 text-inkfaint hover:text-red-400 hover:bg-surface2 rounded transition-all cursor-pointer shrink-0">
              <LogOut className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </aside>
    </>;
};