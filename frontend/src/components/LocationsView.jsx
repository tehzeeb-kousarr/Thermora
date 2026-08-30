import React, { useState } from 'react';
import { MapPin, Search, ArrowRight, Layers } from 'lucide-react';

function LocationCard({ city, isActive, onSelectCity, onNavigateTab }) {
  return (
    <div className={`bg-surface/80 rounded-[2rem] p-6 border shadow-xl flex flex-col justify-between transition-all backdrop-blur-md ${isActive ? 'border-orange-500/60 ring-1 ring-orange-500/30' : 'border-border hover:border-borderstrong'}`}>
      <div>
        <div className="flex items-start justify-between gap-2 pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-bold text-ink tracking-tight">{city.name}</h3>
              {isActive && <span className="px-2.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 border border-orange-500/30 text-[10px] font-mono font-black">ACTIVE</span>}
            </div>
            <p className="text-xs text-inkmuted">{city.state}</p>
          </div>
        </div>

        <div className="my-4 p-4 bg-app/60 rounded-2xl border border-border/80">
          <div className="text-[10px] font-mono font-bold text-inkmuted">COORDINATES</div>
          <div className="text-sm font-black text-ink font-mono mt-0.5">
            {city.lat.toFixed(4)}, {city.lon.toFixed(4)}
          </div>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-border flex gap-2">
        <button onClick={() => { onSelectCity(city.id); onNavigateTab('dashboard'); }} className="flex-1 py-2.5 bg-surface2 hover:bg-surface3 text-ink font-bold text-xs rounded-xl transition-all cursor-pointer flex items-center justify-center gap-1.5">
          <span>Open Overview</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => { onSelectCity(city.id); onNavigateTab('heatmap'); }} className="p-2.5 bg-orange-500/15 hover:bg-orange-500/25 border border-orange-500/30 text-orange-300 rounded-xl transition-all cursor-pointer" title="Heat Map">
          <Layers className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export const LocationsView = ({ activeCityId, cities = [], onSelectCity, onNavigateTab }) => {
  const [filterQuery, setFilterQuery] = useState('');
  const filteredCities = cities.filter(c =>
    c.name.toLowerCase().includes(filterQuery.toLowerCase()) || c.state.toLowerCase().includes(filterQuery.toLowerCase())
  );

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 text-ink font-sans">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-border">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center">
              <MapPin className="w-4 h-4 text-orange-400" />
            </div>
            <h2 className="text-2xl font-bold text-ink tracking-tight">Monitored Locations</h2>
          </div>
          <p className="text-xs text-inkmuted mt-1">Name and coordinates only — no live or cached temperature data shown here</p>
        </div>
        <span className="text-xs font-mono text-emerald-400 font-bold bg-emerald-500/10 px-3 py-1.5 rounded-full border border-emerald-500/20 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          {cities.length} locations
        </span>
      </div>

      <div className="relative flex-1">
        <Search className="w-4 h-4 text-inkmuted absolute left-3.5 top-1/2 -translate-y-1/2" />
        <input type="text" placeholder="Filter by city name or state..." value={filterQuery} onChange={e => setFilterQuery(e.target.value)} className="w-full bg-surface border border-border rounded-2xl pl-10 pr-4 py-2.5 text-xs text-ink focus:outline-none focus:border-orange-500 font-sans shadow-inner" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredCities.map(city => (
          <LocationCard key={city.id} city={city} isActive={city.id === activeCityId} onSelectCity={onSelectCity} onNavigateTab={onNavigateTab} />
        ))}
      </div>
    </div>
  );
};
