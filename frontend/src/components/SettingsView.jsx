import React, { useState } from 'react';
import { Settings, ShieldAlert, User, Thermometer, CheckCircle2, Save, Flame, Info } from 'lucide-react';

// Every field here is genuinely read somewhere else in the app — this
// page used to offer a batch of settings (email/SMS/webhook alerts, NWS
// auto-sync, an OSHA mode, a max wet-bulb threshold, a persistence-hours
// threshold) that didn't exist in DEFAULT_USER_SETTINGS (data/cities.js)
// and that nothing in the codebase ever read — changing them did
// nothing. Rebuilt to match the real userSettings shape App.jsx actually
// threads through every tab, so every control below has a real, visible
// effect the moment you hit Save:
//   - tempUnit          -> Dashboard, Heat Map, Heat Story, Route Heat,
//                          every temperature shown anywhere in the app
//   - warningThreshold,
//     emergencyThreshold -> Emergency Mode's timeline + severity
//                          classification, Heat Story's warning-line
//                          overlay and "hours above warning" count
//   - userName, role,
//     organization        -> shown in the Sidebar profile card, the AI
//                          Agent drawer, and Emergency Mode's "Operational
//                          authority" line
//   - email               -> stored on your operator profile alongside
//                          the above (not yet read by a notification
//                          system — there isn't one in this build)
export const SettingsView = ({ userSettings, onUpdateSettings }) => {
  const [formData, setFormData] = useState({ ...userSettings });
  const [saveSuccess, setSaveSuccess] = useState(false);

  const handleSubmit = (e) => {
    e.preventDefault();
    onUpdateSettings(formData);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8 text-ink font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center">
              <Settings className="w-4 h-4 text-orange-400" />
            </div>
            <h2 className="text-2xl font-bold text-ink tracking-tight">Settings</h2>
          </div>
          <p className="text-xs text-inkmuted mt-1">
            Your display unit, alert thresholds, and operator profile — used across every tab in this app.
          </p>
        </div>

        {saveSuccess && (
          <div className="px-3.5 py-1.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 rounded-xl text-xs font-semibold flex items-center gap-2 animate-fadeIn">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>Settings saved</span>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Display Unit */}
        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl space-y-5 backdrop-blur-md">
          <div className="flex items-center gap-2 pb-3 border-b border-border">
            <Thermometer className="w-4 h-4 text-orange-400" />
            <h3 className="text-base font-bold text-ink">Temperature Unit</h3>
          </div>
          <p className="text-xs text-inkmuted -mt-2">
            Applies everywhere a temperature is shown — Dashboard, Heat Map, Heat Story, Route Heat, and the AI Agent.
          </p>
          <div className="flex gap-3">
            {[
              { key: 'F', label: 'Fahrenheit (°F)' },
              { key: 'C', label: 'Celsius (°C)' },
            ].map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setFormData({ ...formData, tempUnit: opt.key })}
                className={`flex-1 px-4 py-3 rounded-2xl border text-sm font-bold transition-all cursor-pointer ${
                  formData.tempUnit === opt.key
                    ? 'bg-orange-500/20 border-orange-500/50 text-orange-300'
                    : 'bg-app/60 border-border text-inkmuted hover:border-borderstrong'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Heat Alert Thresholds */}
        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl space-y-6 backdrop-blur-md">
          <div className="flex items-center gap-2 pb-3 border-b border-border">
            <Flame className="w-4 h-4 text-orange-400" />
            <h3 className="text-base font-bold text-ink">Heat Alert Thresholds</h3>
          </div>
          <p className="text-xs text-inkmuted -mt-3 flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Drives Emergency Mode's timeline &amp; severity, and Heat Story's warning-line overlay and "hours above warning" count — both always read your live temperature data, this just sets where the line is drawn.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-2 p-5 bg-app/60 rounded-2xl border border-border">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-orange-400 font-bold">WARNING THRESHOLD</span>
                <span className="text-ink text-base font-black">{formData.warningThreshold}°F</span>
              </div>
              <p className="text-xs text-inkmuted">Marks a temperature as a heat warning across the app.</p>
              <input
                type="range"
                min="85"
                max="105"
                value={formData.warningThreshold}
                onChange={(e) => setFormData({ ...formData, warningThreshold: Number(e.target.value) })}
                className="w-full accent-orange-500 cursor-pointer mt-2"
              />
            </div>

            <div className="space-y-2 p-5 bg-app/60 rounded-2xl border border-border">
              <div className="flex items-center justify-between text-xs font-mono">
                <span className="text-red-400 font-bold">EMERGENCY THRESHOLD</span>
                <span className="text-ink text-base font-black">{formData.emergencyThreshold}°F</span>
              </div>
              <p className="text-xs text-inkmuted">Marks a temperature as an emergency-level event.</p>
              <input
                type="range"
                min="95"
                max="115"
                value={formData.emergencyThreshold}
                onChange={(e) => setFormData({ ...formData, emergencyThreshold: Number(e.target.value) })}
                className="w-full accent-red-500 cursor-pointer mt-2"
              />
            </div>
          </div>
          {formData.emergencyThreshold <= formData.warningThreshold && (
            <p className="text-xs text-amber-300 flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
              Emergency threshold should be higher than the warning threshold, or Emergency Mode's timeline won't separate the two correctly.
            </p>
          )}
        </div>

        {/* Operator Profile */}
        <div className="bg-surface/80 rounded-[2rem] p-6 border border-border shadow-xl space-y-6 backdrop-blur-md">
          <div className="flex items-center gap-2 pb-3 border-b border-border">
            <User className="w-4 h-4 text-orange-400" />
            <h3 className="text-base font-bold text-ink">Operator Profile</h3>
          </div>
          <p className="text-xs text-inkmuted -mt-3">
            Shown in the Sidebar, the AI Agent drawer, and Emergency Mode's "Operational authority" line.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-inksoft font-medium mb-1">Name</label>
              <input
                type="text"
                value={formData.userName}
                onChange={(e) => setFormData({ ...formData, userName: e.target.value })}
                className="w-full bg-app border border-border rounded-xl p-2.5 text-ink focus:outline-none focus:border-orange-500"
              />
            </div>

            <div>
              <label className="block text-inksoft font-medium mb-1">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="w-full bg-app border border-border rounded-xl p-2.5 text-ink focus:outline-none focus:border-orange-500"
              />
            </div>

            <div>
              <label className="block text-inksoft font-medium mb-1">Role</label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                className="w-full bg-app border border-border rounded-xl p-2.5 text-ink focus:outline-none focus:border-orange-500"
              >
                <option value="">Select a role</option>
                <option value="Municipal Heat Officer">Municipal Heat Officer</option>
                <option value="Emergency Services Director">Emergency Services Director</option>
                <option value="Facility Operations Manager">Facility Operations Manager</option>
                <option value="Public Health Analyst">Public Health Analyst</option>
              </select>
            </div>

            <div>
              <label className="block text-inksoft font-medium mb-1">Organization</label>
              <input
                type="text"
                value={formData.organization}
                onChange={(e) => setFormData({ ...formData, organization: e.target.value })}
                className="w-full bg-app border border-border rounded-xl p-2.5 text-ink focus:outline-none focus:border-orange-500"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <button
            id="settings-save-btn"
            type="submit"
            className="px-6 py-3 bg-gradient-to-r from-orange-400 via-amber-400 to-orange-300 hover:from-orange-300 hover:to-amber-300 text-zinc-950 font-black rounded-xl text-sm shadow-xl shadow-orange-500/20 flex items-center gap-2 transition-all cursor-pointer"
          >
            <Save className="w-4 h-4 text-zinc-950" />
            <span>Save Settings</span>
          </button>
        </div>
      </form>
    </div>
  );
};