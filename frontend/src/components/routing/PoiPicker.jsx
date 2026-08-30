import React, { useState, useRef, useEffect } from 'react';
import { Hospital, School, Pill, Flame, Shield, Library, Loader2, Car, Footprints } from 'lucide-react';
import { fetchNearbyPOIs } from '../../api/thermoraApi';

// Backend (routers/places.py) already sorts results ascending by real
// OSRM drive time — this just renders that number so the sort order is
// legible, not re-deriving or re-sorting anything on the frontend.
function formatMinutes(mins) {
  if (mins == null) return null;
  if (mins < 1) return '<1 min';
  return `${Math.round(mins)} min`;
}

function TravelBadge({ poi }) {
  const drive = formatMinutes(poi.drive_minutes);
  const walk = formatMinutes(poi.walk_minutes);
  const km = poi.drive_km ?? poi.straight_line_km;

  if (!drive && !walk) return null;

  return (
    <span className="flex items-center gap-2 shrink-0 text-[10.5px] text-inkfaint font-mono">
      {drive && (
        <span className="flex items-center gap-0.5">
          <Car className="w-3 h-3" /> {drive}
        </span>
      )}
      {walk && (
        <span className="flex items-center gap-0.5">
          <Footprints className="w-3 h-3" /> {walk}
        </span>
      )}
      {km != null && <span>· {km} km</span>}
    </span>
  );
}

// Phase 12.5d/g — "shortcuts" so a destination can be picked by CATEGORY
// (nearest hospital / school / pharmacy / fire station / police /
// cooling center) instead of typing or clicking an exact point — the
// other half of the same "maps are too complex for some people"
// complaint AddressSearch answers.
const CATEGORIES = [
  { key: 'hospital', label: 'Hospital', Icon: Hospital },
  { key: 'school', label: 'School', Icon: School },
  { key: 'pharmacy', label: 'Pharmacy', Icon: Pill },
  { key: 'fire_station', label: 'Fire Station', Icon: Flame },
  { key: 'police', label: 'Police', Icon: Shield },
  { key: 'cooling_center', label: 'Cooling Center', Icon: Library },
];

export function PoiPicker({ cityId, near, onSelect }) {
  const [activeCategory, setActiveCategory] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [poiError, setPoiError] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setActiveCategory(null);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCategoryClick = async (key) => {
    if (activeCategory === key) {
      setActiveCategory(null);
      return;
    }
    setActiveCategory(key);
    setLoading(true);
    setPoiError(null);
    setResults([]);
    try {
      const data = await fetchNearbyPOIs(cityId, key, near);
      setResults(data.results || []);
    } catch (err) {
      setPoiError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handlePick = (poi) => {
    onSelect({ lat: poi.lat, lon: poi.lon }, poi.name);
    setActiveCategory(null);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => handleCategoryClick(key)}
            className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] cursor-pointer ${
              activeCategory === key ? 'border-orange-500/60 bg-orange-500/10 text-ink' : 'border-border bg-surface2/40 text-inkmuted hover:text-ink'
            }`}
          >
            <Icon className="w-3 h-3" /> {label}
          </button>
        ))}
      </div>

      {activeCategory && (
        <div className="absolute z-20 mt-1.5 w-80 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {activeCategory === 'cooling_center' && !loading && (
            <div className="px-3 py-1.5 text-[10px] text-inkfaint border-b border-border">
              Libraries &amp; community centers — not an official cooling-center list
            </div>
          )}
          {loading && (
            <div className="px-3 py-2 flex items-center gap-1.5 text-[12px] text-inkfaint">
              <Loader2 className="w-3 h-3 animate-spin" /> Looking nearby…
            </div>
          )}
          {poiError && <div className="px-3 py-2 text-[12px] text-red-300">Lookup failed: {poiError}</div>}
          {!loading && !poiError && results.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-inkfaint">None found inside this city's boundary.</div>
          )}
          {results.map((poi, i) => (
            <button
              key={`${poi.lat}-${poi.lon}-${i}`}
              type="button"
              onClick={() => handlePick(poi)}
              className="w-full flex items-center justify-between gap-2 text-left px-3 py-2 text-[12.5px] text-inksoft hover:bg-surface2/60 cursor-pointer border-b border-border last:border-b-0"
            >
              <span className="truncate">{poi.name}</span>
              <TravelBadge poi={poi} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}