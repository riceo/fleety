import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, type AppConfig, type LiveAircraft } from '../api';
import { renderIcon, renderRoundel } from '../icons';
import { isSparkly } from '../sparkle';
import { displayCallsign } from '../format';

const CLUB_BLUE = '#5b6bc4';

type EuAirport = [ident: string, name: string, lat: number, lon: number, kind: number];

interface ClubAirfield {
  id: number;
  code: string;
  name: string;
  lat: number;
  lon: number;
  is_base: number;
}

// Airfield layers: the full European dataset fades in with zoom; the club's
// own airfields are always-on branded markers, with Rochester/Lydd (bases)
// most prominent.
function addAirfieldLayers(map: maplibregl.Map, accent: string, onBases?: (bases: ClubAirfield[]) => void): void {
  map.addImage('af-base', renderRoundel(17, accent, '#ffffff', '#ffffff'), { pixelRatio: 2 });
  map.addImage('af-club', renderRoundel(12, CLUB_BLUE, '#ffffff', '#ffffff'), { pixelRatio: 2 });

  map.addSource('eu-airports', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource('club-airfields', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  const dotLayer = (id: string, kind: number, minzoom: number, radius: number, color: string) =>
    map.addLayer({
      id,
      type: 'circle',
      source: 'eu-airports',
      minzoom,
      filter: ['==', ['get', 'kind'], kind],
      paint: {
        'circle-radius': radius,
        'circle-color': color,
        'circle-opacity': 0.75,
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(255,255,255,0.9)',
      },
    });
  dotLayer('eu-airports-large', 2, 4, 4, '#8496cf');
  dotLayer('eu-airports-medium', 1, 6.5, 3, '#6c7ca8');
  dotLayer('eu-airports-small', 0, 8.5, 2.4, '#566489');

  map.addLayer({
    id: 'eu-airports-labels',
    type: 'symbol',
    source: 'eu-airports',
    minzoom: 9.5,
    layout: {
      'text-field': [
        'format',
        ['get', 'ident'],
        {},
        '\n',
        {},
        ['get', 'name'],
        { 'font-scale': 0.85 },
      ],
      'text-size': 10,
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-optional': true,
      'text-font': ['Noto Sans Regular'],
      'text-max-width': 8,
    },
    paint: {
      'text-color': '#7787ad',
      'text-halo-color': 'rgba(5,8,16,0.85)',
      'text-halo-width': 1.4,
    },
  });

  map.addLayer({
    id: 'club-airfields-markers',
    type: 'symbol',
    source: 'club-airfields',
    layout: {
      'icon-image': ['case', ['==', ['get', 'isBase'], 1], 'af-base', 'af-club'],
      'icon-allow-overlap': true,
      'text-field': [
        'format',
        ['get', 'code'],
        {},
        '\n',
        {},
        ['get', 'name'],
        { 'font-scale': 0.8, 'text-font': ['literal', ['Noto Sans Regular']] },
      ],
      'text-size': ['case', ['==', ['get', 'isBase'], 1], 12, 10],
      // Variable anchors let the label slide to a free side instead of being
      // dropped when an aircraft (symbol layers above win collisions) sits on
      // top of the field — e.g. circuits directly over Stoke.
      'text-variable-anchor': ['top', 'bottom', 'right', 'left'],
      'text-radial-offset': 1.1,
      'text-justify': 'auto',
      'text-optional': true,
      'text-font': ['Noto Sans Bold'],
      'text-max-width': 9,
    },
    paint: {
      'text-color': ['case', ['==', ['get', 'isBase'], 1], accent, '#93a4de'],
      'text-halo-color': 'rgba(5,8,16,0.9)',
      'text-halo-width': 1.6,
    },
  });

  fetch('/airports-eu.json')
    .then((r) => (r.ok ? (r.json() as Promise<EuAirport[]>) : null))
    .then((rows) => {
      if (!rows) return;
      const src = map.getSource('eu-airports') as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: 'FeatureCollection',
        features: rows.map((a) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [a[3], a[2]] },
          properties: { ident: a[0], name: a[1], kind: a[4] },
        })),
      });
    })
    .catch(() => {});

  api<{ airfields: ClubAirfield[] }>('/api/airfields')
    .then((res) => {
      const src = map.getSource('club-airfields') as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: 'FeatureCollection',
        features: res.airfields.map((a) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [a.lon, a.lat] },
          properties: { code: a.code, name: a.name, isBase: a.is_base },
        })),
      });
      onBases?.(res.airfields.filter((a) => a.is_base === 1));
    })
    .catch(() => {});
}

