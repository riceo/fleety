import type { Database } from 'better-sqlite3';
import { displayCallsignFor, type CallsignRule } from './clubs.js';

// Flight annotations for the plane-spotting kiosk: a message pinned to an
// aircraft either until a set time, or "for the next flight" — armed when the
// aircraft takes off, cleared automatically when it lands. Take-offs and
// landings also feed the club's ticker tape, and are broadcast live so the
// board snaps focus to the aircraft the moment something happens.

export interface TickerEvent {
  ts: number;
  text: string;
  aircraftId: number | null;
  clubId: number;
  visibility: 'public' | 'members';
}

export type TickerEmit = (ev: TickerEvent) => void;

// Notes currently worth showing, grouped per club (the poller pushes these
// into each club's live channel every cycle).
export function activeNotesByClub(db: Database, now = Date.now()): Map<number, Map<number, string>> {
  const rows = db
    .prepare(
      `SELECT an.aircraft_id, an.text, a.club_id FROM annotations an
       JOIN aircraft a ON a.id = an.aircraft_id
       WHERE (an.mode = 'until' AND an.until_ts > ? AND an.status != 'done')
          OR (an.mode = 'next_flight' AND an.status IN ('pending', 'active'))
       ORDER BY an.created_at DESC`
    )
    .all(now) as { aircraft_id: number; text: string; club_id: number }[];
  const byClub = new Map<number, Map<number, string>>();
  for (const r of rows) {
    const club = byClub.get(r.club_id) ?? new Map<number, string>();
    if (!club.has(r.aircraft_id)) club.set(r.aircraft_id, r.text);
    byClub.set(r.club_id, club);
  }
  return byClub;
}

