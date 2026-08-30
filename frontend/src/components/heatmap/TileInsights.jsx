import React, { useState, useRef, useEffect } from 'react';
import { Satellite, Camera, FileText, Download, Loader2, AlertTriangle, Info } from 'lucide-react';
import { fetchSatellite, fetchStreetview, fetchHeatIntelligence, fetchHeatIntelligenceStatus } from '../../api/thermoraApi';
import { apiUrl } from '../../config/api';
import { LONG_POLL_INTERVAL_MS, LONG_POLL_MAX_ATTEMPTS } from '../../lib/pollConfig';
import {
  satelliteKey, streetviewKey, reportKey,
  getCachedSatellite, setCachedSatellite,
  getCachedStreetview, setCachedStreetview,
  getCachedReport, setCachedReport,
} from '../../lib/tileInsightsCache';

function toDataUri(raw) {
  if (!raw) return null;
  return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
}

function SegmentBars({ segments }) {
  const entries = Object.entries(segments || {})
    .filter(([, v]) => v != null && v > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) return null;
  return (
    <div className="space-y-1 mt-2">
      {entries.slice(0, 6).map(([label, pct]) => (
        <div key={label} className="flex items-center gap-2 text-[10px] font-mono">
          <span className="w-20 truncate text-inkfaint capitalize">{label.replace(/_/g, ' ')}</span>
          <div className="flex-1 h-1.5 bg-surface2 rounded-full overflow-hidden">
            <div className="h-full bg-orange-500/70" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <span className="w-9 text-right text-inksoft">{Number(pct).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}

// Every one of these is its OWN billed FortyGuard request, so — same rule
// as everywhere else in this app — nothing here fires automatically.
// Each block starts idle and only calls out when its own "Load"/"Generate"
// button is clicked.
//
// Loaded results are cached at TWO levels: FortyGuard/Postgres cache it
// backend-side (repository.py), AND this component caches the actual
// result client-side too (see lib/tileInsightsCache.js), keyed by real
// coordinates rather than React component identity. That second layer is
// what makes "go back to a tile you already loaded" show it INSTANTLY
// with no loading flash and no network round-trip at all — not just
// cheaply re-fetched, but not re-fetched.
const IDLE = { status: 'idle', data: null, error: null };

export function TileInsights({ latitude, longitude, temperature, date, time }) {
  const satKey = satelliteKey(latitude, longitude, date, time);
  const svKey = streetviewKey(latitude, longitude);
  const repKey = reportKey(latitude, longitude, date);

  const [satellite, setSatellite] = useState(() => getCachedSatellite(satKey) || IDLE);
  const [streetview, setStreetview] = useState(() => getCachedStreetview(svKey) || IDLE);
  const [report, setReport] = useState(() => getCachedReport(repKey) || IDLE);
  const reportPollRef = useRef(null);

  // A poll left running for a tile the user has since navigated away from
  // would keep ticking in the background pointlessly (and could call
  // setState on an unmounted component) — clear it on unmount.
  useEffect(() => () => clearTimeout(reportPollRef.current), []);

  const loadSatellite = async () => {
    setSatellite({ status: 'loading', data: null, error: null });
    try {
      const result = await fetchSatellite({ latitude, longitude, date, time: time || '14:00' });
      const next = { status: 'done', data: result, error: null };
      setSatellite(next);
      setCachedSatellite(satKey, next);
    } catch (err) {
      const next = { status: 'error', data: null, error: err.message || String(err) };
      setSatellite(next);
      setCachedSatellite(satKey, next);
    }
  };

  const loadStreetview = async () => {
    setStreetview({ status: 'loading', data: null, error: null });
    try {
      const result = await fetchStreetview({ latitude, longitude });
      const next = { status: 'done', data: result, error: null };
      setStreetview(next);
      setCachedStreetview(svKey, next);
    } catch (err) {
      const next = { status: 'error', data: null, error: err.message || String(err) };
      setStreetview(next);
      setCachedStreetview(svKey, next);
    }
  };

  const generateReport = async () => {
    setReport({ status: 'loading', downloadUrl: null, error: null, phase: 'submitting' });
    try {
      const started = await fetchHeatIntelligence({
        latitude, longitude, temperature: temperature ?? 30, date, analysis: ['environmental'],
      });

      if (started.status === 'Completed') {
        finishReport(started.download_url);
        return;
      }
      if (started.status === 'Failed') {
        failReport(started.error || 'Heat Intelligence job failed');
        return;
      }
      // 'Processing' — FortyGuard's own docs say this can take several
      // minutes, so this genuinely polls rather than blocking the
      // request open. Every poll here hits OUR backend's Postgres-backed
      // status route, never FortyGuard directly (see routers/heat_intelligence.py).
      setReport({ status: 'loading', downloadUrl: null, error: null, phase: 'processing' });
      pollReportStatus(started.activity_id);
    } catch (err) {
      failReport(err.message || String(err));
    }
  };

  // Give-up point shared with liveDataStore.js's heatmap poll, and
  // deliberately kept comfortably past the backend's own real ceiling —
  // see pollConfig.js. This used to be a locally hardcoded 7.5 minutes,
  // shorter than the backend's ~10-11 minute ceiling for a single Heat
  // Intelligence job, which meant a genuinely slow (but real) FortyGuard
  // run showed up here as a false "Retry" moments before the backend
  // actually finished it successfully.
  const pollReportStatus = (activityId, attempt = 1) => {
    fetchHeatIntelligenceStatus(activityId)
      .then((status) => {
        if (status.status === 'Completed') {
          finishReport(status.download_url);
        } else if (status.status === 'Failed') {
          failReport(status.error || 'Heat Intelligence job failed');
        } else if (attempt >= LONG_POLL_MAX_ATTEMPTS) {
          failReport('Still processing after several minutes — try again shortly.');
        } else {
          reportPollRef.current = setTimeout(() => pollReportStatus(activityId, attempt + 1), LONG_POLL_INTERVAL_MS);
        }
      })
      .catch((err) => failReport(err.message || String(err)));
  };

  const finishReport = (downloadUrl) => {
    // Backend already downloaded FortyGuard's temporary signed PDF URL
    // server-side and never exposes it to us — download_url here points
    // at OUR OWN /api/heat-intelligence/{id}/download route, not theirs.
    const next = { status: 'done', downloadUrl: apiUrl(downloadUrl), error: null };
    setReport(next);
    setCachedReport(repKey, next);
  };

  const failReport = (message) => {
    const next = { status: 'error', downloadUrl: null, error: message };
    setReport(next);
    setCachedReport(repKey, next);
  };

  return (
    <div className="space-y-3 pt-4 border-t border-border">
      <div className="text-[10px] font-mono text-inkmuted uppercase tracking-wider flex items-center gap-1.5">
        <Info className="w-3 h-3" /> Deeper Look (each loads on demand — its own live request)
      </div>

      {/* Satellite Segmentation */}
      <div className="p-3 bg-app/70 rounded-xl border border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-inksoft flex items-center gap-1.5"><Satellite className="w-3.5 h-3.5 text-orange-400" /> Satellite Imagery</span>
          {satellite.status === 'idle' && (
            <button onClick={loadSatellite} className="text-[11px] font-semibold text-orange-400 hover:text-orange-300 cursor-pointer">Load</button>
          )}
          {satellite.status === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-inkfaint" />}
        </div>
        {satellite.status === 'error' && (
          <p className="text-[10px] text-red-400 font-mono mt-1.5 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {satellite.error}</p>
        )}
        {satellite.status === 'done' && (
          <div className="mt-2 space-y-2">
            {satellite.data?.original_image?.[0] && (
              <img src={toDataUri(satellite.data.original_image[0])} alt="Satellite view" className="w-full rounded-lg border border-border" />
            )}
            {satellite.data?.segmentation?.image_content && (
              <img src={toDataUri(satellite.data.segmentation.image_content)} alt="Segmentation mask" className="w-full rounded-lg border border-border" />
            )}
            <SegmentBars segments={satellite.data?.segmentation?.segments} />
            <p className="text-[9px] text-inkfaint font-mono">Image year: {satellite.data?.image_year ?? '—'} · Source: FortyGuard Satellite View Segmentation (live)</p>
          </div>
        )}
        <p className="text-[9px] text-inkfaint font-mono mt-1 flex items-start gap-1"><Info className="w-2.5 h-2.5 mt-0.5 shrink-0" />FortyGuard recommends this date/time match the heatmap's — using {date}{time ? ` ${time}` : ' 14:00 (default — this window has no single hour selected)'}.</p>
      </div>

      {/* Street View Segmentation */}
      <div className="p-3 bg-app/70 rounded-xl border border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-inksoft flex items-center gap-1.5"><Camera className="w-3.5 h-3.5 text-orange-400" /> Street View</span>
          {streetview.status === 'idle' && (
            <button onClick={loadStreetview} className="text-[11px] font-semibold text-orange-400 hover:text-orange-300 cursor-pointer">Load</button>
          )}
          {streetview.status === 'loading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-inkfaint" />}
        </div>
        {streetview.status === 'error' && (
          <p className="text-[10px] text-red-400 font-mono mt-1.5 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {streetview.error}</p>
        )}
        {streetview.status === 'done' && (
          <div className="mt-2 space-y-2">
            {streetview.data?.front?.original_image && (
              <img src={toDataUri(streetview.data.front.original_image)} alt="Street view" className="w-full rounded-lg border border-border" />
            )}
            {streetview.data?.front?.segmented_image && (
              <img src={toDataUri(streetview.data.front.segmented_image)} alt="Street view segmentation" className="w-full rounded-lg border border-border" />
            )}
            <SegmentBars segments={streetview.data?.front?.segments} />
            <p className="text-[9px] text-inkfaint font-mono">Captured: {streetview.data?.front?.image_date ?? '—'} · Source: FortyGuard Street View Segmentation (live)</p>
          </div>
        )}
      </div>

      {/* Heat Intelligence PDF */}
      <div className="p-3 bg-app/70 rounded-xl border border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-inksoft flex items-center gap-1.5"><FileText className="w-3.5 h-3.5 text-orange-400" /> Heat Intelligence PDF</span>
          {report.status === 'idle' && (
            <button onClick={generateReport} className="text-[11px] font-semibold text-orange-400 hover:text-orange-300 cursor-pointer">Generate</button>
          )}
        </div>
        {report.status === 'loading' && (
          <p className="text-[10px] text-inkfaint font-mono mt-1.5 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin shrink-0" />
            {report.phase === 'submitting'
              ? 'Submitting to FortyGuard…'
              : "Generating — FortyGuard says this can take several minutes. Keep this tab open; the button will update when it's ready."}
          </p>
        )}
        {report.status === 'error' && (
          <p className="text-[10px] text-red-400 font-mono mt-1.5 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> {report.error}</p>
        )}
        {report.status === 'done' && (
          <a href={report.downloadUrl} target="_blank" rel="noreferrer" className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-orange-400 hover:text-orange-300">
            <Download className="w-3.5 h-3.5" /> Download report PDF
          </a>
        )}
      </div>
    </div>
  );
}