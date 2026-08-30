import { describe, expect, it } from 'vitest';
import { LiveBus } from './liveBus.js';
import type { AircraftRow, NormPosition } from '../types.js';

const now = Date.now();

function row(id: number, overrides: Partial<AircraftRow> = {}): AircraftRow {
  return {
    id,
    club_id: 1,
    hex: `40000${id}`,
    registration: `G-TST${id}`,
    callsign: `TST${id}`,
    type_name: 'Test',
    icao_type: '',
    nickname: '',
    tagline: '',
    description: '',
    operator: '',
    icon: 'low-wing',
    icon_path: null,
    photo_path: null,
    color: '#e32636',
    enabled: 1,
    category: 'fleet',
    visibility: 'public',
    track_until: null,
    sort_order: 0,
    notes: '',
    deleted_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function pos(ts: number): NormPosition {
  return {
    hex: '400001',
    ts,
    lat: 51.35,
    lon: 0.5,
    altBaro: 1200,
    altGeom: null,
    onGround: false,
    gs: 90,
    track: 180,
    baroRate: null,
    geomRate: null,
    ias: null,
    tas: null,
    mach: null,
    squawk: null,
    callsign: null,
    nic: null,
    nacP: null,
    sil: null,
    rssi: null,
    messages: null,
    seenPos: 0,
    wd: null,
    ws: null,
    navQnh: null,
    source: 't',
    raw: {},
  };
}

describe('LiveBus awake status', () => {
  it('presence without a position yields awake, decaying to offline', () => {
    const bus = new LiveBus();
    bus.syncAircraftList(1, [row(1)]);
    bus.presence(1, 1, now - 30_000);
    bus.refreshStatuses(now);
    expect(bus.list(1, 'member')[0].status).toBe('awake');
    // Presence decays after the 2-minute window.
    bus.refreshStatuses(now + 3 * 60_000);
    expect(bus.list(1, 'member')[0].status).toBe('offline');
  });

  it('a current fix outranks presence; a stale fix plus fresh presence is awake', () => {
    const bus = new LiveBus();
    bus.syncAircraftList(1, [row(1)]);
    bus.update(1, 1, pos(now - 60_000), null); // fresh fix, no flight
    bus.refreshStatuses(now);
    expect(bus.list(1, 'member')[0].status).toBe('ground');
    // 10 minutes later the fix is stale but the transponder pings again.
    bus.presence(1, 1, now + 9 * 60_000);
    bus.refreshStatuses(now + 10 * 60_000);
    expect(bus.list(1, 'member')[0].status).toBe('awake');
  });

  it('an open flight stays airborne through a coverage gap until the detector closes it', () => {
    const bus = new LiveBus();
    bus.syncAircraftList(1, [row(1)]);
    bus.update(1, 1, pos(now - 20 * 60_000), 77); // fix 20 min old, flight open
    bus.refreshStatuses(now);
    expect(bus.list(1, 'member')[0].status).toBe('airborne'); // in flight, signal lost
    bus.flightEnded(1, 1, 77);
    bus.refreshStatuses(now);
    expect(bus.list(1, 'member')[0].status).toBe('ground'); // stale fix, flight over
    bus.refreshStatuses(now + 40 * 60_000);
    expect(bus.list(1, 'member')[0].status).toBe('offline');
  });

  it('presence is monotonic and members-only aircraft never reach restricted audiences', () => {
    const bus = new LiveBus();
    bus.syncAircraftList(1, [row(1, { visibility: 'members' })]);
    bus.presence(1, 1, now);
    bus.presence(1, 1, now - 60_000); // older ping ignored
    bus.refreshStatuses(now);
    expect(bus.list(1, 'member')[0].awakeTs).toBe(now);
    expect(bus.list(1, 'restricted')).toHaveLength(0);
    expect(bus.snapshotPayload(1, 'restricted')).toBe('{"aircraft":[]}');
  });

  it('a flight change mid-flush window does not carry the old flight point into the new trail delta', () => {
    const bus = new LiveBus();
    bus.syncAircraftList(1, [row(1)]);
    const at = (lon: number, lat: number, flight: number | null) =>
      bus.update(1, 1, { ...pos(now), lon, lat }, flight);
    at(0.5, 51.35, 5);
    bus.flush();
    // A connected client watches the deltas.
    const writes: string[] = [];
    bus.addClient(1, { write: (s: string) => writes.push(s), end: () => {} } as never, 'member', true);
    // One flush window: a stale fix for flight 5, then a fresh fix the detector
    // classifies as a NEW flight 6.
    at(0.6, 51.4, 5); // point A (old flight)
    at(1.2, 51.9, 6); // flight change -> trail reset; point B (new flight)
    bus.flush();
    const delta = JSON.parse(writes.filter((w) => w.includes('event: delta')).pop()!.match(/data: (.*)\n\n/s)![1]);
    const ac = delta.aircraft.find((a: { id: number }) => a.id === 1);
    expect(ac.trailReset).toBe(true);
    expect(ac.trailAppend).toEqual([[1.2, 51.9]]); // only the new flight's point, not A
  });

  it('roster removals and members-flips produce removal deltas per audience', () => {
    const bus = new LiveBus();
    bus.syncAircraftList(1, [row(1), row(2)]);
    // Flip aircraft 2 to members-only and drop aircraft 1 entirely.
    bus.syncAircraftList(1, [row(2, { visibility: 'members' })]);
    // Inspect via the ring buffer: attach a fake client after flush.
    const writes: string[] = [];
    const fakeRes = { write: (s: string) => writes.push(s), end: () => {} } as never;
    bus.flush();
    // A resuming client echoes the generation-stamped id it last saw. Grab it
    // from a fresh client's snapshot line, then resume another from just before.
    const probe: string[] = [];
    bus.addClient(1, { write: (s: string) => probe.push(s), end: () => {} } as never, 'restricted', true);
    const snapId = (probe.find((w) => w.includes('event: snapshot')) ?? '').match(/id: (\S+)/)?.[1] ?? '';
    const resumeFrom = snapId.replace(/\.(\d+)$/, (_m, n) => `.${Number(n) - 1}`); // one event earlier
    bus.addClient(1, fakeRes, 'restricted', true, { lastEventId: resumeFrom });
    const delta = writes.find((w) => w.includes('event: delta')) ?? '';
    expect(delta).toContain('"removed":[1,2]'); // roster removal + members flip
    const writesMember: string[] = [];
    const fakeRes2 = { write: (s: string) => writesMember.push(s), end: () => {} } as never;
    bus.addClient(1, fakeRes2, 'member', true, { lastEventId: resumeFrom });
    const memberDelta = writesMember.find((w) => w.includes('event: delta')) ?? '';
    expect(memberDelta).toContain('"removed":[1]'); // members keep aircraft 2
  });
});

describe('LiveBus ambient traffic', () => {
  const t = (hex: string) => ({
    hex,
    ts: now,
    lat: 51.4,
    lon: 0.6,
    alt: 2500,
    gs: 100,
    track: 180,
    callsign: 'XXX1',
    reg: null,
    type: null,
  });

  it('fans a changed list out to that club only, and stays quiet when unchanged', () => {
    const bus = new LiveBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.addClient(1, { write: (s: string) => a.push(s), end: () => {} } as never, 'restricted', true);
    bus.addClient(2, { write: (s: string) => b.push(s), end: () => {} } as never, 'member', true);
    const countTraffic = (w: string[]) => w.filter((x) => x.startsWith('event: traffic')).length;
    // Both got the (empty) connect-time state.
    expect(countTraffic(a)).toBe(1);
    expect(countTraffic(b)).toBe(1);

    bus.setOtherTraffic(1, [t('abc123')]);
    bus.flush();
    expect(countTraffic(a)).toBe(2);
    expect(countTraffic(b)).toBe(1); // other club: nothing
    expect(a[a.length - 1]).toContain('"hex":"abc123"');

    // Same list again: no wire traffic.
    bus.setOtherTraffic(1, [t('abc123')]);
    bus.flush();
    expect(countTraffic(a)).toBe(2);

    // Cleared: one final empty event.
    bus.setOtherTraffic(1, []);
    bus.flush();
    expect(a[a.length - 1]).toContain('event: traffic\ndata: {"aircraft":[]}');
  });

  it('a new client receives the current list on connect', () => {
    const bus = new LiveBus();
    bus.setOtherTraffic(1, [t('def456')]);
    bus.flush(); // nobody connected yet — flush just clears the dirty flag
    const w: string[] = [];
    bus.addClient(1, { write: (s: string) => w.push(s), end: () => {} } as never, 'restricted', true);
    const traffic = w.find((x) => x.startsWith('event: traffic')) ?? '';
    expect(traffic).toContain('"hex":"def456"');
  });
});