export function activeNoteFor(db: Database, aircraftId: number, now = Date.now()): string | undefined {
  const row = db
    .prepare(
      `SELECT text FROM annotations
       WHERE aircraft_id = ?
         AND ((mode = 'until' AND until_ts > ? AND status != 'done')
           OR (mode = 'next_flight' AND status IN ('pending', 'active')))
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(aircraftId, now) as { text: string } | undefined;
  return row?.text;
}

interface AircraftInfo {
  registration: string;
  callsign: string;
  visibility: 'public' | 'members';
  club_id: number;
  callsign_rules: string;
}

function aircraftInfo(db: Database, aircraftId: number): AircraftInfo | undefined {
  return db
    .prepare(
      `SELECT a.registration, a.callsign, a.visibility, a.club_id, c.callsign_rules
       FROM aircraft a JOIN clubs c ON c.id = a.club_id WHERE a.id = ?`
    )
    .get(aircraftId) as AircraftInfo | undefined;
}

function parseRules(json: string): CallsignRule[] {
  try {
    const parsed = JSON.parse(json) as CallsignRule[];
    return Array.isArray(parsed) ? parsed.filter((r) => r && r.prefix && r.spoken) : [];
  } catch {
    return [];
  }
}

function writeEvent(db: Database, clubId: number, aircraftId: number | null, text: string, emit?: TickerEmit): void {
  const ts = Date.now();
  db.prepare('INSERT INTO ticker_events (ts, club_id, aircraft_id, text) VALUES (?, ?, ?, ?)').run(
    ts,
    clubId,
    aircraftId,
    text
  );
  const ac = aircraftId !== null ? aircraftInfo(db, aircraftId) : null;
  emit?.({ ts, text, aircraftId, clubId, visibility: aircraftId === null ? 'public' : (ac?.visibility ?? 'members') });
}

// Admin-typed message straight onto the club's tape.
export function postTickerMessage(db: Database, clubId: number, text: string, emit?: TickerEmit): void {
  writeEvent(db, clubId, null, text.trim(), emit);
}

// Take-off: arm pending next-flight notes and write the departure ticker line,
// e.g. "INVICTA 08 HAS DEPARTED ROCHESTER! — PAX: BOB AND JESS EXPERIENCE".
export function onTakeoff(db: Database, flightId: number, aircraftId: number, emit?: TickerEmit): void {
  db.prepare(
    `UPDATE annotations SET status = 'active', flight_id = ?
     WHERE aircraft_id = ? AND mode = 'next_flight' AND status = 'pending'`
  ).run(flightId, aircraftId);

  const ac = aircraftInfo(db, aircraftId);
  if (!ac) return;
  const label = displayCallsignFor(ac.callsign || ac.registration, parseRules(ac.callsign_rules));
  const flight = db
    .prepare(
      `SELECT af.name AS origin_name FROM flights f LEFT JOIN airfields af ON af.id = f.origin_airfield_id WHERE f.id = ?`
    )
    .get(flightId) as { origin_name: string | null } | undefined;
  const note = activeNoteFor(db, aircraftId);
  const from = flight?.origin_name ? ` ${flight.origin_name.toUpperCase()}` : '';
  writeEvent(db, ac.club_id, aircraftId, `${label} HAS DEPARTED${from}!${note ? ` — ${note.toUpperCase()}` : ''}`, emit);
}

export function onLanding(db: Database, flightId: number, aircraftId: number, emit?: TickerEmit): void {
  const flight = db
    .prepare(
      `SELECT f.end_confidence, af.name AS dest_name
       FROM flights f LEFT JOIN airfields af ON af.id = f.dest_airfield_id WHERE f.id = ?`
    )
    .get(flightId) as { end_confidence: string | null; dest_name: string | null } | undefined;
  const ac = aircraftInfo(db, aircraftId);
  if (!ac) return;
  const label = displayCallsignFor(ac.callsign || ac.registration, parseRules(ac.callsign_rules));
  if (flight?.end_confidence === 'confirmed' || flight?.end_confidence === 'assumed') {
    const at = flight.dest_name ? ` AT ${flight.dest_name.toUpperCase()}` : '';
    writeEvent(db, ac.club_id, aircraftId, `${label} HAS LANDED${at}`, emit);
  }
  // The flight is over — retire its next-flight notes.
  db.prepare(
    `UPDATE annotations SET status = 'done'
     WHERE aircraft_id = ? AND (flight_id = ? OR (mode = 'next_flight' AND status = 'active'))`
  ).run(aircraftId, flightId);
}

export interface TickerItem {
  ts: number;
  text: string;
  aircraftId: number | null;
}

// One club's ticker feed: recent departures/landings (45-minute window so a
// busy circuit day doesn't bury the tape), admin broadcasts (6 hours),
// standing flight notes, and per-aircraft taglines. Members see everything;
// the open site and kiosk only see public-visibility aircraft.
export function tickerItems(
  db: Database,
  clubId: number,
  audience: 'member' | 'restricted',
  now = Date.now()
): TickerItem[] {
  const visFilter = audience === 'member' ? '' : " AND a.visibility = 'public'";
  const eventVis = audience === 'member' ? '' : " AND (e.aircraft_id IS NULL OR a.visibility = 'public')";

  const events = db
    .prepare(
      `SELECT e.ts, e.text, e.aircraft_id AS aircraftId FROM ticker_events e
       LEFT JOIN aircraft a ON a.id = e.aircraft_id
       WHERE e.club_id = ?
         AND ((e.aircraft_id IS NOT NULL AND e.ts > ?) OR (e.aircraft_id IS NULL AND e.ts > ?))${eventVis}
       ORDER BY e.ts DESC LIMIT 20`
    )
    .all(clubId, now - 45 * 60_000, now - 6 * 3600 * 1000) as TickerItem[];

  const club = db.prepare('SELECT callsign_rules FROM clubs WHERE id = ?').get(clubId) as
    | { callsign_rules: string }
    | undefined;
  const rules = parseRules(club?.callsign_rules ?? '[]');
  const spoken = (cs: string) => displayCallsignFor(cs, rules);

  const notes = db
    .prepare(
      `SELECT an.created_at AS ts, an.text, an.mode, a.id AS aircraftId, a.registration, a.callsign
       FROM annotations an JOIN aircraft a ON a.id = an.aircraft_id
       WHERE a.club_id = ?
         AND ((an.mode = 'until' AND an.until_ts > ? AND an.status != 'done')
           OR (an.mode = 'next_flight' AND an.status = 'pending'))${visFilter}
       ORDER BY an.created_at DESC LIMIT 10`
    )
    .all(clubId, now) as { ts: number; text: string; mode: string; aircraftId: number; registration: string; callsign: string }[];

  const noteItems: TickerItem[] = notes.map((n) => ({
    ts: n.ts,
    aircraftId: n.aircraftId,
    text: `${spoken(n.callsign || n.registration)}${n.mode === 'next_flight' ? ' NEXT FLIGHT' : ''} — ${n.text.toUpperCase()}`,
  }));

  // Taglines join the tape only for aircraft actually seen recently — a
  // freshly added guest shouldn't be announced before it has ever appeared.
  const taglines = db
    .prepare(
      `SELECT a.id AS aircraftId, a.registration, a.callsign, a.tagline FROM aircraft a
       WHERE a.club_id = ? AND a.deleted_at IS NULL AND a.enabled = 1 AND a.tagline != ''${visFilter}
         AND EXISTS (SELECT 1 FROM positions p WHERE p.aircraft_id = a.id AND p.ts > ?)
       ORDER BY a.sort_order`
    )
    .all(clubId, now - 7 * 24 * 3600 * 1000) as { aircraftId: number; registration: string; callsign: string; tagline: string }[];

  const taglineItems: TickerItem[] = taglines.map((t) => ({
    ts: 0,
    aircraftId: t.aircraftId,
    text: `${spoken(t.callsign || t.registration)} — ${t.tagline.toUpperCase()}`,
  }));

  const timed = [...noteItems, ...events].sort((a, b) => b.ts - a.ts).slice(0, 20);
  return [...timed, ...taglineItems];
}

export function pruneTicker(db: Database): void {
  db.prepare('DELETE FROM ticker_events WHERE ts < ?').run(Date.now() - 7 * 24 * 3600 * 1000);
  db.prepare("UPDATE annotations SET status = 'done' WHERE mode = 'until' AND until_ts < ?").run(Date.now());
}
