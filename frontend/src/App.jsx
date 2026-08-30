import React, { useState, useEffect, Suspense, lazy } from 'react';
import { DEFAULT_USER_SETTINGS } from './data/cities';
import { useCities } from './hooks/useCities';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { DashboardView } from './components/DashboardView';
import { HeatStoryView } from './components/HeatStoryView';
import { EmergencyModeView } from './components/EmergencyModeView';
import { CompareView } from './components/CompareView';
import { TimeCompareView } from './components/TimeCompareView';
import { ResearchView } from './components/ResearchView';
import { LocationsView } from './components/LocationsView';
import { SettingsView } from './components/SettingsView';
import { AIAgentDrawer } from './components/AIAgentDrawer';
import { AuthModal } from './components/AuthModal';

// Code-split the two heaviest subtrees in the app: the landing page pulls
// in three.js + @react-three/fiber for its hero animation (~600kB alone),
// and the Heat Map view pulls in Leaflet — neither is needed for someone
// just using the dashboard/other tabs, so both load on demand instead of
// bloating the main bundle everyone pays for on first load.
const LandingPage = lazy(() => import('./components/LandingPage').then(m => ({ default: m.LandingPage })));
const HeatMapView = lazy(() => import('./components/HeatMapView').then(m => ({ default: m.HeatMapView })));
const RouteHeatView = lazy(() => import('./components/RouteHeatView').then(m => ({ default: m.RouteHeatView })));

function ViewLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-app text-inkmuted font-sans text-xs font-mono">
      Loading…
    </div>
  );
}

