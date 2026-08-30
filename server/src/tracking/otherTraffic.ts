import type { OtherTrafficPrefs } from '../clubs.js';
import type { OtherAircraft } from '../types.js';
import { haversineNm } from './geo.js';

// One busy TMA must not bloat every SSE payload — cap the list, keeping the
// nearest aircraft (the ones a clubhouse board actually cares about).
export const OTHER_TRAFFIC_CAP = 80;

// Policy filter for the ambient layer: drop the club's own airframes (they're
// already on the board with full treatment), drop anything above the club's
// ceiling or with no usable altitude, then cap nearest-first.
export function filterOtherTraffic(
  list: OtherAircraft[],
  ownHexes: Set<string>,
  prefs: Pick<OtherTrafficPrefs, 'maxAltFt'>,
  centerLat: number,
  centerLon: number
): OtherAircraft[] {
  return list
    .filter((t) => !ownHexes.has(t.hex) && t.alt !== null && t.alt <= prefs.maxAltFt)
    .map((t) => ({ t, d: haversineNm(centerLat, centerLon, t.lat, t.lon) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, OTHER_TRAFFIC_CAP)
    .map((x) => x.t);
}
