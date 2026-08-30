import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Same vanilla-Leaflet approach as heatmap/LeafletHeatmapMap.jsx (not
// react-leaflet) — kept consistent with that component rather than
// introducing a second mapping pattern into the codebase.

const LABEL_COLORS = {
  fastest: '#38bdf8',   // sky-400
  coolest: '#4ade80',   // green-400
  balanced: '#c084fc',  // purple-400
};
const DEFAULT_COLOR = '#94a3b8'; // slate-400, unlabeled/other candidate routes

function colorForRoute(route, isSelected) {
  const primaryLabel = route.labels?.[0];
  const color = LABEL_COLORS[primaryLabel] || DEFAULT_COLOR;
  return isSelected ? color : `${color}99`; // dim non-selected routes slightly
}

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

export function RouteMap({ center, origin, destination, routes = [], visibleIndices = null, selectedIndex, onSelectRoute, onMapClick, boundary }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const originMarkerRef = useRef(null);
  const destMarkerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const boundaryLayerRef = useRef(null);
  const boundaryBoundsRef = useRef(null);
  const hasFitBoundaryRef = useRef(false);
  const [hasBoundary, setHasBoundary] = useState(false);
  const onMapClickRef = useRef(onMapClick);
  onMapClickRef.current = onMapClick;

  // Map created once. click handler reads the latest onMapClick via a ref
  // so it never needs to be re-registered (and never captures a stale
  // closure) as origin/destination state changes on every click.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([center.lat, center.lon], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    map.on('click', (e) => onMapClickRef.current?.(e.latlng.lat, e.latlng.lng));
    mapRef.current = map;
    routeLayerRef.current = L.layerGroup().addTo(map);

    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // City boundary polygon — the same one routers/routing.py enforces
  // server-side (see routers/city_boundary.py). Drawn as TWO overlaid
  // layers (a thick translucent "glow" underneath a thinner solid
  // line) so it stays visible even where the real admin boundary is a
  // thin annexation strip a single 2px dashed line could get lost in —
  // US city limits (Houston's especially) are often a very irregular,
  // clawed shape, not a clean blob.
  //
  // Real bug this replaced: fitBounds() used to fit the RAW polygon's
  // bbox with no zoom cap. A boundary with one far-flung thin exclave
  // (annexed strip miles from the city core) blows that bbox out to
  // cover a whole region — the fit would zoom out until the entire
  // metro was in frame and the actual city became a barely-visible
  // sliver, which read as "no boundary at all" even though it was
  // technically on-screen. maxZoom below keeps the fit from zooming out
  // past a sane regional view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (boundaryLayerRef.current) {
      boundaryLayerRef.current.remove();
      boundaryLayerRef.current = null;
    }
    hasFitBoundaryRef.current = false;
    if (boundary) {
      const glow = L.geoJSON(boundary, {
        style: {
          color: '#fb923c', // orange-400
          weight: 7,
          opacity: 0.25,
          fill: false,
        },
      });
      const outline = L.geoJSON(boundary, {
        style: {
          color: '#fb923c',
          weight: 3,
          opacity: 1,
          fill: true,
          fillColor: '#fb923c',
          fillOpacity: 0.06,
          dashArray: '8 5',
        },
      });
      const layer = L.layerGroup([glow, outline]).addTo(map);
      outline.bringToBack();
      glow.bringToBack();
      boundaryLayerRef.current = layer;
      boundaryBoundsRef.current = outline.getBounds();
      setHasBoundary(true);
      if (!hasFitBoundaryRef.current && !routes.length) {
        map.fitBounds(outline.getBounds(), { padding: [20, 20], maxZoom: 12 });
        hasFitBoundaryRef.current = true;
      }
    } else {
      boundaryBoundsRef.current = null;
      setHasBoundary(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundary]);

  const handleShowBoundary = () => {
    const map = mapRef.current;
    const bounds = boundaryBoundsRef.current;
    if (map && bounds) map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
  };

  // Origin marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (originMarkerRef.current) {
      originMarkerRef.current.remove();
      originMarkerRef.current = null;
    }
    if (origin) {
      originMarkerRef.current = L.circleMarker([origin.lat, origin.lon], {
        radius: 8, color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.9, weight: 2,
      }).bindTooltip('Origin').addTo(map);
    }
  }, [origin]);

  // Destination marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (destMarkerRef.current) {
      destMarkerRef.current.remove();
      destMarkerRef.current = null;
    }
    if (destination) {
      destMarkerRef.current = L.circleMarker([destination.lat, destination.lon], {
        radius: 8, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.9, weight: 2,
      }).bindTooltip('Destination').addTo(map);
    }
  }, [destination]);

  // Route polylines — redraw whenever the candidate set, the visible
  // subset, or the selection changes. `visibleIndices` (indices into
  // the full `routes` array, keeping selectedIndex/onSelectRoute
  // meaningful even though only some routes are drawn) lets the caller
  // cap how many alternates are shown at once — e.g. "up to 3 routes"
  // — and collapse down to just the chosen one once the person picks.
  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = routeLayerRef.current;
    if (!map || !layerGroup) return;
    layerGroup.clearLayers();
    if (!routes.length) return;

    const indicesToDraw = visibleIndices ?? routes.map((_, i) => i);

    let bounds = null;
    // Draw the selected route LAST so it renders on top of the others.
    const ordered = indicesToDraw
      .map((i) => ({ r: routes[i], i }))
      .filter(({ r }) => r)
      .sort((a, b) => (a.i === selectedIndex ? 1 : -1));
    ordered.forEach(({ r, i }) => {
      const latLngs = r.geometry.map(([lat, lon]) => [lat, lon]);
      const isSelected = i === selectedIndex;
      const line = L.polyline(latLngs, {
        color: colorForRoute(r, isSelected),
        weight: isSelected ? 6 : 4,
        opacity: isSelected ? 0.95 : 0.6,
      }).addTo(layerGroup);
      // Time span for this route, shown right on the line itself (not
      // just in the sidebar card) so it's visible while comparing
      // several alternates on the map at once.
      line.bindTooltip(formatDuration(r.duration_s), {
        permanent: true,
        direction: 'center',
        className: `route-duration-label${isSelected ? ' route-duration-label--selected' : ''}`,
        opacity: isSelected ? 0.95 : 0.75,
      });
      line.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        onSelectRoute?.(i);
      });
      bounds = bounds ? bounds.extend(line.getBounds()) : line.getBounds();
    });
    if (bounds) map.fitBounds(bounds, { padding: [40, 40] });
  }, [routes, visibleIndices, selectedIndex, onSelectRoute]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden" />
      {hasBoundary && (
        <button
          type="button"
          onClick={handleShowBoundary}
          title="Zoom out to see the full city boundary"
          className="absolute bottom-3 right-3 z-[1000] flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-mono uppercase bg-black/70 backdrop-blur border-orange-400/50 text-orange-300 hover:bg-black/85 cursor-pointer"
        >
          <span className="w-2 h-2 rounded-sm border-2 border-dashed border-orange-400" />
          City boundary
        </button>
      )}
    </div>
  );
}