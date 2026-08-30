import { config } from '../config.js';
import type { OtherAircraft } from '../types.js';
import { AdsbProvider, ProviderHttpError, type ProviderStates } from './index.js';
import { normalizeOther, normalizePresence, normalizeReadsb, type ReadsbAircraft } from './readsb.js';

// Failover aggregator — same readsb response shape, different feeder network,
// so it sometimes hears aircraft adsb.lol can't. Polite budget: the poller
// sends it at most one batched call per cycle, only for hexes the primary
// returned nothing for.
export class AdsbFiProvider implements AdsbProvider {
  readonly name = 'adsb.fi';
  private base = 'https://opendata.adsb.fi/api';

  async fetchStates(hexes: string[]): Promise<ProviderStates> {
    if (hexes.length === 0) return { positions: [], presences: [] };
    const url = `${this.base}/v2/hex/${hexes.join(',')}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `adsb.fi responded ${res.status}`);
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

  // Area failover for the ambient other-traffic layer (same shape as adsb.lol,
  // different URL scheme).
  async fetchArea(lat: number, lon: number, radiusNm: number): Promise<OtherAircraft[]> {
    const url = `${this.base}/v2/lat/${lat.toFixed(4)}/lon/${lon.toFixed(4)}/dist/${Math.round(radiusNm)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new ProviderHttpError(res.status, `adsb.fi responded ${res.status}`);
    // adsb.fi's area endpoint keys the list "aircraft" (its hex endpoint says
    // "ac") — accept both.
    const body = (await res.json()) as { ac?: ReadsbAircraft[]; aircraft?: ReadsbAircraft[] };
    const pollTime = Date.now();
    return (body.aircraft ?? body.ac ?? [])
      .map((ac) => normalizeOther(ac, pollTime))
      .filter((t): t is OtherAircraft => t !== null);
  }
}