export interface MapViewHandle {
  flyToAircraft: (id: number) => void;
  fitFleet: () => void;
  fitOverview: () => void;
  fitOverviewOn: (id: number) => void;
  getMap: () => maplibregl.Map | null;
}

interface Props {
  config: AppConfig;
  fleet: LiveAircraft[];
  selectedId?: number | null;
  onSelect?: (id: number | null) => void;
  followId?: number | null;
  kiosk?: boolean;
}

// How stale a fix can be and still appear on the map at all.
const MAP_MAX_AGE_MS = 24 * 3600 * 1000;

// Dead reckoning: between pings an airborne aircraft glides along its last
// track at its last groundspeed, so motion is continuous instead of stepping
// every poll. Capped — beyond this we freeze at the last fix rather than
// fabricate a position through a real coverage gap.
const DEAD_RECKON_MAX_MS = 60_000;

function projectedCoords(a: LiveAircraft, now: number): [number, number] {
  const p = a.pos!;
  if (a.status !== 'airborne' || p.gs == null || p.gs < 30 || p.track == null) return [p.lon, p.lat];
  const ageMs = now - p.ts;
  if (ageMs <= 0) return [p.lon, p.lat];
  const distNm = (p.gs * Math.min(ageMs, DEAD_RECKON_MAX_MS)) / 3_600_000;
  const rad = (p.track * Math.PI) / 180;
  const lat = p.lat + (distNm * Math.cos(rad)) / 60;
  const lon = p.lon + (distNm * Math.sin(rad)) / (60 * Math.cos((p.lat * Math.PI) / 180));
  return [lon, lat];
}

// The fleet's "local cluster" for auto-fit: aircraft within this of the map
// default centre. A guest jet 1,000nm away gets a focus button, not a zoom-out.
const CLUSTER_RADIUS_DEG = 3;

