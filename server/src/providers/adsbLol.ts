import { config } from '../config.js';
import { AdsbProvider, ProviderHttpError, type ProviderStates } from './index.js';
import { normalizePresence, normalizeReadsb, type ReadsbAircraft } from './readsb.js';

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
}
