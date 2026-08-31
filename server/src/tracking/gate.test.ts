import { describe, expect, it } from 'vitest';
import { GATE_DEFAULTS, PlausibilityGate } from './gate.js';
import type { NormPosition } from '../types.js';

// Kent-ish geometry: 0.1° of latitude ≈ 6 nm.
const BASE = { lat: 51.35, lon: 0.5 };

function fix(ts: number, lat: number, lon: number, over: Partial<NormPosition> = {}): NormPosition {
  return {
    hex: 'aaaaaa', ts, lat, lon, altBaro: 2000, altGeom: null, onGround: false, gs: 100, track: 90,
    baroRate: null, geomRate: null, ias: null, tas: null, mach: null, squawk: null, callsign: null,
    nic: 8, nacP: 9, sil: 3, rssi: null, messages: null, seenPos: 1, posType: 'adsb_icao',
    wd: null, ws: null, navQnh: null, source: 'test', raw: {}, ...over,
  };
}

const mlat = (ts: number, lat: number, lon: number, over: Partial<NormPosition> = {}) =>
  fix(ts, lat, lon, { posType: 'mlat', nic: 0, ...over });

// Feed a fix through the evaluate+commit cycle the way the poller does.
function feed(g: PlausibilityGate, p: NormPosition) {
  const v = g.evaluate(1, p);
  if (v === 'accept' || v === 'promote') g.commitAccept(1, p, v === 'promote');
  if (v === 'suspect') g.commitSuspect(1, p);
  return v;
}

describe('PlausibilityGate', () => {
  it('accepts first contact and plausible continuations', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    expect(feed(g, fix(t, BASE.lat, BASE.lon))).toBe('accept');
    // 100 kt east for 30 s ≈ 0.83 nm ≈ 0.022° of longitude at 51°N.
    expect(feed(g, fix(t + 30_000, BASE.lat, BASE.lon + 0.022))).toBe('accept');
  });

  it('sub-slack solve jitter never gates, even at silly implied speeds', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    feed(g, mlat(t, BASE.lat, BASE.lon));
    // 0.3 nm in half a second ⇒ ~2000 kt implied, but under the 0.5 nm slack.
    expect(feed(g, mlat(t + 500, BASE.lat + 0.005, BASE.lon))).toBe('accept');
  });

  it('rejects a dense-stream teleport from any source type', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    feed(g, fix(t, BASE.lat, BASE.lon));
    // 12 nm in 5 s ⇒ ~8600 kt: garbage no matter who reported it.
    expect(feed(g, fix(t + 5_000, BASE.lat + 0.2, BASE.lon))).toBe('suspect');
    expect(g.stats().suspected).toBe(1);
  });

  it('holds MLAT to the stricter cap where ADS-B gets the benefit of the doubt', () => {
    const t = 1_000_000_000_000;
    // 40 nm in 8 min ⇒ ~300 kt implied: over the MLAT cap, under the hard cap.
    const far = { lat: BASE.lat + 0.667, lon: BASE.lon };
    const adsb = new PlausibilityGate();
    feed(adsb, fix(t, BASE.lat, BASE.lon));
    expect(feed(adsb, fix(t + 480_000, far.lat, far.lon))).toBe('accept');
    const ml = new PlausibilityGate();
    feed(ml, mlat(t, BASE.lat, BASE.lon));
    expect(feed(ml, mlat(t + 480_000, far.lat, far.lon))).toBe('suspect');
  });

  it('applies the MLAT cap to untyped fixes with nic 0, not to untyped fixes with integrity', () => {
    const t = 1_000_000_000_000;
    const far = { lat: BASE.lat + 0.667, lon: BASE.lon }; // ~300 kt implied over 8 min
    const noType = new PlausibilityGate();
    feed(noType, fix(t, BASE.lat, BASE.lon));
    expect(feed(noType, fix(t + 480_000, far.lat, far.lon, { posType: null, nic: 0 }))).toBe('suspect');
    const withNic = new PlausibilityGate();
    feed(withNic, fix(t, BASE.lat, BASE.lon));
    expect(feed(withNic, fix(t + 480_000, far.lat, far.lon, { posType: null, nic: 8 }))).toBe('accept');
  });

  it('promotes a quarantined jump once a second consistent solve confirms it', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    feed(g, mlat(t, BASE.lat, BASE.lon));
    const b = { lat: BASE.lat + 0.5, lon: BASE.lon }; // 30 nm away
    expect(feed(g, mlat(t + 5_000, b.lat, b.lon))).toBe('suspect');
    expect(feed(g, mlat(t + 10_000, b.lat + 0.002, b.lon))).toBe('promote');
    expect(g.stats().promoted).toBe(1);
    // The track continues from B as normal now.
    expect(feed(g, mlat(t + 15_000, b.lat + 0.004, b.lon))).toBe('accept');
  });

  it('never promotes ping-ponging network solves while real fixes keep flowing', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    const b = { lat: BASE.lat + 0.5, lon: BASE.lon };
    feed(g, mlat(t, BASE.lat, BASE.lon));
    for (let i = 1; i <= 4; i++) {
      // Wild solve from the other network… then the real track continues,
      // which kills the candidate before a second wild solve can confirm it.
      expect(feed(g, mlat(t + i * 10_000 - 5_000, b.lat, b.lon))).toBe('suspect');
      expect(feed(g, mlat(t + i * 10_000, BASE.lat, BASE.lon + i * 0.007))).toBe('accept');
    }
    expect(g.stats().promoted).toBe(0);
    expect(g.stats().suspected).toBe(4);
  });

  it('a re-reported stale solve is an echo, not a confirmation of itself', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    feed(g, mlat(t, BASE.lat, BASE.lon));
    const b = { lat: BASE.lat + 0.5, lon: BASE.lon };
    expect(feed(g, mlat(t + 5_000, b.lat, b.lon))).toBe('suspect');
    // Aggregators repeat the same solve with ts wobbling by network jitter.
    expect(g.evaluate(1, mlat(t + 5_300, b.lat, b.lon))).toBe('echo');
    expect(g.evaluate(1, mlat(t + 4_800, b.lat, b.lon))).toBe('echo');
    // A genuinely new solve (a full cycle later) is real evidence.
    expect(g.evaluate(1, mlat(t + 11_000, b.lat, b.lon))).toBe('promote');
  });

  it('an expired candidate cannot promote; the fresh pair after it can', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    feed(g, mlat(t, BASE.lat, BASE.lon));
    const far = { lat: BASE.lat + 3.5, lon: BASE.lon }; // ~210 nm: implausible even after 11 min
    expect(feed(g, mlat(t + 5_000, far.lat, far.lon))).toBe('suspect');
    const late = t + 5_000 + GATE_DEFAULTS.candidateTtlMs + 60_000;
    expect(feed(g, mlat(late, far.lat, far.lon))).toBe('suspect'); // stale candidate: no promote
    expect(feed(g, mlat(late + 5_000, far.lat + 0.002, far.lon))).toBe('promote');
  });

  it('prime() makes the stored last-accepted fix the baseline after a restart', () => {
    const g = new PlausibilityGate();
    const t = 1_000_000_000_000;
    g.prime(1, { ts: t, ...BASE });
    expect(feed(g, mlat(t + 5_000, BASE.lat + 0.5, BASE.lon))).toBe('suspect');
    expect(feed(g, mlat(t + 10_000, BASE.lat + 0.003, BASE.lon))).toBe('accept');
  });
});
