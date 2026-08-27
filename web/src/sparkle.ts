import type { LiveAircraft } from './api';

// The Honor clause. Any aircraft whose name mentions her flies sparkly —
// glittering trail, glowing icon, shimmering strip. Applies to anyone whose
// nickname/description earns it, but we all know who it's for.
export function isSparkly(a: Pick<LiveAircraft, 'nickname' | 'registration' | 'callsign' | 'typeName' | 'description'>): boolean {
  return /honor/i.test(`${a.nickname} ${a.registration} ${a.callsign} ${a.typeName} ${a.description}`);
}
