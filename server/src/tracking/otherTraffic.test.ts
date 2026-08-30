import { describe, expect, it } from 'vitest';
import { openTestDb } from '../db/index.js';
import { Settings } from '../settings.js';
import { LiveBus } from '../live/liveBus.js';
import { FlightDetector } from './flightDetector.js';
import { Poller } from './poller.js';
import { filterOtherTraffic, OTHER_TRAFFIC_CAP } from './otherTraffic.js';
import { normalizeOther } from '../providers/readsb.js';
import { otherTrafficPrefs, OTHER_TRAFFIC_DEFAULTS } from '../clubs.js';
import type { OtherAircraft } from '../types.js';

function other(hex: string, over: Partial<OtherAircraft> = {}): OtherAircraft {
  return {
    hex,
    ts: Date.now(),
    lat: 51.35,
    lon: 0.5,
    alt: 2000,
    gs: 120,
    track: 90,
    callsign: 'TST123',
    reg: 'G-TEST',
    type: 'C172',
    ...over,
  };
}

describe('filterOtherTraffic', () => {
  const prefs = { maxAltFt: 10_000 };

  it('drops own-fleet hexes, null altitudes, and traffic above the ceiling', () => {
    const list = [
      other('aaaaaa'),
      other('bbbbbb', { alt: null }),
      other('cccccc', { alt: 12_000 }),
      other('dddddd', { alt: 10_000 }), // at the ceiling: kept
      other('eeeeee'),
    ];
    const out = filterOtherTraffic(list, new Set(['eeeeee']), prefs, 51.35, 0.5);
    expect(out.map((t) => t.hex).sort()).toEqual(['aaaaaa', 'dddddd']);
  });

  it('caps nearest-first so one busy TMA cannot bloat the payload', () => {
    // 100 aircraft marching away from the centre, shuffled in by reverse order.
    const list = Array.from({ length: 100 }, (_, i) => other(`hex${i}`, { lat: 51.35 + (99 - i) * 0.01 }));
    const out = filterOtherTraffic(list, new Set(), prefs, 51.35, 0.5);
    expect(out).toHaveLength(OTHER_TRAFFIC_CAP);
    expect(out[0].hex).toBe('hex99'); // exactly on the centre
    // The furthest 20 fell off.
    const kept = new Set(out.map((t) => t.hex));
    for (let i = 0; i < 20; i++) expect(kept.has(`hex${i}`)).toBe(false);
  });
});

describe('normalizeOther', () => {
  it('maps a readsb area record, back-dating by seen_pos', () => {
    const before = Date.now();
    const out = normalizeOther(
      { hex: 'ABC123', flight: 'EZY45 ', r: 'G-EZBA ', t: 'A319', lat: 51.1, lon: 0.9, alt_baro: 3500, gs: 210, track: 45, seen_pos: 10 },
      before
    );
    expect(out).not.toBeNull();
    expect(out!.hex).toBe('abc123');
    expect(out!.callsign).toBe('EZY45');
    expect(out!.reg).toBe('G-EZBA');
    expect(out!.type).toBe('A319');
    expect(out!.alt).toBe(3500);
    expect(out!.ts).toBe(before - 10_000);
  });

  it('falls back to geometric altitude and rejects ground/position-less records', () => {
    expect(normalizeOther({ hex: 'a1', lat: 51, lon: 0, alt_geom: 1400 }, 0)!.alt).toBe(1400);
    expect(normalizeOther({ hex: 'a2', lat: 51, lon: 0, alt_baro: 'ground' }, 0)).toBeNull();
    expect(normalizeOther({ hex: 'a3' }, 0)).toBeNull();
  });
});

describe('otherTrafficPrefs', () => {
  it('degrades to defaults on empty or corrupt JSON', () => {
    expect(otherTrafficPrefs({ other_traffic: '{}' })).toEqual(OTHER_TRAFFIC_DEFAULTS);
    expect(otherTrafficPrefs({ other_traffic: 'not json' })).toEqual(OTHER_TRAFFIC_DEFAULTS);
  });

  it('clamps numbers and rejects a non-hex colour', () => {
    const p = otherTrafficPrefs({
      other_traffic: JSON.stringify({ enabled: true, maxAltFt: 999_999, radiusNm: 1, color: 'javascript:alert(1)' }),
    });
    expect(p).toEqual({ enabled: true, maxAltFt: 60_000, radiusNm: 5, color: OTHER_TRAFFIC_DEFAULTS.color });
  });
});