export const MapView = forwardRef<MapViewHandle, Props>(function MapView(
  { config, fleet, selectedId, onSelect, followId, kiosk },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const fleetRef = useRef(fleet);
  fleetRef.current = fleet;
  const basesRef = useRef<ClubAirfield[]>([]);
  // An overview fit requested before the airfields fetch resolves would frame
  // aircraft only — remember and re-fit once the bases arrive.
  const overviewPendingRef = useRef(false);

  const fitOverview = () => {
    const map = mapRef.current;
    if (!map) return;
    if (basesRef.current.length === 0) overviewPendingRef.current = true;
    const now = Date.now();
    const b = new maplibregl.LngLatBounds();
    let any = false;
    for (const a of fleetRef.current) {
      if (a.pos && now - a.pos.ts < MAP_MAX_AGE_MS) {
        b.extend([a.pos.lon, a.pos.lat]);
        any = true;
      }
    }
    for (const base of basesRef.current) {
      b.extend([base.lon, base.lat]);
      any = true;
    }
    if (!any) b.extend([centerLon, centerLat]);
    map.fitBounds(b, { padding: 90, maxZoom: 11, duration: 1100 });
  };
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId ?? null;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const followRef = useRef(followId);
  followRef.current = followId ?? null;
  const syncDataRef = useRef<() => void>(() => {});
  const iconSigs = useRef(new Map<number, string>());

  const [centerLat, centerLon] = (config.mapCenter ?? '51.3519,0.5033').split(',').map(Number);

  useEffect(() => {
    if (!containerRef.current) return;
    // Note: spreading an explicit `undefined` for an option OVERRIDES the
    // MapLibre default (fadeDuration: undefined => NaN symbol opacity => no
    // labels/icons anywhere) — only set kiosk overrides when they apply.
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: config.tileStyleUrl ?? 'https://tiles.openfreemap.org/styles/dark',
      center: [centerLon || 0.5, centerLat || 51.35],
      zoom: config.mapZoom || 9,
      attributionControl: { compact: true },
      ...(kiosk ? { pixelRatio: Math.min(window.devicePixelRatio, 1.5), fadeDuration: 0 } : {}),
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    mapRef.current = map;
    (window as unknown as { __fvMap?: maplibregl.Map }).__fvMap = map;

    // Keep the canvas in sync with container size (background tabs, sheet
    // toggles, TV orientation changes).
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current);

    // Dead-reckoning tick: once a second, re-project airborne icons along
    // their last track/speed so motion is continuous between pings — and keep
    // follow mode gliding with the projection.
    const drTick = setInterval(() => {
      if (!readyRef.current || !mapRef.current) return;
      if (!fleetRef.current.some((a) => a.status === 'airborne')) return;
      syncDataRef.current();
      const fid = followRef.current;
      if (fid) {
        const a = fleetRef.current.find((x) => x.id === fid);
        if (a?.pos) {
          mapRef.current.easeTo({ center: projectedCoords(a, Date.now()), duration: 950, easing: (t) => t });
        }
      }
    }, 1000);

    map.on('load', () => {
      addAirfieldLayers(map, config.accent ?? '#e32636', (bases) => {
        basesRef.current = bases;
        if (overviewPendingRef.current) {
          overviewPendingRef.current = false;
          fitOverview();
        }
      });
      map.addSource('trails', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        lineMetrics: true, // enables the sparkle gradient
      });
      map.addSource('aircraft', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'trails',
        type: 'line',
        source: 'trails',
        filter: ['!=', ['get', 'sparkle'], true],
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2.5,
          'line-opacity': 0.75,
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      // ✨ The Honor trail: a shimmer gradient with little stars strung along it.
      map.addLayer({
        id: 'trails-sparkle',
        type: 'line',
        source: 'trails',
        filter: ['==', ['get', 'sparkle'], true],
        paint: {
          'line-width': 3.2,
          'line-opacity': 0.95,
          'line-gradient': [
            'interpolate',
            ['linear'],
            ['line-progress'],
            0, '#7dd8ff',
            0.35, '#c792ff',
            0.7, '#ff8ad8',
            1, '#ffd166',
          ],
        },
        layout: { 'line-cap': 'round', 'line-join': 'round' },
      });
      map.addLayer({
        id: 'trails-sparkle-stars',
        type: 'symbol',
        source: 'trails',
        filter: ['==', ['get', 'sparkle'], true],
        layout: {
          'symbol-placement': 'line',
          'symbol-spacing': 55,
          'text-field': '✦',
          'text-size': 11,
          'text-allow-overlap': true,
          'text-keep-upright': false,
          'text-font': ['Noto Sans Regular'],
        },
        paint: {
          'text-color': '#ffd6f2',
          'text-halo-color': 'rgba(255, 138, 216, 0.6)',
          'text-halo-width': 1.2,
        },
      });
      // Soft glow under a sparkly aircraft's icon.
      map.addLayer({
        id: 'aircraft-sparkle-glow',
        type: 'circle',
        source: 'aircraft',
        filter: ['==', ['get', 'sparkle'], true],
        paint: {
          'circle-radius': 20,
          'circle-color': '#ff8ad8',
          'circle-blur': 1,
          'circle-opacity': 0.45,
        },
      });
      map.addLayer({
        id: 'aircraft-icons',
        type: 'symbol',
        source: 'aircraft',
        layout: {
          'icon-image': ['get', 'iconKey'],
          'icon-size': ['case', ['get', 'selected'], 0.52, 0.42],
          'icon-rotate': ['get', 'rotation'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'text-field': ['get', 'label'],
          'text-size': 11,
          'text-offset': [0, 1.9],
          'text-anchor': 'top',
          'text-optional': true,
          'text-font': ['Noto Sans Bold'],
        },
        paint: {
          'text-color': '#eef2fb',
          'text-halo-color': 'rgba(5,8,16,0.9)',
          'text-halo-width': 1.8,
          'icon-opacity': ['case', ['get', 'ghost'], 0.55, 1],
        },
      });
      // Call through a ref so the handler always sees the latest onSelect (its
      // closure over the live fleet stays current — the mount-time onSelect
      // captured an empty fleet, so map clicks never updated the share URL).
      map.on('click', 'aircraft-icons', (e) => {
        const f = e.features?.[0];
        if (f) onSelectRef.current?.(Number(f.properties?.id));
      });
      map.on('click', (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: ['aircraft-icons'] });
        if (feats.length === 0) onSelectRef.current?.(null);
      });
      map.on('mouseenter', 'aircraft-icons', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'aircraft-icons', () => (map.getCanvas().style.cursor = ''));
      readyRef.current = true;
      syncData();
    });

    return () => {
      readyRef.current = false;
      clearInterval(drTick);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      iconSigs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tileStyleUrl]);

  const syncData = () => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const now = Date.now();
    const current = fleetRef.current;

    // Icons: (re)load when the aircraft's icon/colour signature changes.
    for (const a of current) {
      const sig = `${a.icon}|${a.iconUrl ?? ''}|${a.color}`;
      const key = `ac-${a.id}`;
      if (iconSigs.current.get(a.id) !== sig) {
        iconSigs.current.set(a.id, sig);
        void renderIcon(a.icon, a.iconUrl, a.color)
          .then((img) => {
            if (!mapRef.current || !readyRef.current) return;
            if (mapRef.current.hasImage(key)) mapRef.current.removeImage(key);
            mapRef.current.addImage(key, img, { pixelRatio: 2 });
          })
          .catch(() => {});
      }
    }

    const points = current
      .filter((a) => a.pos && now - a.pos.ts < MAP_MAX_AGE_MS)
      .map((a) => {
        const sparkle = isSparkly(a);
        // Airborne label prefers the transmitted callsign, then the admin
        // callsign (spoken form) — matching the strips — then registration.
        const label =
          a.status === 'airborne'
            ? displayCallsign(a.callsign || a.liveCallsign) || a.registration
            : a.registration;
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: projectedCoords(a, now) },
          properties: {
            id: a.id,
            iconKey: `ac-${a.id}`,
            rotation: a.pos!.track ?? 0,
            label: sparkle ? `✨ ${label} ✨` : label,
            selected: a.id === selectedId,
            ghost: a.status !== 'airborne',
            sparkle,
          },
        };
      });
    const trails = current
      .filter((a) => a.trail.length > 1 && a.status === 'airborne')
      .map((a) => ({
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: a.trail },
        properties: { color: a.color, sparkle: isSparkly(a) },
      }));
    (map.getSource('aircraft') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: points,
    });
    (map.getSource('trails') as maplibregl.GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: trails,
    });
  };

  // The dead-reckoning tick calls syncData through this ref — reassigned every
  // render so it always sees the current fleet/selection closures.
  syncDataRef.current = syncData;

  useEffect(syncData, [fleet, selectedId]);

  // Follow mode: gently track the selected aircraft.
  useEffect(() => {
    if (!followId) return;
    const a = fleet.find((x) => x.id === followId);
    const map = mapRef.current;
    if (a?.pos && map && readyRef.current) {
      map.easeTo({ center: [a.pos.lon, a.pos.lat], duration: 900 });
    }
  }, [fleet, followId]);

  useImperativeHandle(ref, () => ({
    flyToAircraft: (id: number) => {
      const a = fleetRef.current.find((x) => x.id === id);
      if (a?.pos && mapRef.current) {
        mapRef.current.flyTo({ center: [a.pos.lon, a.pos.lat], zoom: Math.max(mapRef.current.getZoom(), 10) });
      }
    },
    fitFleet: () => {
      const map = mapRef.current;
      if (!map) return;
      const now = Date.now();
      // Frame the local cluster only — far-away guests would zoom Kent out to
      // a continent view.
      const local = fleetRef.current.filter(
        (a) =>
          a.pos &&
          now - a.pos.ts < MAP_MAX_AGE_MS &&
          Math.abs(a.pos.lat - centerLat) < CLUSTER_RADIUS_DEG &&
          Math.abs(a.pos.lon - centerLon) < CLUSTER_RADIUS_DEG
      );
      if (local.length === 0) return;
      const b = new maplibregl.LngLatBounds();
      for (const a of local) b.extend([a.pos!.lon, a.pos!.lat]);
      b.extend([centerLon, centerLat]);
      map.fitBounds(b, { padding: 80, maxZoom: 11, duration: 900 });
    },
    // Kiosk overview: frame every fresh aircraft AND the club's base
    // airfields, rather than chasing one target.
    fitOverview,
    // Overview while cycling: keep the focused aircraft dead-centre, zooming
    // out as far as needed to also hold every other aircraft and the bases —
    // a symmetric box around the focus (clarity is traded for context).
    fitOverviewOn: (id: number) => {
      const map = mapRef.current;
      if (!map) return;
      const focus = fleetRef.current.find((a) => a.id === id);
      if (!focus?.pos) {
        fitOverview();
        return;
      }
      const cx = focus.pos.lon;
      const cy = focus.pos.lat;
      const now = Date.now();
      // Minimum half-span so a lone aircraft near its base isn't over-zoomed.
      let dLon = 0.05;
      let dLat = 0.05;
      const consider = (lon: number, lat: number) => {
        dLon = Math.max(dLon, Math.abs(lon - cx));
        dLat = Math.max(dLat, Math.abs(lat - cy));
      };
      // Only genuinely-airborne aircraft (plus the focus and the bases) shape
      // the frame — a day-old parked position or a stale garbage fix must not
      // blow the zoom out to a continent. A real far-flying jet still counts.
      for (const a of fleetRef.current) {
        if (a.status === 'airborne' && a.pos && now - a.pos.ts < MAP_MAX_AGE_MS) consider(a.pos.lon, a.pos.lat);
      }
      consider(cx, cy); // the focus itself is always in-frame
      for (const base of basesRef.current) consider(base.lon, base.lat);
      const b = new maplibregl.LngLatBounds([cx - dLon, cy - dLat], [cx + dLon, cy + dLat]);
      map.fitBounds(b, { padding: 60, maxZoom: 11, duration: 1100 });
    },
    getMap: () => mapRef.current,
  }));

  return <div ref={containerRef} className="map-container" />;
});
