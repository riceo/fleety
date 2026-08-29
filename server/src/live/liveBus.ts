import type { ServerResponse } from 'node:http';
import type { AircraftRow, LiveAircraft, NormPosition } from '../types.js';

const TRAIL_MAX_POINTS = 1500;
const AIRBORNE_FRESH_MS = 5 * 60_000;
const GROUND_FRESH_MS = 30 * 60_000;
const AWAKE_FRESH_MS = 2 * 60_000; // transponder heard this recently => awake
const AWAKE_DIRTY_MS = 60_000; // throttle steady-state awake deltas

// Two audiences per club: members (and admins) see everything; the open site
// and the kiosk TV see only aircraft whose visibility is 'public'.
export type Audience = 'member' | 'restricted';

interface SseClient {
  id: number;
  res: ServerResponse;
  clubId: number;
  audience: Audience;
  authenticated: boolean; // false = riding on public_mode
  userId: number | null; // the member behind this stream, for targeted revocation
  kiosk: boolean; // a kiosk-token stream, dropped when the token rotates
  ip: string; // for the per-IP connection cap
}

// Bound concurrent SSE streams so one script can't exhaust the single process.
const MAX_CLIENTS_GLOBAL = 4000;
const MAX_CLIENTS_PER_IP = 30;

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
  // Trail points appended since the last flush. An array (not a single point)
  // so two fixes for one aircraft in the same flush window both reach clients.
  dirty = new Map<number, [number, number][] | null>();
  trailResets = new Set<number>();
  removed = new Map<number, 'public' | 'members'>(); // left roster (visibility at removal)
  hiddenFromRestricted = new Set<number>(); // flipped public -> members
  awakeEmitted = new Map<number, number>(); // last awakeTs actually sent to clients
  // Trails to restore on boot, held until the roster sync creates the aircraft.
  pendingSeeds = new Map<number, { flightId: number; points: [number, number][] }>();
}

export class LiveBus {
  private channels = new Map<number, ClubChannel>();
  private clients = new Map<number, SseClient>();
  private nextClientId = 1;
  // Per-process token stamped onto every event id. A Last-Event-ID from a
  // previous process (e.g. before a redeploy) then cannot satisfy a resume
  // against this run's ring — its baseline is stale, so we send a snapshot.
  private readonly bootId = Date.now().toString(36) + Math.trunc(process.hrtime()[1] % 1_000_000).toString(36);

  // Write to a client, dropping it on any error — a broken/closed socket must
  // never throw up into the poll loop (which would stop scheduling cycles).
  private safeWrite(c: SseClient, data: string): void {
    try {
      c.res.write(data);
    } catch {
      try {
        c.res.end();
      } catch {
        /* already gone */
      }
      this.clients.delete(c.id);
    }
  }