describe('poller other-traffic pass', () => {
  function world() {
    const db = openTestDb();
    const now = Date.now();
    const clubId = Number(
      db
        .prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES ('alpha', 'ALPHA', 'k-000', ?)")
        .run(now).lastInsertRowid
    );
    // One fleet aircraft whose hex must never come back as "other traffic".
    db.prepare(
      "INSERT INTO aircraft (club_id, hex, registration, created_at, updated_at) VALUES (?, '400f01', 'G-OWN', ?, ?)"
    ).run(clubId, now, now);
    return { db, clubId, now };
  }

  it('publishes the filtered area result to connected clients, and clears when disabled', async () => {
    const { db, clubId } = world();
    db.prepare("UPDATE clubs SET other_traffic = ? WHERE id = ?").run(
      JSON.stringify({ enabled: true, maxAltFt: 5000, radiusNm: 30, color: '#7d8db5' }),
      clubId
    );
    const live = new LiveBus();
    const writes: string[] = [];
    live.addClient(clubId, { write: (s: string) => writes.push(s), end: () => {} } as never, 'restricted', true);

    let areaCalls = 0;
    const provider = {
      name: 'test',
      fetchStates: async () => ({ positions: [], presences: [] }),
      fetchArea: async () => {
        areaCalls++;
        return [
          other('badf00', { alt: 3000 }),
          other('400f01', { alt: 3000 }), // own fleet: filtered
          other('deadbf', { alt: 9000 }), // above the 5000ft ceiling: filtered
        ];
      },
    };
    const poller = new Poller(db, [provider], new Settings(db), new FlightDetector(db), live);
    await poller.runCycle();

    expect(areaCalls).toBe(1);
    const traffic = writes.filter((w) => w.startsWith('event: traffic'));
    // One empty list on connect, then the published pass.
    const last = JSON.parse(traffic[traffic.length - 1].match(/data: (.*)\n\n/s)![1]) as {
      aircraft: OtherAircraft[];
    };
    expect(last.aircraft.map((t) => t.hex)).toEqual(['badf00']);

    // Flip the club off: the next cycle pushes an authoritative empty list.
    db.prepare("UPDATE clubs SET other_traffic = '{}' WHERE id = ?").run(clubId);
    await poller.runCycle();
    expect(areaCalls).toBe(1); // no further upstream spend
    const final = JSON.parse(
      writes.filter((w) => w.startsWith('event: traffic')).pop()!.match(/data: (.*)\n\n/s)![1]
    ) as { aircraft: OtherAircraft[] };
    expect(final.aircraft).toEqual([]);
  });

  it('never queries upstream when nobody is connected', async () => {
    const { db, clubId } = world();
    db.prepare("UPDATE clubs SET other_traffic = ? WHERE id = ?").run(JSON.stringify({ enabled: true }), clubId);
    let areaCalls = 0;
    const provider = {
      name: 'test',
      fetchStates: async () => ({ positions: [], presences: [] }),
      fetchArea: async () => {
        areaCalls++;
        return [];
      },
    };
    const poller = new Poller(db, [provider], new Settings(db), new FlightDetector(db), new LiveBus());
    await poller.runCycle();
    expect(areaCalls).toBe(0);
  });

  it('a throwing area provider neither breaks the cycle nor marks the fleet poll unhealthy', async () => {
    const { db, clubId } = world();
    db.prepare("UPDATE clubs SET other_traffic = ? WHERE id = ?").run(JSON.stringify({ enabled: true }), clubId);
    const live = new LiveBus();
    live.addClient(clubId, { write: () => {}, end: () => {} } as never, 'restricted', true);
    const provider = {
      name: 'test',
      fetchStates: async () => ({ positions: [], presences: [] }),
      fetchArea: async () => {
        throw new Error('area boom');
      },
    };
    const poller = new Poller(db, [provider], new Settings(db), new FlightDetector(db), live);
    await poller.runCycle();
    expect(poller.lastPollOk).toBe(true);
    expect(poller.lastPollError).toBeNull();
  });
});
