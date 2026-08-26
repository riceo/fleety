import { config } from '../config.js';
import type { NormPosition } from '../types.js';
import { AdsbProvider, ProviderHttpError } from './index.js';

// readsb-style aircraft record as served by api.adsb.lol /v2 endpoints.
interface LolAircraft {
  hex?: string;
  flight?: string;
  alt_baro?: number | 'ground';
  alt_geom?: number;
  gs?: number;
  ias?: number;
  tas?: number;
  mach?: number;
  track?: number;
  baro_rate?: number;
  geom_rate?: number;
  squawk?: string;
  lat?: number;
  lon?: number;
  nic?: number;
  nac_p?: number;
  sil?: number;
  rssi?: number;
  messages?: number;
  seen_pos?: number;
  seen?: number;
  wd?: number;
  ws?: number;
  nav_qnh?: number;
}

export function normalizeReadsb(ac: LolAircraft, pollTime: number, source: string): NormPosition | null {
  if (!ac.hex || typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
  const seenPos = typeof ac.seen_pos === 'number' ? ac.seen_pos : typeof ac.seen === 'number' ? ac.seen : 0;
  const onGround = ac.alt_baro === 'ground';
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    hex: ac.hex.toLowerCase(),
    // The provider reports how stale the fix is; store the true position time.
    ts: Math.round(pollTime - seenPos * 1000),
    lat: ac.lat,
    lon: ac.lon,
    altBaro: onGround ? null : num(ac.alt_baro),
    altGeom: num(ac.alt_geom),
    onGround,
    gs: num(ac.gs),
    track: num(ac.track),
    baroRate: num(ac.baro_rate),
    geomRate: num(ac.geom_rate),
    ias: num(ac.ias),
    tas: num(ac.tas),
    mach: num(ac.mach),
    squawk: ac.squawk ?? null,
    callsign: ac.flight?.trim() || null,
    nic: num(ac.nic),
    nacP: num(ac.nac_p),
    sil: num(ac.sil),
    rssi: num(ac.rssi),
    messages: num(ac.messages),
    seenPos,
    wd: num(ac.wd),
    ws: num(ac.ws),
    navQnh: num(ac.nav_qnh),
    source,
    raw: ac,
  };
}

export class AdsbLolProvider implements AdsbProvider {
  readonly name = 'adsb.lol';
  private base = 'https://api.adsb.lol';

  async fetchPositions(hexes: string[]): Promise<NormPosition[]> {
    if (hexes.length === 0) return [];
    const url = `${this.base}/v2/hex/${hexes.join(',')}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `adsb.lol responded ${res.status}`);
    const body = (await res.json()) as { ac?: LolAircraft[]; now?: number };
    const pollTime = Date.now();
    const out: NormPosition[] = [];
    for (const ac of body.ac ?? []) {
      const p = normalizeReadsb(ac, pollTime, this.name);
      if (p) out.push(p);
    }
    return out;
  }
}
