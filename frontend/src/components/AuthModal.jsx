import React, { useState } from 'react';
import { X, Flame, Lock, Mail, ArrowRight, User, ShieldCheck, Building2, Sliders, AlertCircle } from 'lucide-react';
import { DEFAULT_USER_SETTINGS } from '../data/cities';

// This is a demo build — there's no real backend auth. Sign In now checks
// against exactly one fixed, hardcoded account rather than accepting
// anything typed in, so "logging in" actually means something. Sign Up
// deliberately stays exactly as it was (decorative, always succeeds) —
// only Sign In is gated.
const DEMO_EMAIL = 'demo@thermora.io';
const DEMO_PASSWORD = 'ThermoraDemo2026';

export const AuthModal = ({
  isOpen,
  mode: initialMode,
  onClose,
  onSuccess
}) => {
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState(DEFAULT_USER_SETTINGS.userName);
  const [email, setEmail] = useState(DEFAULT_USER_SETTINGS.email);
  const [password, setPassword] = useState('••••••••');
  const [role, setRole] = useState(DEFAULT_USER_SETTINGS.role);
  const [org, setOrg] = useState(DEFAULT_USER_SETTINGS.organization);
  const [warningThreshold, setWarningThreshold] = useState(98);
  const [emergencyThreshold, setEmergencyThreshold] = useState(104);
  const [rememberMe, setRememberMe] = useState(true);
  const [authError, setAuthError] = useState('');
  if (!isOpen) return null;
  const switchMode = next => {
    setAuthError('');
    setMode(next);
  };
  const handleSubmit = e => {
    e.preventDefault();
    if (mode === 'signin') {
      const emailMatches = email.trim().toLowerCase() === DEMO_EMAIL;
      const passwordMatches = password === DEMO_PASSWORD;
      if (!emailMatches || !passwordMatches) {
        setAuthError('Incorrect email or password. Use the demo credentials below.');
        return;
      }
    }
    setAuthError('');
    const updatedSettings = {
      ...DEFAULT_USER_SETTINGS,
      userName: name.trim() || (mode === 'signin' ? email.split('@')[0] || 'Operator' : 'Authorized User'),
      email: email.trim() || 'operator@thermora.io',
      role: role,
      organization: org.trim() || 'Metropolitan Operations',
      warningThreshold,
      emergencyThreshold
    };
    onSuccess(updatedSettings);
  };
  return <div className="fixed inset-0 z-[1300] flex items-center justify-center p-4 bg-app/85 backdrop-blur-xl animate-fadeIn">
      <div className="bg-surface border border-border rounded-[2rem] w-full max-w-md overflow-hidden shadow-2xl relative text-ink backdrop-blur-2xl">
        {/* Close Button */}
        <button id="auth-modal-close-btn" onClick={onClose} className="absolute top-5 right-5 p-2 text-inkmuted hover:text-ink hover:bg-surface2 rounded-xl transition-all cursor-pointer z-10" aria-label="Close">
          <X className="w-5 h-5" />
        </button>

        {/* Modal Header */}
        <div className="p-6 pb-4 border-b border-border bg-app/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center shadow-lg shadow-orange-500/10">
              <Flame className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-ink tracking-tight">
                {mode === 'signin' ? 'Sign In to Thermora' : 'Create Your Account'}
              </h3>
              <p className="text-xs text-inkmuted">
                {mode === 'signin' ? 'Access real-time heat maps, analytics & alerts' : 'Set up your operational profile and heat threshold alerts'}
              </p>
            </div>
          </div>

          {/* Mode Switch Tabs */}
          <div className="flex items-center p-1 bg-app rounded-xl border border-border mt-4 text-xs font-semibold">
            <button id="auth-tab-signin" type="button" onClick={() => switchMode('signin')} className={`flex-1 py-1.5 rounded-lg transition-all cursor-pointer text-center ${mode === 'signin' ? 'bg-surface2 text-ink shadow-sm' : 'text-inkmuted hover:text-ink'}`}>
              Sign In
            </button>
            <button id="auth-tab-signup" type="button" onClick={() => switchMode('signup')} className={`flex-1 py-1.5 rounded-lg transition-all cursor-pointer text-center ${mode === 'signup' ? 'bg-orange-500 text-zinc-950 font-bold shadow-sm' : 'text-inkmuted hover:text-ink'}`}>
              Create Account
            </button>
          </div>
        </div>

        {/* Unified Authentication Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {mode === 'signup' && <div>
              <label className="block text-xs font-medium text-inksoft mb-1.5">
                Full Name
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-inkmuted absolute left-3 top-1/2 -translate-y-1/2" />
                <input id="auth-input-name" type="text" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Alex Morgan" className="w-full bg-app border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink focus:outline-none focus:border-orange-500 font-sans placeholder-inkfaint" />
              </div>
            </div>}

          <div>
            <label className="block text-xs font-medium text-inksoft mb-1.5">
              Email Address
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-inkmuted absolute left-3 top-1/2 -translate-y-1/2" />
              <input id="auth-input-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="name@organization.gov" className="w-full bg-app border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink focus:outline-none focus:border-orange-500 font-sans placeholder-inkfaint" />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium text-inksoft">
                Password
              </label>
              {mode === 'signin' && <button type="button" onClick={() => alert('Password reset link sent to your registered email.')} className="text-[11px] text-orange-400 hover:text-orange-300 cursor-pointer">
                  Forgot password?
                </button>}
            </div>
            <div className="relative">
              <Lock className="w-4 h-4 text-inkmuted absolute left-3 top-1/2 -translate-y-1/2" />
              <input id="auth-input-password" type="password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="w-full bg-app border border-border rounded-xl pl-9 pr-3 py-2.5 text-sm text-ink focus:outline-none focus:border-orange-500 font-sans placeholder-inkfaint" />
            </div>
            {mode === 'signin' && (
              <p className="text-[11px] text-inkfaint mt-1.5">
                Demo access: <span className="font-mono text-inksoft">{DEMO_EMAIL}</span> / <span className="font-mono text-inksoft">{DEMO_PASSWORD}</span>
              </p>
            )}
            {mode === 'signin' && authError && (
              <p id="auth-error-message" className="flex items-center gap-1.5 text-[11px] text-red-400 mt-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                {authError}
              </p>
            )}
          </div>

          {mode === 'signup' && <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-xs font-medium text-inksoft mb-1.5">
                    Role / Domain
                  </label>
                  <select id="auth-input-role" value={role} onChange={e => setRole(e.target.value)} className="w-full bg-app border border-border rounded-xl px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-orange-500 font-sans">
                    <option value="Municipal Heat Officer">Municipal Heat Officer</option>
                    <option value="Emergency Services Director">Emergency Services Director</option>
                    <option value="Facility Operations Manager">Facility Operations Manager</option>
                    <option value="Public Health Analyst">Public Health Analyst</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-inksoft mb-1.5">
                    Organization
                  </label>
                  <input id="auth-input-org" type="text" value={org} onChange={e => setOrg(e.target.value)} placeholder="e.g. City Administration" className="w-full bg-app border border-border rounded-xl px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-orange-500 font-sans placeholder-inkfaint" />
                </div>
              </div>

              {/* Threshold preferences */}
              <div className="p-3.5 bg-app/60 rounded-2xl border border-border/80 mt-2">
                <div className="flex items-center gap-1.5 text-[11px] font-mono text-orange-400 font-bold mb-2">
                  <Sliders className="w-3.5 h-3.5" />
                  <span>Custom Alert Thresholds:</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-inkmuted text-[11px]">Warning: {warningThreshold}°F</label>
                    <input type="range" min="90" max="105" value={warningThreshold} onChange={e => setWarningThreshold(Number(e.target.value))} className="w-full accent-orange-500 cursor-pointer mt-1" />
                  </div>
                  <div>
                    <label className="text-inkmuted text-[11px]">Emergency: {emergencyThreshold}°F</label>
                    <input type="range" min="100" max="115" value={emergencyThreshold} onChange={e => setEmergencyThreshold(Number(e.target.value))} className="w-full accent-red-500 cursor-pointer mt-1" />
                  </div>
                </div>
              </div>
            </>}

          {mode === 'signin' && <div className="flex items-center justify-between text-xs text-inkmuted pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="rounded bg-app border-border text-orange-500 focus:ring-orange-500" />
                <span>Remember this workstation</span>
              </label>
              <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>SSL Encrypted</span>
              </div>
            </div>}

          <button id="auth-submit-btn" type="submit" className="w-full py-3 bg-gradient-to-r from-orange-400 via-amber-400 to-orange-300 hover:from-orange-300 hover:to-amber-300 text-zinc-950 font-black rounded-xl text-sm shadow-xl shadow-orange-500/20 transition-all flex items-center justify-center gap-2 cursor-pointer mt-5">
            <span>{mode === 'signin' ? 'Sign In' : 'Create Account & Enter'}</span>
            <ArrowRight className="w-4 h-4" />
          </button>

          <div className="text-center pt-2">
            <button type="button" onClick={() => switchMode(mode === 'signin' ? 'signup' : 'signin')} className="text-xs text-inkmuted hover:text-orange-300 transition-all cursor-pointer font-medium">
              {mode === 'signin' ? "Don't have an account? Sign up" : 'Already registered? Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>;
};