  // Rejected before the SSE stream is hijacked (the route sends 503).
  atCapacity(ip: string): boolean {
    if (this.clients.size >= MAX_CLIENTS_GLOBAL) return true;
    let perIp = 0;
    for (const c of this.clients.values()) if (c.ip === ip && ++perIp >= MAX_CLIENTS_PER_IP) return true;
    return false;
  }

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
        awakeTs: null,
        note: null,
        flightId: null,
        pos: null,
        trail: [],
      };
      // First appearance of an aircraft with a boot-time trail to restore.
      if (!existing) {
        const seed = ch.pendingSeeds.get(row.id);
        if (seed) {
          base.flightId = seed.flightId;
          base.trail = seed.points;
          ch.pendingSeeds.delete(row.id);
        }
      }
      const iconUrl = row.icon_path ? `/uploads/${row.icon_path}` : null;
      const photoUrl = row.photo_path ? `/uploads/${row.photo_path}` : null;
      // Captured before mutation below — `existing` aliases `base`.
      const prevVisibility = existing?.visibility;
      // Admin edits (colour, icon, tagline…) must reach connected boards
      // immediately, not on their next reconnect.
      const changed =
        existing &&
        (existing.color !== row.color ||
          existing.icon !== row.icon ||
          existing.iconUrl !== iconUrl ||
          existing.photoUrl !== photoUrl ||
          existing.callsign !== row.callsign ||
          existing.registration !== row.registration ||
          existing.nickname !== row.nickname ||
          existing.tagline !== row.tagline ||
          existing.description !== row.description ||
          existing.typeName !== row.type_name ||
          existing.visibility !== row.visibility ||
          existing.category !== row.category);
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
      base.iconUrl = iconUrl;
      base.photoUrl = photoUrl;
      // A visibility flip to members-only must actively remove the aircraft
      // from restricted clients (kiosk/public) — they get a removal delta.
      if (prevVisibility === 'public' && row.visibility === 'members') {
        ch.hiddenFromRestricted.add(row.id);
      }
      base.color = row.color;
      if (!existing) {
        ch.aircraft.set(row.id, base);
        // Newly added aircraft appear on connected boards immediately.
        if (!ch.dirty.has(row.id)) ch.dirty.set(row.id, null);
      }
      if (changed && !ch.dirty.has(row.id)) ch.dirty.set(row.id, null);
    }
    for (const id of [...ch.aircraft.keys()]) {
      if (!seen.has(id)) {
        const gone = ch.aircraft.get(id)!;
        ch.aircraft.delete(id);
        ch.dirty.delete(id);
        ch.awakeEmitted.delete(id);
        ch.removed.set(id, gone.visibility);
      }
    }
  }

  // The detector closed a flight (landed / assumed / lost): without this, a
  // coverage-gap flight that ends stays "airborne" forever on the board.
  flightEnded(clubId: number, aircraftId: number, flightId: number): void {
    const ch = this.channel(clubId);
    const a = ch.aircraft.get(aircraftId);
    if (!a || a.flightId !== flightId) return;
    a.flightId = null;
    if (!ch.dirty.has(aircraftId)) ch.dirty.set(aircraftId, null);
  }

  // Transponder sighting (with or without a position). Live-state only.
  presence(clubId: number, aircraftId: number, ts: number): void {
    const ch = this.channel(clubId);
    const a = ch.aircraft.get(aircraftId);
    if (!a) return;
    if (a.awakeTs !== null && ts <= a.awakeTs) return; // monotonic guard
    a.awakeTs = ts;
    // Throttle against the last EMITTED value (not the stored one, which
    // updates every poll): a parked transponder-on aircraft sends at most one
    // delta per minute, and clients' awakeTs stays fresh instead of freezing
    // at the first sighting. Status transitions still flush immediately.
    const lastEmitted = ch.awakeEmitted.get(aircraftId) ?? 0;
    if (ts - lastEmitted >= AWAKE_DIRTY_MS) {
      ch.awakeEmitted.set(aircraftId, ts);
      if (!ch.dirty.has(aircraftId)) ch.dirty.set(aircraftId, null);
    }
  }

  seedTrail(clubId: number, aircraftId: number, flightId: number, points: [number, number][]): void {
    const ch = this.channel(clubId);
    const trimmed = points.slice(-TRAIL_MAX_POINTS);
    const a = ch.aircraft.get(aircraftId);
    if (a) {
      a.flightId = flightId;
      a.trail = trimmed;
    } else {
      // Aircraft not synced yet (boot ordering): apply when it first appears.
      ch.pendingSeeds.set(aircraftId, { flightId, points: trimmed });
    }
  }

  update(clubId: number, aircraftId: number, p: NormPosition, flightId: number | null): void {
    const ch = this.channel(clubId);
    const a = ch.aircraft.get(aircraftId);
    if (!a) return;
    if (a.flightId !== flightId) {
      a.trail = [];
      ch.trailResets.add(aircraftId);
      // Drop any points accumulated for the OLD flight this flush window, or a
      // stale earlier fix would ride into the new flight's trail on the client.
      ch.dirty.set(aircraftId, null);
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
    // A position always implies presence (and this delta carries it).
    if (p.ts > (a.awakeTs ?? 0)) a.awakeTs = p.ts;
    ch.awakeEmitted.set(aircraftId, a.awakeTs ?? p.ts);
    if (flightId !== null) {
      const point: [number, number] = [p.lon, p.lat];
      a.trail.push(point);
      if (a.trail.length > TRAIL_MAX_POINTS) a.trail.splice(0, a.trail.length - TRAIL_MAX_POINTS);
      // Accumulate rather than overwrite: a stale primary fix and a fresher
      // failover fix in the same cycle must both survive to the delta.
      const prev = ch.dirty.get(aircraftId);
      const pts = Array.isArray(prev) ? prev : [];
      pts.push(point);
      ch.dirty.set(aircraftId, pts);
    } else if (!ch.dirty.has(aircraftId)) {
      ch.dirty.set(aircraftId, null);
    }
  }

  // A departure/landing/broadcast for one club: push to that club's clients so
  // tickers refresh and the board snaps focus — respecting visibility.
  broadcastTicker(clubId: number, ev: TickerBroadcast): void {
    const payload = JSON.stringify({ ts: ev.ts, text: ev.text, aircraftId: ev.aircraftId });
    for (const c of this.clients.values()) {
      if (c.clubId !== clubId) continue;
      if (ev.visibility === 'members' && c.audience !== 'member') continue;
      this.safeWrite(c, `event: ticker\ndata: ${payload}\n\n`);
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
    const posAge = a.pos ? now - a.pos.ts : Infinity;
    const awakeAge = a.awakeTs !== null ? now - a.awakeTs : Infinity;
    // An open flight IS airborne, even through a coverage gap — the detector
    // decides when it's over (and flightEnded() clears it here). The UI shows
    // a SIGNAL LOST caveat when the fix is stale.
    if (a.flightId !== null) return 'airborne';
    // A current fix outranks presence: richer information wins.
    if (posAge < AIRBORNE_FRESH_MS) return 'ground';
    // Transponder heard just now but no current fix: awake (FR24-style).
    if (awakeAge < AWAKE_FRESH_MS) return 'awake';
    if (posAge < GROUND_FRESH_MS) return 'ground';
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
    // Restricted clients also remove aircraft that just went members-only —
    // but never learn about roster removals of aircraft they could not see.
    const rosterRemovals =
      audience === 'restricted'
        ? [...ch.removed.entries()].filter(([, vis]) => vis === 'public').map(([id]) => id)
        : [...ch.removed.keys()];
    const removed =
      audience === 'restricted' ? [...rosterRemovals, ...ch.hiddenFromRestricted] : rosterRemovals;
    return JSON.stringify({ aircraft: changes, removed });
  }

  flush(): void {
    for (const [clubId, ch] of this.channels) {
      if (ch.dirty.size === 0 && ch.removed.size === 0 && ch.hiddenFromRestricted.size === 0) continue;
      const ids = [...ch.dirty.keys()];
      const ev: BufferedEvent = {
        id: ch.nextEventId++,
        member: this.serializeDelta(ch, ids, 'member'),
        restricted: this.serializeDelta(ch, ids, 'restricted'),
      };
      ch.dirty.clear();
      ch.trailResets.clear();
      ch.removed.clear();
      ch.hiddenFromRestricted.clear();
      ch.ring.push(ev);
      if (ch.ring.length > 500) ch.ring.splice(0, ch.ring.length - 500);
      for (const c of this.clients.values()) {
        if (c.clubId !== clubId) continue;
        const payload = c.audience === 'member' ? ev.member : ev.restricted;
        if (payload !== '{"aircraft":[],"removed":[]}') {
          this.safeWrite(c, `event: delta\nid: ${this.bootId}.${ev.id}\ndata: ${payload}\n\n`);
        }
      }
    }
  }

  addClient(
    clubId: number,
    res: ServerResponse,
    audience: Audience,
    authenticated: boolean,
    opts: { lastEventId?: string; userId?: number | null; kiosk?: boolean; ip?: string } = {}
  ): number {
    const ch = this.channel(clubId);
    const id = this.nextClientId++;
    this.clients.set(id, {
      id,
      res,
      clubId,
      audience,
      authenticated,
      userId: opts.userId ?? null,
      kiosk: !!opts.kiosk,
      ip: opts.ip ?? '',
    });
    // Only resume when the Last-Event-ID belongs to THIS process generation.
    const [gen, seqStr] = (opts.lastEventId ?? '').split('.');
    const lastSeq = gen === this.bootId ? Number(seqStr) : NaN;
    const canResume =
      Number.isFinite(lastSeq) &&
      ch.ring.length > 0 &&
      ch.ring[0].id <= lastSeq + 1 &&
      ch.ring[ch.ring.length - 1].id >= lastSeq;
    if (canResume) {
      for (const ev of ch.ring) {
        if (ev.id <= lastSeq) continue;
        const payload = audience === 'member' ? ev.member : ev.restricted;
        this.safeWrite(this.clients.get(id)!, `event: delta\nid: ${this.bootId}.${ev.id}\ndata: ${payload}\n\n`);
      }
    } else {
      const lastId = ch.ring.length ? ch.ring[ch.ring.length - 1].id : 0;
      this.safeWrite(this.clients.get(id)!, `event: snapshot\nid: ${this.bootId}.${lastId}\ndata: ${this.snapshotPayload(clubId, audience)}\n\n`);
    }
    return id;
  }

  removeClient(id: number): void {
    this.clients.delete(id);
  }

  heartbeat(): void {
    // A named event (not an SSE comment) so the client's 'ping' listener fires
    // and its liveness watchdog sees a healthy-but-quiet feed as alive.
    for (const c of this.clients.values()) this.safeWrite(c, 'event: ping\ndata: {}\n\n');
  }

  private endClient(c: SseClient): void {
    try {
      c.res.end();
    } catch {
      /* already gone */
    }
    this.clients.delete(c.id);
  }

  // A member was removed from a club (or demoted): drop their live streams so
  // members-only data stops flowing immediately, not just on the next reconnect.
  dropUser(clubId: number, userId: number): void {
    for (const c of [...this.clients.values()]) {
      if (c.clubId === clubId && c.userId === userId) this.endClient(c);
    }
  }

  // The kiosk token rotated: existing kiosk streams for this club are now
  // unauthorized and must be cut.
  dropKiosk(clubId: number): void {
    for (const c of [...this.clients.values()]) {
      if (c.clubId === clubId && c.kiosk) this.endClient(c);
    }
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
