import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { Navigation, MapPin, Flag, Clock, RefreshCw, AlertTriangle, Trash2, Info, LocateFixed, Share2, Check } from 'lucide-react';
import { RouteMap } from './routing/RouteMap';
import { RouteCard } from './routing/RouteCard';
import { AddressSearch } from './routing/AddressSearch';
import { PoiPicker } from './routing/PoiPicker';
import { BestHoursTimeline } from './routing/BestHoursTimeline';
import { fetchRoutes, fetchCityBoundary, reverseGeocode } from '../api/thermoraApi';

// postJSON's error message is `${path} failed (${status}): ${rawBody}`,
// where rawBody is FastAPI's own JSON (either a Pydantic validation
// error array under "detail", or a plain-string "detail" from an
// HTTPException like the boundary check in routers/routing.py). Turns
// that into one short, readable sentence instead of dumping the raw
// JSON straight into the UI.
function formatRouteError(rawMessage) {
  if (!rawMessage) return 'Something went wrong finding routes.';
  const jsonStart = rawMessage.indexOf('{');
  if (jsonStart === -1) return rawMessage;
  const prefix = rawMessage.slice(0, jsonStart).trim();
  try {
    const body = JSON.parse(rawMessage.slice(jsonStart));
    const { detail } = body;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const fields = detail.map((d) => {
        const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : 'field';
        return `${field}: ${d.msg}`;
      });
      return `${prefix ? `${prefix} — ` : ''}${fields.join('; ')}`;
    }
  } catch {
    // Not JSON (network failure, HTML error page, etc.) — fall through.
  }
  return rawMessage;
}

