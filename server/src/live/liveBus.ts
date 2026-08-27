import type { ServerResponse } from 'node:http';
import type { AircraftRow, LiveAircraft, NormPosition } from '../types.js';

const TRAIL_MAX_POINTS = 1500;
const AIRBORNE_FRESH_MS = 5 * 60_000;
const GROUND_FRESH_MS = 30 * 60_000;

// Two audiences: members (and admins) see everything; the open site and the
// kiosk TV see only aircraft whose visibility is 'public'.
export type Audience = 'member' | 'restricted';

interface SseClient {
  id: number;
  res: ServerResponse;
  audience: Audience;
  authenticated: boolean; // false = riding on public_mode
}

interface BufferedEvent {
  id: number;
  member: string;
  restricted: string;
}

export class LiveBus {
  private aircraft = new Map<number, LiveAircraft>();
  private clients = new Map<number, SseClient>();
  private nextClientId = 1;
  private nextEventId = 1;
  private ring: BufferedEvent[] = [];
  private dirty = new Map<number, [number, number] | null>(); // aircraftId -> trailAppend
  private trailResets = new Set<number>();

  syncAircraftList(rows: (AircraftRow & { status?: never })[]): void {
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = this.aircraft.get(row.id);
      const base: LiveAircraft = existing ?? {
        id: row.id,
        hex: row.hex,
        registration: row.registration,
        callsign: row.callsign,
        liveCallsign: null,
        typeName: row.type_name,
        nickname: row.nickname,
        tagline: row.tagline,
        category: row.category,
        visibility: row.visibility,
        icon: row.icon,
        iconUrl: null,
        photoUrl: null,
        color: row.color,
        status: 'offline',
        note: null,
        flightId: null,
        pos: null,
        trail: [],
      };
      base.hex = row.hex;
      base.registration = row.registration;
      base.callsign = row.callsign;
      base.typeName = row.type_name;
      base.nickname = row.nickname;
      base.tagline = row.tagline;
      base.category = row.category;
      base.visibility = row.visibility;
      base.icon = row.icon;
      base.iconUrl = row.icon_path ? `/uploads/${row.icon_path}` : null;
      base.photoUrl = row.photo_path ? `/uploads/${row.photo_path}` : null;
      base.color = row.color;
      if (!existing) this.aircraft.set(row.id, base);
    }
    for (const id of [...this.aircraft.keys()]) {
      if (!seen.has(id)) {
        this.aircraft.delete(id);
        this.dirty.delete(id);
      }
    }
  }

  seedTrail(aircraftId: number, flightId: number, points: [number, number][]): void {
    const a = this.aircraft.get(aircraftId);
    if (!a) return;
    a.flightId = flightId;
    a.trail = points.slice(-TRAIL_MAX_POINTS);
  }

  update(aircraftId: number, p: NormPosition, flightId: number | null): void {
    const a = this.aircraft.get(aircraftId);
    if (!a) return;
    if (a.flightId !== flightId) {
      a.trail = [];
      this.trailResets.add(aircraftId);
    }
    a.flightId = flightId;
    a.liveCallsign = p.callsign ?? a.liveCallsign;
    a.pos = {
      ts: p.ts,
      lat: p.lat,
      lon: p.lon,
      altBaro: p.altBaro,
      altGeom: p.altGeom,
      gs: p.gs,
      // A fix without track keeps the last known heading, so the map icon
      // never snaps back to pointing north mid-flight.
      track: p.track ?? a.pos?.track ?? null,
      baroRate: p.baroRate,
      squawk: p.squawk,
      onGround: p.onGround,
    };
    let appended: [number, number] | null = null;
    if (flightId !== null) {
      appended = [p.lon, p.lat];
      a.trail.push(appended);
      if (a.trail.length > TRAIL_MAX_POINTS) a.trail.splice(0, a.trail.length - TRAIL_MAX_POINTS);
    }
    this.dirty.set(aircraftId, appended);
  }

  private computeStatus(a: LiveAircraft, now: number): LiveAircraft['status'] {
    if (!a.pos) return 'offline';
    const age = now - a.pos.ts;
    if (a.flightId !== null && age < AIRBORNE_FRESH_MS) return 'airborne';
    if (age < GROUND_FRESH_MS) return 'ground';
    return 'offline';
  }

  // A departure/landing just happened: push it to live clients so tickers
  // refresh and the board snaps focus — respecting per-aircraft visibility.
  broadcastTicker(ev: { ts: number; text: string; aircraftId: number | null; visibility: 'public' | 'members' }): void {
    const payload = JSON.stringify({ ts: ev.ts, text: ev.text, aircraftId: ev.aircraftId });
    for (const c of this.clients.values()) {
      if (ev.visibility === 'members' && c.audience !== 'member') continue;
      c.res.write(`event: ticker\ndata: ${payload}\n\n`);
    }
  }

  // Kiosk annotations: sync the active note per aircraft; changes are pushed.
  setNotes(notes: Map<number, string>): void {
    for (const a of this.aircraft.values()) {
      const note = notes.get(a.id) ?? null;
      if (note !== a.note) {
        a.note = note;
        if (!this.dirty.has(a.id)) this.dirty.set(a.id, null);
      }
    }
  }

  // Re-derive statuses; any change marks the aircraft dirty so clients hear
  // about aircraft going offline even with no new data.
  refreshStatuses(now = Date.now()): void {
    for (const a of this.aircraft.values()) {
      const status = this.computeStatus(a, now);
      if (status !== a.status) {
        a.status = status;
        if (!this.dirty.has(a.id)) this.dirty.set(a.id, null);
      }
    }
  }

  list(audience: Audience): LiveAircraft[] {
    const all = [...this.aircraft.values()];
    return audience === 'member' ? all : all.filter((a) => a.visibility === 'public');
  }

  snapshotPayload(audience: Audience): string {
    return JSON.stringify({ aircraft: this.list(audience) });
  }

  private serializeDelta(ids: number[], audience: Audience): string {
    const changes = [];
    for (const id of ids) {
      const a = this.aircraft.get(id);
      if (!a) continue;
      if (audience === 'restricted' && a.visibility !== 'public') continue;
      const { trail, ...rest } = a;
      changes.push({
        ...rest,
        trailAppend: this.dirty.get(id) ?? null,
        trailReset: this.trailResets.has(id),
      });
    }
    return JSON.stringify({ aircraft: changes });
  }

  flush(): void {
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty.keys()];
    const ev: BufferedEvent = {
      id: this.nextEventId++,
      member: this.serializeDelta(ids, 'member'),
      restricted: this.serializeDelta(ids, 'restricted'),
    };
    this.dirty.clear();
    this.trailResets.clear();
    this.ring.push(ev);
    if (this.ring.length > 500) this.ring.splice(0, this.ring.length - 500);
    for (const c of this.clients.values()) {
      const payload = c.audience === 'member' ? ev.member : ev.restricted;
      if (payload !== '{"aircraft":[]}') {
        c.res.write(`event: delta\nid: ${ev.id}\ndata: ${payload}\n\n`);
      }
    }
  }

  addClient(res: ServerResponse, audience: Audience, authenticated: boolean, lastEventId?: number): number {
    const id = this.nextClientId++;
    this.clients.set(id, { id, res, audience, authenticated });
    // Resume from the ring buffer when possible, otherwise send a snapshot.
    const canResume =
      lastEventId !== undefined &&
      this.ring.length > 0 &&
      this.ring[0].id <= lastEventId + 1 &&
      this.ring[this.ring.length - 1].id >= lastEventId;
    if (canResume) {
      for (const ev of this.ring) {
        if (ev.id <= lastEventId!) continue;
        const payload = audience === 'member' ? ev.member : ev.restricted;
        res.write(`event: delta\nid: ${ev.id}\ndata: ${payload}\n\n`);
      }
    } else {
      const lastId = this.ring.length ? this.ring[this.ring.length - 1].id : 0;
      res.write(`event: snapshot\nid: ${lastId}\ndata: ${this.snapshotPayload(audience)}\n\n`);
    }
    return id;
  }

  removeClient(id: number): void {
    this.clients.delete(id);
  }

  heartbeat(): void {
    for (const c of this.clients.values()) c.res.write(': ping\n\n');
  }

  // public_mode flipped off: anonymous viewers lose the stream immediately.
  dropUnauthenticated(): void {
    for (const c of [...this.clients.values()]) {
      if (!c.authenticated) {
        try {
          c.res.end();
        } catch {
          /* already gone */
        }
        this.clients.delete(c.id);
      }
    }
  }

  clientCount(): number {
    return this.clients.size;
  }
}
