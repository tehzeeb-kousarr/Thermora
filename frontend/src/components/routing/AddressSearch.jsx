import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { geocodeAddress } from '../../api/thermoraApi';

// Phase 12.5d — lets someone TYPE an address instead of clicking the
// map (map-only input was the original complaint: "maps are too complex
// to some people to just put pointers"). Every suggestion shown here
// already passed the backend's boundary filter (routers/places.py), so
// picking one can never turn into a boundary-rejected trip later.
const DEBOUNCE_MS = 400;

export function AddressSearch({ cityId, placeholder, value, onSelect, accentClassName = 'text-inkfaint' }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);
  const requestIdRef = useRef(0);

  // Keep the input in sync when the point is set some other way (map
  // click, "use my location", a POI pick) rather than by typing here.
  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const runSearch = useCallback(async (text) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setSearchError(null);
    try {
      const data = await geocodeAddress(cityId, text);
      if (requestId !== requestIdRef.current) return; // a newer keystroke's search already landed
      setResults(data.results || []);
      setOpen(true);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setSearchError(err.message || String(err));
      setResults([]);
      setOpen(true);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [cityId]);

  const handleChange = (e) => {
    const text = e.target.value;
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (text.trim().length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(text.trim()), DEBOUNCE_MS);
  };

  const handlePick = (result) => {
    onSelect({ lat: result.lat, lon: result.lon }, result.label);
    setQuery(result.label);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search className={`w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 ${accentClassName}`} />
        <input
          type="text"
          value={query}
          onChange={handleChange}
          onFocus={() => results.length > 0 && setOpen(true)}
          placeholder={placeholder}
          className="w-full pl-8 pr-7 py-2 rounded-lg border border-border bg-surface2/60 text-sm text-ink placeholder:text-inkfaint"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-inkfaint" />}
      </div>

      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-border bg-surface shadow-lg">
          {searchError && (
            <div className="px-3 py-2 text-[12px] text-red-300">Address search failed: {searchError}</div>
          )}
          {!searchError && results.length === 0 && !loading && (
            <div className="px-3 py-2 text-[12px] text-inkfaint">No matches inside this city's boundary.</div>
          )}
          {results.map((r, i) => (
            <button
              key={`${r.lat}-${r.lon}-${i}`}
              type="button"
              onClick={() => handlePick(r)}
              className="w-full text-left px-3 py-2 text-[12.5px] text-inksoft hover:bg-surface2/60 cursor-pointer border-b border-border last:border-b-0"
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
