import maplibregl from 'maplibre-gl';

// Significant-weather radar overlay (RainViewer global composite).
//
// The free RainViewer tile cache serves exactly one rendering — their
// "Universal Blue" palette (the colour/options URL parameters are accepted but
// ignored) — so raw dBZ tiles aren't available. Instead a custom MapLibre
// protocol fetches each tile, maps every pixel back to a dBZ value via the
// palette RainViewer documents, drops everything below "significant", and
// repaints what's left in airborne-weather-radar bands: amber (moderate), red
// (heavy), magenta (extreme), ice-blue (snow). Light rain never reaches the
// board, so the overlay only appears when there's weather worth seeing.
//
// Weather is decorative. Every failure path here is silent — a dead weather
// API, a missing OffscreenCanvas, a malformed tile — and must never affect
// tracking, the poll of /api data, or the map itself.

const INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const REFRESH_MS = 5 * 60_000; // new frames land every ~10 min; check twice as often
const PROTOCOL = 'sigwx';
const SOURCE_ID = 'wx-radar';
const LAYER_ID = 'wx-radar';

// Thresholds (dBZ). ~30 dBZ is where "rain you'd rather not fly a light
// aircraft through" starts; any organised snow return matters.
const RAIN_MIN_DBZ = 30;
const SNOW_MIN_DBZ = 20;

// RainViewer "Universal Blue" palette, RGB per whole dBZ from -10 to +75, as
// documented at rainviewer.com/api/color-schemes.html (alpha omitted — pixels
// are matched on RGB). Values above 75 repeat the last entry.
const RAIN_RGB = (
  '636159 66635a 69665c 6c685d 6f6b5f 726e61 757062 787364 7c7565 7f7867 827b69 857d6a 88806c 8b826d 8e856f ' +
  '928871 9e9375 aa9e79 b6a97e c2b482 cec087 d2c48b d6c88f dacc93 ded097 88ddee 6cd1eb 51c5e8 36bae5 1baee2 ' +
  '00a3e0 009ad5 0091ca 0088bf 007fb4 0077aa 0070a3 00699c 006295 005b8e 005588 005180 004e78 004a70 004768 ' +
  'ffee00 ffe000 ffd200 ffc500 ffb700 ffaa00 ff9f00 ff9500 ff8b00 ff8100 ff4400 f23600 e62800 d91b00 cd0d00 ' +
  'c10000 a80000 8f0000 760000 5d0000 ffaaff ff9fff ff95ff ff8bff ff81ff ff77ff ff6cff ff62ff ff58ff ff4eff ' +
  'ffffff ffffff ffffff ffffff ffffff ffffff ffffff ffffff ffffff ffffff 00ff00'
).split(' ');
const SNOW_RGB = (
  'cfffff ceffff cdffff ccffff cbffff cbffff caffff c9ffff c8ffff c7ffff c7ffff c6ffff c5ffff c4ffff c3ffff ' +
  'c3ffff c2ffff c1ffff c0ffff bfffff bfffff b8f8ff b2f2ff abebff a5e5ff 9fdfff 98d8ff 92d2ff 8bcbff 85c5ff ' +
  '7fbfff 78b8ff 72b2ff 6babff 65a5ff 5f9fff 5b9bff 5898ff 5595ff 5292ff 4f8fff 4b8bff 4888ff 4585ff 4282ff ' +
  '3f7fff 3b7bff 3878ff 3575ff 3272ff 2f6fff 2b6bff 2868ff 2565ff 2262ff 1f5fff 1b5bff 1858ff 1555ff 1252ff ' +
  '0f4fff 0c4bff 0948ff 0645ff 0242ff 003fff 003bff 0038ff 0035ff 0032ff 002fff 002bff 0028ff 0025ff 0022ff ' +
  '001fff 001bff 0018ff 0015ff 0012ff 000fff 000cff 0009ff 0006ff 0002ff 0000ff'
).split(' ');
const DBZ_FLOOR = -10; // dBZ of index 0 in both tables

// Output bands, matching what pilots read off an airborne wx radar display.
const BAND_MODERATE: [number, number, number] = [230, 184, 0]; // 30–39 dBZ
const BAND_HEAVY: [number, number, number] = [229, 72, 77]; // 40–49 dBZ
const BAND_EXTREME: [number, number, number] = [225, 79, 225]; // ≥50 dBZ (hail risk)
const BAND_SNOW: [number, number, number] = [158, 208, 255]; // snow ≥20 dBZ

interface PaletteEntry {
  r: number;
  g: number;
  b: number;
  // Packed replacement colour: bit 24 set + rgb, or 0 to drop the pixel.
  packed: number;
}

function bandFor(dbz: number, snow: boolean): [number, number, number] | null {
  if (snow) return dbz >= SNOW_MIN_DBZ ? BAND_SNOW : null;
  if (dbz >= 50) return BAND_EXTREME;
  if (dbz >= 40) return BAND_HEAVY;
  if (dbz >= RAIN_MIN_DBZ) return BAND_MODERATE;
  return null;
}

