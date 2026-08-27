import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { api, type AppConfig, type LiveAircraft } from '../api';
import { renderIcon, renderRoundel } from '../icons';
import { isSparkly } from '../sparkle';

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
function addAirfieldLayers(map: maplibregl.Map, accent: string): void {
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
    })
    .catch(() => {});
}

export interface MapViewHandle {
  flyToAircraft: (id: number) => void;
  fitFleet: () => void;
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

    map.on('load', () => {
      addAirfieldLayers(map, config.accent ?? '#e32636');
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
      map.on('click', 'aircraft-icons', (e) => {
        const f = e.features?.[0];
        if (f && onSelect) onSelect(Number(f.properties?.id));
      });
      map.on('click', (e) => {
        const feats = map.queryRenderedFeatures(e.point, { layers: ['aircraft-icons'] });
        if (feats.length === 0 && onSelect) onSelect(null);
      });
      map.on('mouseenter', 'aircraft-icons', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'aircraft-icons', () => (map.getCanvas().style.cursor = ''));
      readyRef.current = true;
      syncData();
    });

    return () => {
      readyRef.current = false;
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
        const label = a.status === 'airborne' ? (a.liveCallsign ?? a.registration) : a.registration;
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [a.pos!.lon, a.pos!.lat] },
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
    getMap: () => mapRef.current,
  }));

  return <div ref={containerRef} className="map-container" />;
});
