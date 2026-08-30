import { config } from '../config.js';
import type { OtherAircraft } from '../types.js';
import { AdsbProvider, ProviderHttpError, type ProviderStates } from './index.js';
import { normalizeOther, normalizePresence, normalizeReadsb, type ReadsbAircraft } from './readsb.js';

export class AdsbLolProvider implements AdsbProvider {
  readonly name = 'adsb.lol';
  private base = 'https://api.adsb.lol';

  async fetchStates(hexes: string[]): Promise<ProviderStates> {
    if (hexes.length === 0) return { positions: [], presences: [] };
    const url = `${this.base}/v2/hex/${hexes.join(',')}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `adsb.lol responded ${res.status}`);
    const body = (await res.json()) as { ac?: ReadsbAircraft[] };
    const pollTime = Date.now();
    const out: ProviderStates = { positions: [], presences: [] };
    for (const ac of body.ac ?? []) {
      const pos = normalizeReadsb(ac, pollTime, this.name);
      if (pos) out.positions.push(pos);
      const pres = normalizePresence(ac, pollTime, this.name);
      if (pres) out.presences.push(pres);
    }
    return out;
  }

  // Everything within radiusNm of a point (ambient other-traffic layer).
  // Tighter timeout than fetchStates: this augments the board rather than
  // feeding it, so a slow answer is worth less than a prompt next cycle.
  async fetchArea(lat: number, lon: number, radiusNm: number): Promise<OtherAircraft[]> {
    const url = `${this.base}/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/${Math.round(radiusNm)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `adsb.lol responded ${res.status}`);
    const body = (await res.json()) as { ac?: ReadsbAircraft[]; aircraft?: ReadsbAircraft[] };
    const pollTime = Date.now();
    return (body.ac ?? body.aircraft ?? [])
      .map((ac) => normalizeOther(ac, pollTime))
      .filter((t): t is OtherAircraft => t !== null);
  }
}