// Local <input type="datetime-local"> value -> an ISO 8601 string WITH the
// browser's own UTC offset baked in (datetime-local gives no offset at
// all by itself) — this is what makes the backend's 12-hour forecast-
// horizon check land on the TRAVELER's real local hours instead of
// silently being interpreted as UTC (see schemas.RouteRequest's
// docstring on the backend for why this matters).
function localInputToISOWithOffset(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const offsetStr = `${sign}${pad(offsetMin / 60)}:${pad(offsetMin % 60)}`;
  // date.toISOString() always normalizes to UTC ('Z') — build the local
  // wall-clock string by hand instead so the offset we attach actually
  // matches the hour the user picked, not that hour shifted to UTC.
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${y}-${mo}-${d}T${h}:${mi}:00${offsetStr}`;
}

export function RouteHeatView({ city, userSettings }) {
  const [origin, setOrigin] = useState(null);
  const [destination, setDestination] = useState(null);
  const [originLabel, setOriginLabel] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [clickTarget, setClickTarget] = useState('origin'); // which pin the next map click / picker sets
  const [departureLocal, setDepartureLocal] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [maxVisibleRoutes, setMaxVisibleRoutes] = useState(4);
  const [routeLocked, setRouteLocked] = useState(false);
  const [boundary, setBoundary] = useState(null);
  const [boundaryError, setBoundaryError] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState(null);
  const [shareStatus, setShareStatus] = useState(null); // null | 'copied' | 'shared' | 'error'

  const tempUnit = userSettings?.tempUnit || 'F';

  // Fetches this city's cached boundary polygon so the map can draw it
  // and the trip fields can reset when the city changes — same polygon
  // routers/routing.py enforces server-side, so what's drawn here is
  // exactly what a request will be validated against.
  useEffect(() => {
    let cancelled = false;
    setBoundary(null);
    setBoundaryError(null);
    fetchCityBoundary(city.id)
      .then((data) => { if (!cancelled) setBoundary(data.geojson); })
      .catch((err) => { if (!cancelled) setBoundaryError(err.message || String(err)); });
    return () => { cancelled = true; };
  }, [city.id]);

  const handleMapClick = useCallback((lat, lon) => {
    const point = { lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) };
    const fallbackLabel = `${point.lat}, ${point.lon}`;
    if (clickTarget === 'origin') {
      setOrigin(point);
      setOriginLabel(fallbackLabel);
      setClickTarget('destination');
    } else {
      setDestination(point);
      setDestinationLabel(fallbackLabel);
    }
  }, [clickTarget]);

  const handleAddressSelect = useCallback((target) => (point, label) => {
    if (target === 'origin') {
      setOrigin(point);
      setOriginLabel(label);
      setClickTarget('destination');
    } else {
      setDestination(point);
      setDestinationLabel(label);
    }
  }, []);

  // "Use my location" — browser geolocation, reverse-geocoded (best
  // effort) into a readable label. Sets whichever pin (origin/
  // destination) is currently active, same as a map click would. The
  // boundary check still happens server-side when routes are actually
  // requested — a location outside the city just surfaces the same
  // clear boundary error as any other out-of-bounds point.
  const handleUseMyLocation = () => {
    if (!navigator.geolocation) {
      setLocateError('Geolocation is not available in this browser.');
      return;
    }
    setLocating(true);
    setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const point = {
          lat: Number(position.coords.latitude.toFixed(5)),
          lon: Number(position.coords.longitude.toFixed(5)),
        };
        const fallbackLabel = `${point.lat}, ${point.lon}`;
        const target = clickTarget;
        if (target === 'origin') {
          setOrigin(point);
          setOriginLabel(fallbackLabel);
          setClickTarget('destination');
        } else {
          setDestination(point);
          setDestinationLabel(fallbackLabel);
        }
        setLocating(false);
        try {
          const { label } = await reverseGeocode(city.id, point.lat, point.lon);
          if (label) {
            if (target === 'origin') setOriginLabel(label);
            else setDestinationLabel(label);
          }
        } catch {
          // Best-effort only — the raw coordinate set above is already usable.
        }
      },
      (geoErr) => {
        setLocating(false);
        setLocateError(geoErr.message || 'Could not get your location.');
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  // Share the current origin (or destination, if origin isn't set yet)
  // as a plain-text message with a Google Maps link — meant for handing
  // a location to someone else (e.g. police/firefighters) outside the
  // app. Uses the Web Share sheet when available (mobile), falls back
  // to clipboard on desktop.
  const handleShareLocation = async (point, label) => {
    if (!point) return;
    const mapsUrl = `https://www.google.com/maps?q=${point.lat},${point.lon}`;
    const text = `${label ? `${label} — ` : ''}${point.lat}, ${point.lon}\n${mapsUrl}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Shared location', text, url: mapsUrl });
        setShareStatus('shared');
      } else {
        await navigator.clipboard.writeText(text);
        setShareStatus('copied');
      }
    } catch (err) {
      // A user-cancelled share sheet also lands here (AbortError) — not
      // a real failure, so don't show an error for that specific case.
      if (err?.name !== 'AbortError') setShareStatus('error');
    }
    setTimeout(() => setShareStatus(null), 2500);
  };

  const handleClear = () => {
    setOrigin(null);
    setDestination(null);
    setOriginLabel('');
    setDestinationLabel('');
    setClickTarget('origin');
    setResult(null);
    setError(null);
    setSelectedIndex(0);
    setRouteLocked(false);
    setMaxVisibleRoutes(4);
  };

  const handleFindRoutes = async () => {
    if (!origin || !destination) {
      setError('Set both an origin and a destination first — click the map twice, or use "Set on map" below.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const departureTime = localInputToISOWithOffset(departureLocal);
      const data = await fetchRoutes({ cityId: city.id, origin, destination, departureTime });
      setResult(data);
      setSelectedIndex(0);
      // A fresh search is a fresh comparison — always start unlocked
      // showing every alternate (capped at 4) rather than carrying over
      // a previous trip's single-route lock.
      setRouteLocked(false);
      setMaxVisibleRoutes(4);
    } catch (err) {
      setError(formatRouteError(err.message || String(err)));
    } finally {
      setLoading(false);
    }
  };

  const mapCenter = useMemo(() => origin || { lat: city.lat, lon: city.lon }, [origin, city]);
  const routes = result?.routes || [];
  const selectedRoute = routes[selectedIndex];

  // "Alternate routes" — lets someone compare up to a handful of road
  // paths to the SAME destination at once (e.g. one might be under
  // construction or otherwise undesirable) before committing. Picking
  // one (map click or card click) locks the map down to just that
  // route; "Compare alternates again" below reopens the comparison.
  const routeCountOptions = useMemo(
    () => Array.from({ length: Math.min(4, routes.length) }, (_, i) => i + 1),
    [routes.length],
  );
  const visibleIndices = useMemo(() => {
    if (!routes.length) return [];
    if (routeLocked) return [selectedIndex];
    return routes.map((_, i) => i).slice(0, maxVisibleRoutes);
  }, [routes, routeLocked, selectedIndex, maxVisibleRoutes]);

  const handleSelectRoute = useCallback((i) => {
    setSelectedIndex(i);
    setRouteLocked(true);
  }, []);

  const handleShowAlternates = () => setRouteLocked(false);

  // Best-hours timeline picks an hour as an absolute ISO instant; the
  // departure <input type="datetime-local"> needs the BROWSER's own
  // local wall-clock fields (see localInputToISOWithOffset above) —
  // converting through `Date` keeps the same instant, just re-expressed
  // in whichever offset the browser itself is in.
  const handlePickBestHour = useCallback((isoHour) => {
    const d = new Date(isoHour);
    if (Number.isNaN(d.getTime())) return;
    const pad = (n) => String(n).padStart(2, '0');
    setDepartureLocal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
  }, []);

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-black uppercase tracking-tight text-ink flex items-center gap-2">
            <Navigation className="w-5 h-5 text-orange-400" />
            Heat-Safe Routing
          </h1>
          <p className="text-sm text-inkmuted mt-1 max-w-2xl">
            Both points must fall inside {city.name}'s
            boundary (shown on the map).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4">
        {/* Controls + results panel */}
        <div className="space-y-3">
          <BestHoursTimeline cityId={city.id} point={origin} tempUnit={tempUnit} onPickHour={handlePickBestHour} />

          <div className="p-4 rounded-xl border border-border bg-surface/40 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-mono uppercase text-inkfaint">Trip</span>
              <button onClick={handleClear} className="text-inkfaint hover:text-ink flex items-center gap-1 text-[11px] cursor-pointer">
                <Trash2 className="w-3 h-3" /> Clear
              </button>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-green-400 shrink-0" />
                <div
                  className="flex-1"
                  onFocus={() => setClickTarget('origin')}
                  onClick={() => setClickTarget('origin')}
                >
                  <AddressSearch
                    cityId={city.id}
                    placeholder="Type an address, or click the map"
                    value={originLabel}
                    onSelect={handleAddressSelect('origin')}
                    accentClassName="text-green-400/70"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { setClickTarget('origin'); handleUseMyLocation(); }}
                  disabled={locating}
                  title="Use my location"
                  className="shrink-0 p-2 rounded-lg border border-border bg-surface2/40 hover:bg-surface2/70 disabled:opacity-50 cursor-pointer"
                >
                  <LocateFixed className={`w-3.5 h-3.5 text-inkmuted ${locating ? 'animate-pulse' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => handleShareLocation(origin, originLabel)}
                  disabled={!origin}
                  title="Share this location"
                  className="shrink-0 p-2 rounded-lg border border-border bg-surface2/40 hover:bg-surface2/70 disabled:opacity-30 cursor-pointer"
                >
                  {shareStatus && origin ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Share2 className="w-3.5 h-3.5 text-inkmuted" />}
                </button>
              </div>
              <span className={`block pl-6 text-[10px] font-mono uppercase ${clickTarget === 'origin' ? 'text-green-400' : 'text-inkfaint'}`}>
                Origin {clickTarget === 'origin' && '· next map click sets this'}
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Flag className="w-4 h-4 text-red-400 shrink-0" />
                <div
                  className="flex-1"
                  onFocus={() => setClickTarget('destination')}
                  onClick={() => setClickTarget('destination')}
                >
                  <AddressSearch
                    cityId={city.id}
                    placeholder="Type an address, or click the map"
                    value={destinationLabel}
                    onSelect={handleAddressSelect('destination')}
                    accentClassName="text-red-400/70"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { setClickTarget('destination'); handleUseMyLocation(); }}
                  disabled={locating}
                  title="Use my location"
                  className="shrink-0 p-2 rounded-lg border border-border bg-surface2/40 hover:bg-surface2/70 disabled:opacity-50 cursor-pointer"
                >
                  <LocateFixed className={`w-3.5 h-3.5 text-inkmuted ${locating ? 'animate-pulse' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => handleShareLocation(destination, destinationLabel)}
                  disabled={!destination}
                  title="Share this location"
                  className="shrink-0 p-2 rounded-lg border border-border bg-surface2/40 hover:bg-surface2/70 disabled:opacity-30 cursor-pointer"
                >
                  {shareStatus && destination ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Share2 className="w-3.5 h-3.5 text-inkmuted" />}
                </button>
              </div>
              <span className={`block pl-6 text-[10px] font-mono uppercase ${clickTarget === 'destination' ? 'text-red-400' : 'text-inkfaint'}`}>
                Destination {clickTarget === 'destination' && '· next map click sets this'}
              </span>
              <div className="pl-6 pt-1">
                <PoiPicker cityId={city.id} near={origin} onSelect={handleAddressSelect('destination')} />
              </div>
            </div>

            {locateError && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-2 break-words">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">{locateError}</span>
              </div>
            )}

            {shareStatus === 'copied' && (
              <p className="text-[11px] text-green-400">Location copied to clipboard.</p>
            )}
            {shareStatus === 'error' && (
              <p className="text-[11px] text-red-300">Couldn't share that location.</p>
            )}


            <div>
              <label className="flex items-center gap-1.5 text-[11px] font-mono uppercase text-inkfaint mb-1">
                <Clock className="w-3 h-3" /> Departure (optional — defaults to now)
              </label>
              <input
                type="datetime-local"
                value={departureLocal}
                onChange={(e) => setDepartureLocal(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface2/60 text-sm text-ink"
              />
            </div>

            <button
              onClick={handleFindRoutes}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-black font-semibold text-sm cursor-pointer"
            >
              {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Navigation className="w-4 h-4" />}
              {loading ? 'Scoring routes…' : 'Find Heat-Safe Routes'}
            </button>

            {error && (
              <div className="flex items-start gap-1.5 text-[12px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-2.5 py-2 break-words whitespace-pre-wrap max-h-40 overflow-y-auto">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">{error}</span>
              </div>
            )}

            {boundaryError && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg px-2.5 py-2 break-words">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span className="break-words min-w-0">Couldn't load {city.name}'s boundary: {boundaryError}</span>
              </div>
            )}
          </div>

          {routes.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase text-inkfaint px-1">
                <Info className="w-3 h-3" /> {routes.length} candidate route{routes.length > 1 ? 's' : ''}
              </div>
              {routes.map((route, i) => (
                <RouteCard
                  key={`${route.provider}-${i}`}
                  route={route}
                  isSelected={i === selectedIndex}
                  onSelect={() => handleSelectRoute(i)}
                  tempUnit={tempUnit}
                  isOnlyRoute={routes.length === 1}
                  isHiddenFromMap={!routeLocked && !visibleIndices.includes(i)}
                />
              ))}
              {routes.length === 1 && (
                <p className="text-[11px] text-inkfaint px-1">
                  Only one usable road path was found for this trip, so there was nothing to compare it against —
                  the Safe/Moderate/Risk badge above still reflects this route's own forecasted exposure.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Map */}
        <div className="space-y-2">
          {routeCountOptions.length > 1 && (
            <div className="flex items-center justify-between gap-2 flex-wrap px-1">
              {!routeLocked ? (
                <>
                  <span className="text-[11px] font-mono uppercase text-inkfaint">Show on map</span>
                  <div className="flex items-center gap-1">
                    {routeCountOptions.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setMaxVisibleRoutes(n)}
                        title={`Show up to ${n} route${n > 1 ? 's' : ''} at once`}
                        className={`w-7 h-7 rounded-md border text-[12px] font-mono cursor-pointer ${
                          maxVisibleRoutes === n
                            ? 'border-orange-500/60 bg-orange-500/15 text-ink'
                            : 'border-border bg-surface2/40 text-inkmuted hover:text-ink'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                    <span className="text-[10px] text-inkfaint pl-1">
                      route{maxVisibleRoutes > 1 ? 's' : ''} at once — useful if one's blocked or under construction
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-[11px] font-mono uppercase text-inkfaint">1 route selected</span>
                  <button
                    type="button"
                    onClick={handleShowAlternates}
                    className="text-[11px] text-orange-300 hover:text-orange-200 underline cursor-pointer"
                  >
                    Compare alternates again
                  </button>
                </>
              )}
            </div>
          )}
          {/* Fixed vh-based height at every breakpoint — the previous
              `lg:h-auto` here was the actual cause of the map going
              blank at desktop widths: "auto" height inside this grid
              column depends on the parent stretching correctly, which
              it wasn't reliably doing, so Leaflet was mounting into a
              0-height container and never recovering (ResizeObserver
              only fires on a LATER resize, not on a container that was
              never given a height to begin with). A constant 70vh
              (floored at 500px) sidesteps the whole grid-stretch
              question instead of depending on it. */}
          <div className="h-[70vh] min-h-[500px] rounded-xl overflow-hidden border border-border">
            <RouteMap
              center={mapCenter}
              origin={origin}
              destination={destination}
              routes={routes}
              visibleIndices={routes.length ? visibleIndices : null}
              selectedIndex={selectedIndex}
              onSelectRoute={handleSelectRoute}
              onMapClick={handleMapClick}
              boundary={boundary}
            />
          </div>
        </div>
      </div>

      {selectedRoute && (
        <p className="text-[11px] text-inkfaint px-1">
          Showing {selectedRoute.points_scored} of {selectedRoute.points_total} sampled points with a live forecast reading
          {selectedRoute.points_out_of_horizon > 0 && `, ${selectedRoute.points_out_of_horizon} beyond the 12-hour forecast window`}.
        </p>
      )}
    </div>
  );
}