const PALETTE: PaletteEntry[] = [];
for (const [table, snow] of [
  [RAIN_RGB, false],
  [SNOW_RGB, true],
] as const) {
  table.forEach((hex, i) => {
    const band = bandFor(DBZ_FLOOR + i, snow);
    PALETTE.push({
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      packed: band ? (1 << 24) | (band[0] << 16) | (band[1] << 8) | band[2] : 0,
    });
  });
}

// Smoothing/antialiasing means tiles contain blends of palette colours, so we
// classify by nearest RGB. Memoised across tiles — a frame reuses the same few
// thousand blends — with a cap so a day-long kiosk can't grow it forever.
const classCache = new Map<number, number>();

function classify(r: number, g: number, b: number): number {
  let best = Infinity;
  let packed = 0;
  for (const e of PALETTE) {
    const d = (e.r - r) * (e.r - r) + (e.g - g) * (e.g - g) + (e.b - b) * (e.b - b);
    if (d < best) {
      best = d;
      packed = e.packed;
      if (d === 0) break;
    }
  }
  return packed;
}

function transformPixels(data: Uint8ClampedArray): void {
  if (classCache.size > 60_000) classCache.clear();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 32) {
      data[i + 3] = 0; // fully faded edges — and un-premultiply noise with them
      continue;
    }
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let packed = classCache.get(key);
    if (packed === undefined) {
      packed = classify(data[i], data[i + 1], data[i + 2]);
      classCache.set(key, packed);
    }
    if (packed === 0) {
      data[i + 3] = 0;
      continue;
    }
    data[i] = (packed >> 16) & 255;
    data[i + 1] = (packed >> 8) & 255;
    data[i + 2] = packed & 255;
    data[i + 3] = Math.round((a / 255) * 230); // keep the source's soft edges
  }
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function encodePng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  );
}

let protocolRegistered = false;

function ensureProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  maplibregl.addProtocol(PROTOCOL, async (params, abort) => {
    const res = await fetch(params.url.replace(`${PROTOCOL}://`, 'https://'), { signal: abort.signal });
    if (!res.ok) throw new Error(`weather tile ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    try {
      const canvas = makeCanvas(bmp.width, bmp.height);
      const ctx = (canvas as HTMLCanvasElement).getContext('2d', { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
      transformPixels(img.data);
      ctx.putImageData(img, 0, 0);
      return { data: await (await encodePng(canvas)).arrayBuffer() };
    } finally {
      bmp.close();
    }
  });
}

interface WeatherIndex {
  host?: string;
  radar?: { past?: { time: number; path: string }[] };
}

// Attach the overlay to a loaded map and keep it on the newest radar frame.
// Returns a detach function (clears the refresh timer; layer teardown rides
// map.remove()). Call only after `load` — layers must exist to slot beneath.
export function attachWeather(map: maplibregl.Map): () => void {
  ensureProtocol();
  let stopped = false;
  let currentPath: string | null = null;

  const sync = async () => {
    try {
      const res = await fetch(INDEX_URL);
      if (!res.ok) return;
      const idx = (await res.json()) as WeatherIndex;
      const frames = idx.radar?.past ?? [];
      const host = idx.host;
      // Only ever hand MapLibre an https rainviewer host — this URL comes from
      // a third-party response, so pin the shape rather than trusting it.
      if (stopped || !frames.length || typeof host !== 'string' || !/^https:\/\/[a-z0-9.-]+\.rainviewer\.com$/.test(host)) return;
      const path = frames[frames.length - 1].path;
      if (path === currentPath) return;
      currentPath = path;
      const tiles = [`${PROTOCOL}://${host.slice('https://'.length)}${path}/256/{z}/{x}/{y}/2/1_1.png`];
      const src = map.getSource(SOURCE_ID) as maplibregl.RasterTileSource | undefined;
      if (src) {
        src.setTiles(tiles);
        return;
      }
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles,
        tileSize: 256,
        maxzoom: 9, // radar is ~1km data; overzoom beyond this instead of re-fetching
        attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
      });
      // Slot beneath the base style's first label layer: weather shades the
      // geography but place names, airfields, trails and aircraft all stay on
      // top (board layers are appended after the base style's symbols).
      const layers = map.getStyle().layers ?? [];
      const before = (layers.find((l) => l.type === 'symbol') ?? layers.find((l) => l.id === 'eu-airports-large'))?.id;
      map.addLayer({ id: LAYER_ID, type: 'raster', source: SOURCE_ID, paint: { 'raster-opacity': 0.55 } }, before);
    } catch {
      // decorative — never let weather trouble reach the board
    }
  };

  void sync();
  const timer = setInterval(() => void sync(), REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
