import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, type Flight } from '../api';
import { useAuth } from '../auth';
import { TopBar } from '../components/TopBar';
import { fmtAlt, fmtDate, fmtDuration, fmtGs, fmtNm, fmtTime } from '../format';
import { renderIcon } from '../icons';

type TrackPoint = [lon: number, lat: number, ts: number, alt: number | null, gs: number | null, track: number | null];

export function ReplayPage() {
  const { me, config, loading } = useAuth();
  const { flightId } = useParams();
  const navigate = useNavigate();
  const [flight, setFlight] = useState<Flight | null>(null);
  const [points, setPoints] = useState<TrackPoint[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(30);
  const [missing, setMissing] = useState(false);
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    api<{ flight: Flight }>(`/api/flights/${flightId}`)
      .then((r) => setFlight(r.flight))
      .catch(() => setMissing(true));
    api<{ points: TrackPoint[] }>(`/api/flights/${flightId}/track`)
      .then((r) => setPoints(r.points))
      .catch(() => setMissing(true));
  }, [flightId]);

  // Map init
  useEffect(() => {
    if (!mapDiv.current || !config || points.length === 0 || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapDiv.current,
      style: config.tileStyleUrl ?? 'https://tiles.openfreemap.org/styles/dark',
      center: [points[0][0], points[0][1]],
      zoom: 10,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.on('load', () => {
      const line = points.map((p) => [p[0], p[1]]);
      const b = new maplibregl.LngLatBounds();
      for (const c of line) b.extend(c as [number, number]);
      map.fitBounds(b, { padding: 60, duration: 0 });
      map.addSource('full', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} },
      });
      map.addSource('done', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
      });
      map.addSource('plane', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'full',
        type: 'line',
        source: 'full',
        paint: { 'line-color': '#8aa0b8', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      map.addLayer({
        id: 'done',
        type: 'line',
        source: 'done',
        paint: { 'line-color': flight?.color ?? '#38bdf8', 'line-width': 3 },
        layout: { 'line-cap': 'round' },
      });
      void renderIcon('low-wing', null, flight?.color ?? '#38bdf8').then((img) => {
        if (!mapRef.current) return;
        if (!map.hasImage('replay-plane')) map.addImage('replay-plane', img, { pixelRatio: 2 });
        map.addLayer({
          id: 'plane',
          type: 'symbol',
          source: 'plane',
          layout: {
            'icon-image': 'replay-plane',
            'icon-size': 0.4,
            'icon-rotate': ['get', 'rotation'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
          },
        });
        readyRef.current = true;
        setIdx(0);
      });
    });
    return () => {
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, points, flight?.color]);

  // Sync map with slider position
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || points.length === 0) return;
    const upto = points.slice(0, idx + 1).map((p) => [p[0], p[1]]);
    (map.getSource('done') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: upto },
      properties: {},
    });
    const p = points[idx];
    (map.getSource('plane') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p[0], p[1]] },
          properties: { rotation: p[5] ?? 0 },
        },
      ],
    });
  }, [idx, points]);

  // Playback: advance replay time by wall time × speed.
  useEffect(() => {
    if (!playing || points.length === 0) return;
    let raf = 0;
    let lastWall = performance.now();
    let replayTs = points[Math.min(idx, points.length - 1)][2];
    const step = (now: number) => {
      replayTs += (now - lastWall) * speed;
      lastWall = now;
      let i = idx;
      while (i < points.length - 1 && points[i + 1][2] <= replayTs) i++;
      if (i !== idx) setIdx(i);
      if (i >= points.length - 1) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, points]);

  const current = points[idx];
  const gapNote = useMemo(() => {
    if (!flight || flight.gap_count === 0) return null;
    return `${flight.gap_count} coverage gap${flight.gap_count > 1 ? 's' : ''} (${fmtDuration(flight.gap_seconds * 1000)}) — light aircraft drop out of receiver coverage at low level`;
  }, [flight]);

  if (!loading && me && !me.user?.role && !me.user?.platformAdmin && !me.publicMode) return <Navigate to="/login" replace />;
  if (missing) {
    return (
      <div className="app-shell">
        <TopBar />
        <main className="page">
          <p className="muted">Flight not found.</p>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      <div className="replay-layout">
        <div className="replay-head">
          {flight && (
            <>
              <h1>
                {flight.registration}
                {flight.callsign ? ` · ${flight.callsign}` : ''}
              </h1>
              <span className="muted">
                {fmtDate(flight.started_at)} · {flight.route_origin ?? flight.origin_code ?? '?'} →{' '}
                {flight.route_destination ?? flight.dest_code ?? '?'} ·{' '}
                {flight.ended_at ? fmtDuration(flight.ended_at - flight.started_at) : 'in progress'} ·{' '}
                {fmtNm(flight.distance_nm)}
              </span>
            </>
          )}
          <button
            className="btn btn-ghost small replay-exit"
            onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/history'))}
          >
            ✕ EXIT REPLAY
          </button>
        </div>
        <div className="replay-map">
          <div ref={mapDiv} className="map-container" />
          {current && (
            <div className="replay-hud">
              <div>
                <label>Time</label>
                <strong>{fmtTime(current[2])}</strong>
              </div>
              <div>
                <label>Altitude</label>
                <strong>{fmtAlt(current[3])}</strong>
              </div>
              <div>
                <label>Speed</label>
                <strong>{fmtGs(current[4])}</strong>
              </div>
            </div>
          )}
        </div>
        <div className="replay-controls">
          <button
            className="btn btn-primary"
            onClick={() => {
              if (!playing && idx >= points.length - 1) setIdx(0);
              setPlaying((v) => !v);
            }}
            disabled={points.length === 0}
          >
            {playing ? 'Pause' : idx >= points.length - 1 ? 'Restart' : 'Play'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(points.length - 1, 0)}
            value={idx}
            onChange={(e) => {
              setPlaying(false);
              setIdx(Number(e.target.value));
            }}
          />
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {[10, 30, 60, 120].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
        {gapNote && <p className="muted small gap-note">{gapNote}</p>}
      </div>
    </div>
  );
}
