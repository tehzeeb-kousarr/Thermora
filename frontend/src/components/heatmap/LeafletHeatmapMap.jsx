import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { colorAtPosition, bucketIndexFor } from '../../lib/heatmapColors';

// Real Leaflet map (vanilla, not react-leaflet) rendering the actual lat/lng
// tile polygons FortyGuard returned, on an OpenStreetMap basemap.
// Exposes recenter() via ref so on-map floating controls (in the parent)
// can trigger it without lifting the whole Leaflet instance up.
export const LeafletHeatmapMap = forwardRef(function LeafletHeatmapMap({
  mapData, valueKey = 'average_temperature', city, breaks, scheme, opacity, showFill, showBorders,
  onSelectTile, selectedTileId, onBackgroundClick, interactive = true,
  exposurePoints, showExposure = false,
}, ref) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerGroupRef = useRef(null);
  const exposureLayerRef = useRef(null);
  const lastBoundsRef = useRef(null);

  useImperativeHandle(ref, () => ({
    recenter() {
      const map = mapRef.current;
      if (!map) return;
      if (lastBoundsRef.current) map.fitBounds(lastBoundsRef.current, { padding: [20, 20] });
      else map.setView([city.lat, city.lon], 15);
    },
  }), [city]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      zoomControl: interactive,
      dragging: interactive,
      scrollWheelZoom: interactive,
      doubleClickZoom: interactive,
      boxZoom: interactive,
      keyboard: interactive,
      touchZoom: interactive,
    }).setView([city.lat, city.lon], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    // Real on-map control (bottom-left, Leaflet built-in) — distinct from
    // the sidebar's stats panel, this reads directly off the current zoom.
    if (interactive) L.control.scale({ metric: true, imperial: true, position: 'bottomleft' }).addTo(map);
    mapRef.current = map;
    layerGroupRef.current = L.layerGroup().addTo(map);
    exposureLayerRef.current = L.layerGroup().addTo(map);
    if (onBackgroundClick) map.on('click', () => onBackgroundClick());

    // Leaflet caches its container's pixel size at creation time and never
    // re-checks it on its own — so whenever this container's actual size
    // changes (the sidebar or tile-details drawer opening/closing changes
    // how much width is left for this flex-1 map area, a phone rotating,
    // the browser window resizing), Leaflet keeps drawing at the STALE
    // size: grey padding along an edge, tiles that don't reach the
    // container's real edges, polygons rendered at the wrong screen
    // position — until the map happens to be panned or zoomed, which
    // forces a recalculation. A ResizeObserver on the actual DOM node
    // catches every one of those cases in one place, including ones a
    // plain `window.resize` listener would miss entirely (a drawer
    // opening doesn't resize the WINDOW, only this container).
    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize();
    });
    resizeObserver.observe(containerRef.current);

    // Covers the one case the ResizeObserver above can't: the container's
    // size is already final at mount, but Leaflet read it before the
    // surrounding flex layout had finished its first paint pass, so its
    // very first size read was wrong. Deferred one frame so this runs
    // after that layout settles, rather than racing it.
    const initialInvalidateFrame = requestAnimationFrame(() => map.invalidateSize());

    return () => {
      cancelAnimationFrame(initialInvalidateFrame);
      resizeObserver.disconnect();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city.id]);

  useEffect(() => {
    const map = mapRef.current;
    const layerGroup = layerGroupRef.current;
    if (!map || !layerGroup || !mapData?.features?.length) return;

    layerGroup.clearLayers();
    const bounds = [];

    for (const f of mapData.features) {
      const latlngs = f.geometry.coordinates[0].map(([lng, lat]) => [lat, lng]);
      latlngs.forEach((ll) => bounds.push(ll));
      // exceedance/persistence/time_of_measure tiles carry their number as
      // properties.value, not properties.average_temperature (that field
      // is tcm-only) — valueKey (passed from HeatMapView, driven off
      // activeMode) picks the right one so the map is colored by the data
      // actually being viewed instead of always reading a field that's
      // undefined for anything other than Temperature.
      const value = f.properties[valueKey];
      const idx = bucketIndexFor(value, breaks);
      const t = breaks.length > 2 ? idx / (breaks.length - 2) : 0.5;
      const isSelected = selectedTileId === f.properties.tile_id;
      const polygon = L.polygon(latlngs, {
        color: isSelected ? '#f97316' : (showBorders ? 'rgba(255,255,255,0.25)' : 'transparent'),
        weight: isSelected ? 2.5 : (showBorders ? 0.5 : 0),
        fillColor: idx < 0 ? 'rgba(120,120,120,0.4)' : colorAtPosition(scheme, t),
        fillOpacity: showFill ? opacity : 0,
      });
      if (onSelectTile) {
        polygon.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          // Tile properties alone don't carry a lat/lng — but satellite,
          // street view, and Heat Intelligence all need one to know WHERE
          // to look. Compute the polygon's centroid here, once, and pass
          // it along so the tile drawer can query those three endpoints
          // for this exact tile without guessing coordinates.
          const centroidLat = latlngs.reduce((s, p) => s + p[0], 0) / latlngs.length;
          const centroidLng = latlngs.reduce((s, p) => s + p[1], 0) / latlngs.length;
          onSelectTile({ ...f.properties, centroid_lat: centroidLat, centroid_lng: centroidLng });
        });
      }
      polygon.addTo(layerGroup);
    }

    if (bounds.length) {
      lastBoundsRef.current = bounds;
      map.fitBounds(bounds, { padding: [20, 20] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapData, valueKey, breaks, scheme, opacity, showFill, showBorders, selectedTileId]);

  // Phase 6 — exposure points (schools/hospitals) as an independent
  // toggleable layer. Kept in its own layer group and its own effect so
  // switching it on/off never re-fits or redraws the heatmap tiles above.
  useEffect(() => {
    const map = mapRef.current;
    const layer = exposureLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    if (!showExposure || !exposurePoints?.length) return;

    for (const p of exposurePoints) {
      const isSchool = p.type === 'school';
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:22px;height:22px;border-radius:9999px;display:flex;align-items:center;justify-content:center;
          background:${isSchool ? '#3b82f6' : '#ef4444'};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);
          font-size:11px;line-height:1;">${isSchool ? '🏫' : '⚕️'}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      L.marker([p.lat, p.lon], { icon })
        .bindPopup(`<strong>${p.name}</strong><br/>${p.type === 'school' ? 'School' : 'Hospital/Clinic'} · source: ${p.source}`)
        .addTo(layer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exposurePoints, showExposure]);

  return <div ref={containerRef} className="w-full h-full rounded-2xl overflow-hidden isolate" style={{ minHeight: 400 }} />;
});