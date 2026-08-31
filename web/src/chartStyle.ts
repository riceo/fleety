// "Chart" basemap: the liberty street style recoloured in place to read like
// a flying chart / atlas — green land, blue water, muted white roads, no POI
// or road-shield clutter. Board feedback: the stock light styles look too much
// like a consumer web map.
//
// Mechanism: the club's tile_style_url carries a `#fleety=chart` fragment.
// Fragments are never sent to the tile server (no CDN cache split) and older
// cached bundles that don't know the marker just render plain liberty — a
// safe rolling-deploy fallback. MapView strips the fragment for the style
// fetch and calls applyChartTheme(map) on style.load; overrides are applied
// per layer id with a tolerant lookup, so upstream style changes degrade to
// "that layer keeps its stock colour", never an error.

import type maplibregl from 'maplibre-gl';

export const CHART_FRAGMENT = 'fleety=chart';

export function isChartUrl(url: string | undefined): boolean {
  return !!url && url.split('#')[1] === CHART_FRAGMENT;
}

export function baseStyleUrl(url: string): string {
  return url.split('#')[0];
}

const LAND = '#cbe2a8'; // base land green
const WATER = '#92c3e8'; // definite chart blue
const WATERWAY = '#7db4de';
const ROAD_CASING = '#b8b2a4';
const ROAD_FILL = '#ffffff';
const ROAD_MAJOR_FILL = '#f7f3e3'; // faint cream keeps motorway/trunk hierarchy without the yellows

// Exact-id fills/lines for liberty's distinctive layers. Anything not listed
// falls through to the generic rules below or stays stock.
const FILLS: Record<string, string> = {
  park: '#b4d791',
  landcover_wood: '#a5cf87',
  landcover_grass: '#b9d998',
  landcover_ice: '#e8f2f2',
  landcover_sand: '#ede4b5',
  water: WATER,
  aeroway_fill: '#d9d6cf',
  landuse_residential: '#e3dfae', // built-up areas as pale chart yellow
  landuse_pitch: '#c3dba1',
  landuse_track: '#c3dba1',
  landuse_cemetery: '#c3dba1',
  landuse_hospital: '#c3dba1',
  landuse_school: '#c3dba1',
};

const LINES: Record<string, string> = {
  park_outline: 'rgba(154,196,120,0.6)',
  waterway_tunnel: WATERWAY,
  waterway_river: WATERWAY,
  waterway_other: WATERWAY,
  aeroway_runway: '#b5b0a6', // runways stay visible on green
  aeroway_taxiway: '#c5c0b6',
};

// The web-map clutter a chart doesn't want: satellite-ish low-zoom raster,
// buildings, POIs, road shields and road names, one-way arrows.
const HIDE = new Set([
  'natural_earth',
  'building',
  'building-3d',
  'poi_r20',
  'poi_r7',
  'poi_r1',
  'poi_transit',
  'highway-shield-non-us',
  'highway-shield-us-interstate',
  'road_shield_us',
  'highway-name-path',
  'highway-name-minor',
  'highway-name-major',
  'road_one_way_arrow',
  'road_one_way_arrow_opposite',
]);

export function applyChartTheme(map: maplibregl.Map): void {
  const layers = map.getStyle()?.layers ?? [];
  for (const layer of layers) {
    const id = layer.id;
    try {
      if (HIDE.has(id)) {
        map.setLayoutProperty(id, 'visibility', 'none');
        continue;
      }
      if (layer.type === 'background') {
        map.setPaintProperty(id, 'background-color', LAND);
        continue;
      }
      if (FILLS[id] && layer.type === 'fill') {
        map.setPaintProperty(id, 'fill-color', FILLS[id]);
        continue;
      }
      if (LINES[id] && layer.type === 'line') {
        map.setPaintProperty(id, 'line-color', LINES[id]);
        continue;
      }
      // Generic road recolour: every transportation line that isn't rail —
      // casings go grey-brown, fills white (major routes faint cream).
      const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
      if (layer.type === 'line' && sourceLayer === 'transportation' && !id.includes('rail')) {
        if (id.endsWith('_casing')) map.setPaintProperty(id, 'line-color', ROAD_CASING);
        else if (id.includes('motorway') || id.includes('trunk_primary')) {
          map.setPaintProperty(id, 'line-color', ROAD_MAJOR_FILL);
        } else {
          map.setPaintProperty(id, 'line-color', ROAD_FILL);
        }
      }
    } catch {
      /* upstream renamed or retyped a layer — leave it stock */
    }
  }
}
