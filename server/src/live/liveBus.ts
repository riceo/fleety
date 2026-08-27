import type { ServerResponse } from 'node:http';
import type { AircraftRow, LiveAircraft, NormPosition } from '../types.js';

const TRAIL_MAX_POINTS = 1500;
const AIRBORNE_FRESH_MS = 5 * 60_000;
const GROUND_FRESH_MS = 30 * 60_000;

// Two audiences per club: members (and admins) see everything; the open site
// and the kiosk TV see only aircraft whose visibility is 'public'.
export type Audience = 'member' | 'restricted';

interface SseClient {
  id: number;
  res: ServerResponse;
  clubId: number;
  audience: Audience;
  authenticated: boolean; // false = riding on public_mode
}

interface BufferedEvent {
  id: number;
  member: string;
  restricted: string;
}

export interface TickerBroadcast {
  ts: number;
  text: string;
  aircraftId: number | null;
  visibility: 'public' | 'members';
}

// One channel per club — snapshot/delta state, ring buffer, and its clients.
class ClubChannel {
  aircraft = new Map<number, LiveAircraft>();
  ring: BufferedEvent[] = [];
  nextEventId = 1;
  dirty = new Map<number, [number, number] | null>();
  trailResets = new Set<number>();
}

export class LiveBus {
  private channels = new Map<number, ClubChannel>();
  private clients = new Map<number, SseClient>();
  private nextClientId = 1;

  private channel(clubId: number): ClubChannel {
    let ch = this.channels.get(clubId);
    if (!ch) {
      ch = new ClubChannel();
      this.channels.set(clubId, ch);
    }
    return ch;
  }

  syncAircraftList(clubId: number, rows: AircraftRow[]): void {
    const ch = this.channel(clubId);
    const seen = new Set<number>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = ch.aircraft.get(row.id);
      const base: LiveAircraft = existing ?? {
        id: row.id,
        hex: row.hex,
        registration: row.registration,
        callsign: row.callsign,
        liveCallsign: null,
        typeName: row.type_name,
        nickname: row.nickname,
        tagline: row.tagline,
        description: row.description,
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
      base.description = row.description;
      base.category = row.category;
      base.visibility = row.visibility;
      base.icon = row.icon;
      base.iconUrl = row.icon_path ? `/uploads/${row.icon_path}` : null;
      base.photoUrl = row.photo_path ? `/uploads/${row.photo_path}` : null;
      base.color = row.color;
      if (!existing) ch.aircraft.set(row.id, base);
    }
    for (const id of [...ch.aircraft.keys()]) {
      if (!seen.has(id)) {
        ch.aircraft.delete(id);
        ch.dirty.delete(id);
      }
    }
  }

  seedTrail(clubId: number, aircraftId: number, flightId: number, points: [number, number][]): void {
    const a = this.channel(clubId).aircraft.get(aircraftId);
    if (!a) return;
    a.flightId = flightId;
    a.trail = points.slice(-TRAIL_MAX_POINTS);
  }

