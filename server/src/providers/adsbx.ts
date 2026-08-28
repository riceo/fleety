import { config } from '../config.js';
import { AdsbProvider, ProviderHttpError, type ProviderStates } from './index.js';
import { normalizePresence, normalizeReadsb, type ReadsbAircraft } from './readsb.js';

// ADSBexchange via RapidAPI — the paid rescue tier. Their v2 endpoint takes
// ONE hex per request (no batching), so every hex passed here costs one
// request against the 10k/month plan. The poller's budget guard is the only
// thing standing between this file and an invoice; it must stay upstream.
export class AdsbxProvider implements AdsbProvider {
  readonly name = 'adsbexchange';
  private host = 'adsbexchange-com1.p.rapidapi.com';

  async fetchStates(hexes: string[]): Promise<ProviderStates> {
    const out: ProviderStates = { positions: [], presences: [] };
    let lastError: unknown = null;
    for (const hex of hexes) {
      // Each hex is a separately-metered (paid) request, so a failure on one
      // must not discard data already fetched for earlier hexes in the batch.
      try {
        const res = await fetch(`https://${this.host}/v2/icao/${hex}/`, {
          headers: {
            'x-rapidapi-key': config.adsbxApiKey,
            'x-rapidapi-host': this.host,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) throw new ProviderHttpError(res.status, `adsbexchange responded ${res.status}`);
        const body = (await res.json()) as { ac?: ReadsbAircraft[] | null };
        const pollTime = Date.now();
        for (const ac of body.ac ?? []) {
          const pos = normalizeReadsb(ac, pollTime, this.name);
          if (pos) out.positions.push(pos);
          const pres = normalizePresence(ac, pollTime, this.name);
          if (pres) out.presences.push(pres);
        }
      } catch (err) {
        lastError = err;
      }
    }
    // Total failure throws (poller engages cooldown + honest logging). A
    // partial failure keeps the salvaged, already-paid fixes but flags itself
    // so the poller still backs off (e.g. a 429 on one hex of the batch).
    if (lastError && out.positions.length === 0 && out.presences.length === 0) throw lastError;
    if (lastError) out.partial = true;
    return out;
  }
}
