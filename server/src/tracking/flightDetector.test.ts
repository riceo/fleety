import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { FlightDetector } from './flightDetector.js';
import type { NormPosition } from '../types.js';
import { haversineNm } from './geo.js';

const EGTO = { code: 'EGTO', lat: 51.3519, lon: 0.5033, elev: 436 };
const EGMD = { code: 'EGMD', lat: 50.9561, lon: 0.9392, elev: 13 };

const T0 = 1_756_200_000_000;

function mkPos(overrides: Partial<NormPosition>): NormPosition {
  return {
    hex: '40789f',
    ts: T0,
    lat: EGTO.lat,
    lon: EGTO.lon,
    altBaro: null,
    altGeom: null,
    onGround: false,
    gs: 0,
    track: 90,
    baroRate: null,
    geomRate: null,
    ias: null,
    tas: null,
    mach: null,
    squawk: '7000',
    callsign: 'INV01',
    nic: 8,
    nacP: 9,
    sil: 3,
    rssi: -12,
    messages: 100,
    seenPos: 0,
    wd: null,
    ws: null,
    navQnh: null,
    source: 'test',
    raw: {},
    ...overrides,
  };
}

describe('FlightDetector', () => {
  let db: Database;
  let detector: FlightDetector;
  let aircraftId: number;

  beforeEach(() => {
    db = openTestDb();
    const now = Date.now();
    aircraftId = Number(
      db
        .prepare(
          "INSERT INTO aircraft (hex, registration, callsign, created_at, updated_at) VALUES ('40789f','G-PSZB','INV01', ?, ?)"
        )
        .run(now, now).lastInsertRowid
    );
    db.prepare('INSERT INTO airfields (code, name, lat, lon, elevation_ft, radius_nm) VALUES (?,?,?,?,?,3)').run(
      EGTO.code,
      'Rochester',
      EGTO.lat,
      EGTO.lon,
      EGTO.elev
    );
    db.prepare('INSERT INTO airfields (code, name, lat, lon, elevation_ft, radius_nm) VALUES (?,?,?,?,?,3)').run(
      EGMD.code,
      'Lydd',
      EGMD.lat,
      EGMD.lon,
      EGMD.elev
    );
    detector = new FlightDetector(db);
  });

  const flights = () => db.prepare('SELECT * FROM flights ORDER BY id').all() as Record<string, unknown>[];

  it('detects a complete flight EGTO -> EGMD with confirmed landing', () => {
    let ts = T0;
    // taxi at Rochester
    detector.onPosition(aircraftId, mkPos({ ts, gs: 8 }));
    // takeoff roll / climb out
    ts += 30_000;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 900, baroRate: 700 }));
    // cruise south, several fixes
    for (let i = 1; i <= 10; i++) {
      ts += 60_000;
      const f = i / 10;
      detector.onPosition(
        aircraftId,
        mkPos({
          ts,
          lat: EGTO.lat + (EGMD.lat - EGTO.lat) * f,
          lon: EGTO.lon + (EGMD.lon - EGTO.lon) * f,
          gs: 110,
          altBaro: 2500,
        })
      );
    }
    // rolling out at Lydd
    ts += 60_000;
    detector.onPosition(aircraftId, mkPos({ ts, lat: EGMD.lat, lon: EGMD.lon, gs: 20, altBaro: 50 }));

    const all = flights();
    expect(all).toHaveLength(1);
    const f = all[0];
    expect(f.end_confidence).toBe('confirmed');
    expect(f.route_origin).toBe('EGTO');
    expect(f.route_destination).toBe('EGMD');
    expect(f.callsign).toBe('INV01');
    expect(Number(f.distance_nm)).toBeGreaterThan(20);
    expect(f.ended_at).toBe(ts);
  });

  it('records a coverage gap without splitting the flight', () => {
    let ts = T0;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 1500 }));
    ts += 60_000;
    detector.onPosition(aircraftId, mkPos({ ts, lat: EGTO.lat - 0.05, gs: 110, altBaro: 2500 }));
    // 10 minute dropout, reappears ~15nm further on (plausible at 110kt)
    ts += 600_000;
    detector.onPosition(aircraftId, mkPos({ ts, lat: EGTO.lat - 0.3, gs: 110, altBaro: 2500 }));
    const all = flights();
    expect(all).toHaveLength(1);
    expect(all[0].gap_count).toBe(1);
    expect(all[0].ended_at).toBeNull();
  });

  it('closes a flight as lost after prolonged silence away from airfields', () => {
    let ts = T0;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 1500 }));
    ts += 60_000;
    // cruising mid-channel, far from any airfield
    detector.onPosition(aircraftId, mkPos({ ts, lat: 50.6, lon: 0.9, gs: 110, altBaro: 3000 }));
    detector.tick(ts + 6 * 60_000); // classify: not landing-like -> lost
    expect(flights()[0].ended_at).toBeNull();
    detector.tick(ts + 61 * 60_000); // give up
    const f = flights()[0];
    expect(f.end_confidence).toBe('lost');
    expect(f.ended_at).toBe(ts);
  });

  it('assumes a landing when signal is lost low and descending near an airfield', () => {
    let ts = T0;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 1500 }));
    ts += 60_000;
    // 1.5nm from Rochester, low, descending toward the field
    detector.onPosition(
      aircraftId,
      mkPos({ ts, lat: EGTO.lat + 0.025, lon: EGTO.lon, gs: 70, altBaro: 900, baroRate: -500, track: 180 })
    );
    detector.tick(ts + 6 * 60_000);
    const f = flights()[0];
    expect(f.end_confidence).toBe('assumed');
    expect(f.route_destination).toBe('EGTO');
  });

  it('reopens the same flight for a stop-and-go within the rejoin window', () => {
    let ts = T0;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 1200 }));
    ts += 120_000;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 20, altBaro: 500 })); // land at EGTO
    expect(flights()[0].end_confidence).toBe('confirmed');
    ts += 300_000; // 5 min on the ground
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 1200 }));
    const all = flights();
    expect(all).toHaveLength(1);
    expect(all[0].ended_at).toBeNull();
  });

  it('starts separate flights when the aircraft reappears implausibly far away', () => {
    let ts = T0;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 70, altBaro: 1500 }));
    ts += 60_000;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 110, altBaro: 2500, lat: EGTO.lat - 0.05 }));
    // 12 minutes later it is 200nm away — not a continuation at 110kt
    ts += 720_000;
    detector.onPosition(aircraftId, mkPos({ ts, lat: 54.5, lon: -1.5, gs: 110, altBaro: 2500 }));
    const all = flights();
    expect(all).toHaveLength(2);
    expect(all[0].end_confidence).toBe('lost');
    expect(all[1].ended_at).toBeNull();
  });

  it('ignores stale duplicate fixes', () => {
    const ts = T0;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 110, altBaro: 2500, lat: 50.6, lon: 0.9 }));
    const before = flights()[0].position_count;
    detector.onPosition(aircraftId, mkPos({ ts, gs: 110, altBaro: 2500, lat: 50.6, lon: 0.9 }));
    expect(flights()[0].position_count).toBe(before);
  });
});

describe('geo', () => {
  it('haversine EGTO->EGMD is about 29nm', () => {
    const d = haversineNm(EGTO.lat, EGTO.lon, EGMD.lat, EGMD.lon);
    expect(d).toBeGreaterThan(26);
    expect(d).toBeLessThan(31);
  });
});