  update(clubId: number, aircraftId: number, p: NormPosition, flightId: number | null): void {
    const ch = this.channel(clubId);
    const a = ch.aircraft.get(aircraftId);
    if (!a) return;
    if (a.flightId !== flightId) {
      a.trail = [];
      ch.trailResets.add(aircraftId);
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
    ch.dirty.set(aircraftId, appended);
  }

  // A departure/landing/broadcast for one club: push to that club's clients so
  // tickers refresh and the board snaps focus — respecting visibility.
  broadcastTicker(clubId: number, ev: TickerBroadcast): void {
    const payload = JSON.stringify({ ts: ev.ts, text: ev.text, aircraftId: ev.aircraftId });
    for (const c of this.clients.values()) {
      if (c.clubId !== clubId) continue;
      if (ev.visibility === 'members' && c.audience !== 'member') continue;
      c.res.write(`event: ticker\ndata: ${payload}\n\n`);
    }
  }

  setNotes(clubId: number, notes: Map<number, string>): void {
    const ch = this.channel(clubId);
    for (const a of ch.aircraft.values()) {
      const note = notes.get(a.id) ?? null;
      if (note !== a.note) {
        a.note = note;
        if (!ch.dirty.has(a.id)) ch.dirty.set(a.id, null);
      }
    }
  }

  private computeStatus(a: LiveAircraft, now: number): LiveAircraft['status'] {
    if (!a.pos) return 'offline';
    const age = now - a.pos.ts;
    if (a.flightId !== null && age < AIRBORNE_FRESH_MS) return 'airborne';
    if (age < GROUND_FRESH_MS) return 'ground';
    return 'offline';
  }

  refreshStatuses(now = Date.now()): void {
    for (const ch of this.channels.values()) {
      for (const a of ch.aircraft.values()) {
        const status = this.computeStatus(a, now);
        if (status !== a.status) {
          a.status = status;
          if (!ch.dirty.has(a.id)) ch.dirty.set(a.id, null);
        }
      }
    }
  }

  list(clubId: number, audience: Audience): LiveAircraft[] {
    const all = [...this.channel(clubId).aircraft.values()];
    return audience === 'member' ? all : all.filter((a) => a.visibility === 'public');
  }

  snapshotPayload(clubId: number, audience: Audience): string {
    return JSON.stringify({ aircraft: this.list(clubId, audience) });
  }

  private serializeDelta(ch: ClubChannel, ids: number[], audience: Audience): string {
    const changes = [];
    for (const id of ids) {
      const a = ch.aircraft.get(id);
      if (!a) continue;
      if (audience === 'restricted' && a.visibility !== 'public') continue;
      const { trail, ...rest } = a;
      changes.push({
        ...rest,
        trailAppend: ch.dirty.get(id) ?? null,
        trailReset: ch.trailResets.has(id),
      });
    }
    return JSON.stringify({ aircraft: changes });
  }

  flush(): void {
    for (const [clubId, ch] of this.channels) {
      if (ch.dirty.size === 0) continue;
      const ids = [...ch.dirty.keys()];
      const ev: BufferedEvent = {
        id: ch.nextEventId++,
        member: this.serializeDelta(ch, ids, 'member'),
        restricted: this.serializeDelta(ch, ids, 'restricted'),
      };
      ch.dirty.clear();
      ch.trailResets.clear();
      ch.ring.push(ev);
      if (ch.ring.length > 500) ch.ring.splice(0, ch.ring.length - 500);
      for (const c of this.clients.values()) {
        if (c.clubId !== clubId) continue;
        const payload = c.audience === 'member' ? ev.member : ev.restricted;
        if (payload !== '{"aircraft":[]}') {
          c.res.write(`event: delta\nid: ${ev.id}\ndata: ${payload}\n\n`);
        }
      }
    }
  }

  addClient(
    clubId: number,
    res: ServerResponse,
    audience: Audience,
    authenticated: boolean,
    lastEventId?: number
  ): number {
    const ch = this.channel(clubId);
    const id = this.nextClientId++;
    this.clients.set(id, { id, res, clubId, audience, authenticated });
    const canResume =
      lastEventId !== undefined &&
      ch.ring.length > 0 &&
      ch.ring[0].id <= lastEventId + 1 &&
      ch.ring[ch.ring.length - 1].id >= lastEventId;
    if (canResume) {
      for (const ev of ch.ring) {
        if (ev.id <= lastEventId!) continue;
        const payload = audience === 'member' ? ev.member : ev.restricted;
        res.write(`event: delta\nid: ${ev.id}\ndata: ${payload}\n\n`);
      }
    } else {
      const lastId = ch.ring.length ? ch.ring[ch.ring.length - 1].id : 0;
      res.write(`event: snapshot\nid: ${lastId}\ndata: ${this.snapshotPayload(clubId, audience)}\n\n`);
    }
    return id;
  }

  removeClient(id: number): void {
    this.clients.delete(id);
  }

  heartbeat(): void {
    for (const c of this.clients.values()) c.res.write(': ping\n\n');
  }

  // A club flipped private: its anonymous viewers lose the stream immediately.
  dropUnauthenticated(clubId: number): void {
    for (const c of [...this.clients.values()]) {
      if (c.clubId === clubId && !c.authenticated) {
        try {
          c.res.end();
        } catch {
          /* already gone */
        }
        this.clients.delete(c.id);
      }
    }
  }

  clientCount(clubId?: number): number {
    if (clubId === undefined) return this.clients.size;
    return [...this.clients.values()].filter((c) => c.clubId === clubId).length;
  }
}
