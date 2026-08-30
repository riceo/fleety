import type { NormPosition, NormPresence, OtherAircraft } from '../types.js';

// readsb-style aircraft record as served by the adsb.lol / adsb.fi family of
// aggregator APIs (and a local tar1090). Both providers share this shape.
export interface ReadsbAircraft {
  hex?: string;
  flight?: string;
  r?: string; // registration, as enriched by the aggregator
  t?: string; // ICAO type code (C172, PA28…)
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

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normalizeReadsb(ac: ReadsbAircraft, pollTime: number, source: string): NormPosition | null {
  if (!ac.hex || typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
  const seenPos = typeof ac.seen_pos === 'number' ? ac.seen_pos : typeof ac.seen === 'number' ? ac.seen : 0;
  const onGround = ac.alt_baro === 'ground';
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

// Every record with a recent `seen` is a transponder sighting — including the
// position-less "awake on the ground" case FR24 shows before taxi. Sightings
// older than 10 minutes can never yield an 'awake' status, so skip them.
export function normalizePresence(ac: ReadsbAircraft, pollTime: number, source: string): NormPresence | null {
  if (!ac.hex || typeof ac.seen !== 'number' || !Number.isFinite(ac.seen) || ac.seen > 600) return null;
  return {
    hex: ac.hex.toLowerCase(),
    ts: Math.round(pollTime - ac.seen * 1000),
    seen: ac.seen,
    callsign: ac.flight?.trim() || null,
    squawk: ac.squawk ?? null,
    onGround: ac.alt_baro === 'ground' ? true : null,
    source,
  };
}

// Area-query record -> the ambient other-traffic shape. Surface targets and
// position-less records return null — "other traffic" means aircraft moving
// through the club's sky, not metal parked on an apron.
export function normalizeOther(ac: ReadsbAircraft, pollTime: number): OtherAircraft | null {
  if (!ac.hex || typeof ac.lat !== 'number' || typeof ac.lon !== 'number') return null;
  if (ac.alt_baro === 'ground') return null;
  const seenPos = typeof ac.seen_pos === 'number' ? ac.seen_pos : typeof ac.seen === 'number' ? ac.seen : 0;
  return {
    hex: ac.hex.toLowerCase(),
    ts: Math.round(pollTime - seenPos * 1000),
    lat: ac.lat,
    lon: ac.lon,
    alt: num(ac.alt_baro) ?? num(ac.alt_geom),
    gs: num(ac.gs),
    track: num(ac.track),
    callsign: ac.flight?.trim() || null,
    reg: ac.r?.trim() || null,
    type: ac.t?.trim() || null,
  };
}