export default function App() {
  // Navigation & Authentication View States
  const [viewMode, setViewMode] = useState('public');
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authModalMode, setAuthModalMode] = useState('signin');

  // Active City & Applet Operational States
  const [activeCityId, setActiveCityId] = useState('houston');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [isAIAgentOpen, setIsAIAgentOpen] = useState(false);
  const [aiInitialPrompt, setAiInitialPrompt] = useState(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Settings tab's form only ever wrote to this in-memory state — save,
  // then refresh the page, and every threshold/profile field silently
  // reverted to DEFAULT_USER_SETTINGS. Reading a saved copy from
  // localStorage on load (falling back to the real defaults for a
  // first-ever visit or if the stored JSON is ever malformed) makes
  // "Save Settings" actually stick across reloads, same as everywhere
  // else in the browser this pattern is normally expected to work.
  const [userSettings, setUserSettings] = useState(() => {
    try {
      const stored = window.localStorage.getItem('thermora_user_settings');
      return stored ? { ...DEFAULT_USER_SETTINGS, ...JSON.parse(stored) } : DEFAULT_USER_SETTINGS;
    } catch {
      return DEFAULT_USER_SETTINGS;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('thermora_user_settings', JSON.stringify(userSettings));
    } catch {
      // Storage can legitimately be unavailable (private browsing, quota) —
      // settings still work for the rest of this session either way.
    }
  }, [userSettings]);
  const { cities } = useCities();
  const activeCity = cities.find(c => c.id === activeCityId) || cities[0];
  const handleOpenAIAgent = prompt => {
    if (prompt) {
      setAiInitialPrompt(prompt);
    }
    setIsAIAgentOpen(true);
  };

  // Auth & Navigation Handlers
  const handleOpenAuth = mode => {
    setAuthModalMode(mode);
    setAuthModalOpen(true);
  };
  const handleAuthSuccess = (updatedSettings, preferredCityId) => {
    setUserSettings(updatedSettings);
    if (preferredCityId) {
      setActiveCityId(preferredCityId);
    }
    setAuthModalOpen(false);
    setViewMode('dashboard');
  };
  const handleDirectDemoEnter = cityId => {
    if (cityId) {
      setActiveCityId(cityId);
    }
    setViewMode('dashboard');
  };
  const handleCitySelect = cityId => {
    setActiveCityId(cityId);
  };
  const handleOpenEmergency = () => {
    setActiveTab('emergency');
  };
  return <div className="min-h-screen bg-app text-ink font-sans selection:bg-orange-500/30 selection:text-orange-200">
      {/* 1. Public Landing Page View */}
      {viewMode === 'public' ? (
        <Suspense fallback={<ViewLoading />}>
          <LandingPage cities={cities} onEnterDashboard={handleDirectDemoEnter} onOpenAuth={handleOpenAuth} />
        </Suspense>
      ) : (/* 2. Personalized Administrative Operator Dashboard */
    <div className="flex h-screen overflow-hidden bg-app text-ink relative">
          {/* Main App Navigation Sidebar */}
          <Sidebar activeTab={activeTab} onSelectTab={setActiveTab} activeCity={activeCity} userSettings={userSettings} onOpenAIAgent={handleOpenAIAgent} onExitToPublic={() => setViewMode('public')} isEmergencyActive={false /* Risk Engine not built yet — see PhaseGate on Dashboard */} isMobileOpen={mobileSidebarOpen} onCloseMobile={() => setMobileSidebarOpen(false)} />

          {/* Main Content Area */}
          <div className="flex-1 flex flex-col h-screen overflow-hidden min-w-0">
            {/* Top Operational Header */}
            <Header activeCity={activeCity} cities={cities} onSelectCity={handleCitySelect} onOpenEmergency={handleOpenEmergency} onOpenAIAgent={handleOpenAIAgent} userSettings={userSettings} onToggleMobileSidebar={() => setMobileSidebarOpen(!mobileSidebarOpen)} />

            {/* Active Tab Screen */}
            <main className="flex-1 overflow-y-auto bg-app bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] from-orange-950/15 via-app to-app">
              {!activeCity ? (
                // Gates EVERY city-scoped view below on activeCity actually
                // being resolved yet. Without this, e.g. HeatMapView could
                // mount while `cities` (from useCities()) is still empty on
                // the very first render(s) — its useState(() =>
                // ...lastCompletedHourHHMM(city)) initializer only ever
                // runs ONCE, with city=undefined at that instant, silently
                // falling back to the browser's own local clock instead of
                // the city's real timezone (see queryWindow.js's
                // cityLocalParts: `if (!city?.timezone) return null`) —
                // and since it's a useState initializer, that wrong value
                // then stays locked in for the rest of the session even
                // after the real city data arrives a moment later. Waiting
                // here for a real `activeCity` means nothing below this
                // point can ever mount with an incomplete city again.
                <ViewLoading />
              ) : (
                <>
                  {activeTab === 'dashboard' && <DashboardView city={activeCity} userSettings={userSettings} onNavigateTab={setActiveTab} onOpenAIAgent={handleOpenAIAgent} />}

                  {activeTab === 'heatmap' && (
                    <Suspense fallback={<ViewLoading />}>
                      <HeatMapView city={activeCity} userSettings={userSettings} onNavigateTab={setActiveTab} />
                    </Suspense>
                  )}

                  {activeTab === 'routing' && (
                    <Suspense fallback={<ViewLoading />}>
                      <RouteHeatView city={activeCity} userSettings={userSettings} />
                    </Suspense>
                  )}

                  {activeTab === 'heatstory' && <HeatStoryView city={activeCity} userSettings={userSettings} onNavigateTab={setActiveTab} onOpenAIAgent={handleOpenAIAgent} />}

                  {activeTab === 'emergency' && <EmergencyModeView city={activeCity} userSettings={userSettings} onOpenAIAgent={handleOpenAIAgent} />}

                  {activeTab === 'compare' && <CompareView activeCity={activeCity} cities={cities} onSelectCity={handleCitySelect} onOpenAIAgent={handleOpenAIAgent} />}

                  {activeTab === 'timecompare' && <TimeCompareView city={activeCity} onOpenAIAgent={handleOpenAIAgent} />}

                  {activeTab === 'research' && <ResearchView city={activeCity} onOpenAIAgent={handleOpenAIAgent} />}

                  {activeTab === 'locations' && <LocationsView activeCityId={activeCityId} cities={cities} onSelectCity={handleCitySelect} onNavigateTab={setActiveTab} />}

                  {activeTab === 'settings' && <SettingsView userSettings={userSettings} onUpdateSettings={setUserSettings} />}
                </>
              )}
            </main>
          </div>
        </div>)}

      {/* Auth Modal (Sign In / Sign Up & Unified Credentials) */}
      <AuthModal isOpen={authModalOpen} mode={authModalMode} onClose={() => setAuthModalOpen(false)} onSuccess={handleAuthSuccess} />

      {/* Thermora AI Intelligence Interactive Drawer */}
      <AIAgentDrawer isOpen={isAIAgentOpen} onClose={() => {
      setIsAIAgentOpen(false);
      setAiInitialPrompt(null);
    }} activeCity={activeCity} userSettings={userSettings} initialPrompt={aiInitialPrompt} onClearInitialPrompt={() => setAiInitialPrompt(null)} />
    </div>;
}