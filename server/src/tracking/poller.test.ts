import { describe, expect, it } from 'vitest';
import { openTestDb } from '../db/index.js';
import { Poller } from './poller.js';
import { FlightDetector } from './flightDetector.js';
import { LiveBus } from '../live/liveBus.js';
import { Settings } from '../settings.js';
import type { AdsbProvider, ProviderStates } from '../providers/index.js';
import type { NormPosition } from '../types.js';

const EMPTY: ProviderStates = { positions: [], presences: [] };

function world() {
  const db = openTestDb();
  const now = Date.now();
  const clubA = Number(
    db.prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES ('alpha','A','t1',?)").run(now)
      .lastInsertRowid
  );
  const clubB = Number(
    db.prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES ('bravo','B','t2',?)").run(now)
      .lastInsertRowid
  );
  const mkAc = (club: number, hex: string) =>
    Number(
      db
        .prepare(
          "INSERT INTO aircraft (club_id, hex, registration, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(club, hex, `G-${hex.toUpperCase()}`, now, now).lastInsertRowid
    );
  return { db, now, clubA, clubB, mkAc, settings: new Settings(db), live: new LiveBus(), detector: new FlightDetector(db) };
}

function pos(hex: string, ts: number): NormPosition {
  return {
    hex, ts, lat: 51.35, lon: 0.5, altBaro: 2000, altGeom: null, onGround: false, gs: 100, track: 90,
    baroRate: null, geomRate: null, ias: null, tas: null, mach: null, squawk: null, callsign: null,
    nic: null, nacP: null, sil: null, rssi: null, messages: null, seenPos: 1, wd: null, ws: null,
    navQnh: null, source: 'test', raw: {},
  };
}

describe('Poller', () => {
  it('syncs clubs whose roster just emptied, so removal deltas still go out', async () => {
    const w = world();
    const acId = w.mkAc(w.clubA, 'aaaaaa');
    const provider: AdsbProvider = { name: 'p', fetchStates: async () => EMPTY };
    const poller = new Poller(w.db, [provider], w.settings, w.detector, w.live);
    await poller.runCycle();
    expect(w.live.list(w.clubA, 'member')).toHaveLength(1);

    // Soft-delete the club's only aircraft: the channel must empty.
    w.db.prepare('UPDATE aircraft SET deleted_at = ? WHERE id = ?').run(Date.now(), acId);
    await poller.runCycle();
    expect(w.live.list(w.clubA, 'member')).toHaveLength(0);
  });

  it('queries the failover for hexes the primary did not freshly hear — stale records included', async () => {
    const w = world();
    w.mkAc(w.clubA, 'aaaaaa');
    w.mkAc(w.clubA, 'bbbbbb');
    const askedFailover: string[][] = [];
    const primary: AdsbProvider = {
      name: 'primary',
      // Hears aaaaaa freshly; returns only a rotting presence for bbbbbb.
      fetchStates: async () => ({
        positions: [pos('aaaaaa', Date.now())],
        presences: [{ hex: 'bbbbbb', ts: Date.now() - 300_000, seen: 300, callsign: null, squawk: null, onGround: null, source: 'primary' }],
      }),
    };
    const failover: AdsbProvider = {
      name: 'failover',
      fetchStates: async (hexes) => {
        askedFailover.push(hexes);
        return { positions: [pos('bbbbbb', Date.now())], presences: [] };
      },
    };
    const poller = new Poller(w.db, [primary, failover], w.settings, w.detector, w.live);
    await poller.runCycle();
    expect(askedFailover).toHaveLength(1);
    expect(askedFailover[0]).toEqual(['bbbbbb']); // stale-heard hex still goes to failover
    const list = w.live.list(w.clubA, 'member');
    expect(list.find((a) => a.hex === 'bbbbbb')?.pos).toBeTruthy(); // failover data applied
  });

  it('a primary outage rescued by the failover keeps the board alive without backoff', async () => {
    const w = world();
    w.mkAc(w.clubA, 'aaaaaa');
    const primary: AdsbProvider = {
      name: 'primary',
      fetchStates: async () => {
        throw new Error('primary down');
      },
    };
    const failover: AdsbProvider = {
      name: 'failover',
      fetchStates: async () => ({ positions: [pos('aaaaaa', Date.now())], presences: [] }),
    };
    const poller = new Poller(w.db, [primary, failover], w.settings, w.detector, w.live);
    await poller.runCycle();
    expect(poller.lastPollOk).toBe(true);
    expect(w.live.list(w.clubA, 'member')[0].pos).toBeTruthy();
    // Honest logging: no fabricated primary success row.
    const logs = w.db.prepare('SELECT provider, ok FROM poll_log ORDER BY id').all() as { provider: string; ok: number }[];
    expect(logs.some((l) => l.provider === 'primary' && l.ok === 1)).toBe(false);
    expect(logs.some((l) => l.provider === 'primary' && l.ok === 0)).toBe(true);
  });

  it('presences never advance the position dedupe watermark or store rows', async () => {
    const w = world();
    const acId = w.mkAc(w.clubA, 'aaaaaa');
    const primary: AdsbProvider = {
      name: 'primary',
      fetchStates: async () => ({
        positions: [],
        presences: [{ hex: 'aaaaaa', ts: Date.now(), seen: 2, callsign: null, squawk: null, onGround: true, source: 'p' }],
      }),
    };
    const poller = new Poller(w.db, [primary], w.settings, w.detector, w.live);
    await poller.runCycle();
    const stored = (w.db.prepare('SELECT COUNT(*) c FROM positions WHERE aircraft_id = ?').get(acId) as { c: number }).c;
    expect(stored).toBe(0);
    const a = w.live.list(w.clubA, 'member')[0];
    expect(a.awakeTs).not.toBeNull();
    expect(a.pos).toBeNull();
    w.live.refreshStatuses();
    expect(w.live.list(w.clubA, 'member')[0].status).toBe('awake');
  });
});
