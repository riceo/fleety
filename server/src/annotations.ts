import type { Database } from 'better-sqlite3';

// Flight annotations for the plane-spotting kiosk: a message pinned to an
// aircraft either until a set time, or "for the next flight" — armed when the
// aircraft takes off, cleared automatically when it lands. Take-offs and
// landings also feed the ticker tape, and can be broadcast live so the board
// snaps focus to the aircraft the moment something happens.

export interface TickerEvent {
  ts: number;
  text: string;
  aircraftId: number | null;
  visibility: 'public' | 'members';
}

export type TickerEmit = (ev: TickerEvent) => void;

// "INV01" reads as "INVICTA 01" over the radio — and on the board.
export function displayCallsign(cs: string): string {
  const m = /^INV\s?(\d+)$/i.exec(cs.trim());
  return m ? `INVICTA ${m[1]}` : cs.trim().toUpperCase();
}

// Notes currently worth showing: timed ones inside their window, and
// next-flight ones that are queued (pending) or airborne (active).
export function activeNotes(db: Database, now = Date.now()): Map<number, string> {
  const rows = db
    .prepare(
      `SELECT aircraft_id, text FROM annotations
       WHERE (mode = 'until' AND until_ts > ? AND status != 'done')
          OR (mode = 'next_flight' AND status IN ('pending', 'active'))
       ORDER BY created_at DESC`
    )
    .all(now) as { aircraft_id: number; text: string }[];
  const map = new Map<number, string>();
  for (const r of rows) {
    if (!map.has(r.aircraft_id)) map.set(r.aircraft_id, r.text);
  }
  return map;
}

function aircraftInfo(db: Database, aircraftId: number) {
  return db
    .prepare('SELECT registration, callsign, visibility FROM aircraft WHERE id = ?')
    .get(aircraftId) as { registration: string; callsign: string; visibility: 'public' | 'members' } | undefined;
}

function writeEvent(db: Database, aircraftId: number | null, text: string, emit?: TickerEmit): void {
  const ts = Date.now();
  db.prepare('INSERT INTO ticker_events (ts, aircraft_id, text) VALUES (?, ?, ?)').run(ts, aircraftId, text);
  // Custom broadcasts (no aircraft) are for everyone; aircraft events follow
  // the aircraft's visibility.
  const ac = aircraftId !== null ? aircraftInfo(db, aircraftId) : null;
  emit?.({ ts, text, aircraftId, visibility: aircraftId === null ? 'public' : (ac?.visibility ?? 'members') });
}

// Admin-typed message straight onto the tape ("BBQ AT THE CLUBHOUSE SATURDAY").
export function postTickerMessage(db: Database, text: string, emit?: TickerEmit): void {
  writeEvent(db, null, text.trim(), emit);
}

// Take-off: arm pending next-flight notes and write the departure ticker line,
// e.g. "INVICTA 08 HAS DEPARTED ROCHESTER! — PAX: BOB AND JESS EXPERIENCE".
export function onTakeoff(db: Database, flightId: number, aircraftId: number, emit?: TickerEmit): void {
  db.prepare(
    `UPDATE annotations SET status = 'active', flight_id = ?
     WHERE aircraft_id = ? AND mode = 'next_flight' AND status = 'pending'`
  ).run(flightId, aircraftId);

  const ac = aircraftInfo(db, aircraftId);
  const label = displayCallsign(ac?.callsign || ac?.registration || '?');
  const flight = db
    .prepare(
      `SELECT af.name AS origin_name FROM flights f LEFT JOIN airfields af ON af.id = f.origin_airfield_id WHERE f.id = ?`
    )
    .get(flightId) as { origin_name: string | null } | undefined;
  const note = activeNotes(db).get(aircraftId);
  const from = flight?.origin_name ? ` ${flight.origin_name.toUpperCase()}` : '';
  writeEvent(db, aircraftId, `${label} HAS DEPARTED${from}!${note ? ` — ${note.toUpperCase()}` : ''}`, emit);
}

export function onLanding(db: Database, flightId: number, aircraftId: number, emit?: TickerEmit): void {
  const flight = db
    .prepare(
      `SELECT f.end_confidence, af.name AS dest_name
       FROM flights f LEFT JOIN airfields af ON af.id = f.dest_airfield_id WHERE f.id = ?`
    )
    .get(flightId) as { end_confidence: string | null; dest_name: string | null } | undefined;
  const ac = aircraftInfo(db, aircraftId);
  const label = displayCallsign(ac?.callsign || ac?.registration || '?');
  if (flight?.end_confidence === 'confirmed' || flight?.end_confidence === 'assumed') {
    const at = flight.dest_name ? ` AT ${flight.dest_name.toUpperCase()}` : '';
    writeEvent(db, aircraftId, `${label} HAS LANDED${at}`, emit);
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

// The ticker feed: recent departures/landings, standing flight notes, and
// per-aircraft taglines ("Our aerobatic display ship — where's he displaying
// next?"). Members see everything; the open site and kiosk only see aircraft
// whose visibility is public.
export function tickerItems(db: Database, audience: 'member' | 'restricted', now = Date.now()): TickerItem[] {
  const visFilter = audience === 'member' ? '' : " AND a.visibility = 'public'";

  const eventVis = audience === 'member' ? '' : " AND (e.aircraft_id IS NULL OR a.visibility = 'public')";
  // Departures/landings age off quickly (a busy circuit day would otherwise
  // bury the tape); admin broadcasts run the full six hours.
  const events = db
    .prepare(
      `SELECT e.ts, e.text, e.aircraft_id AS aircraftId FROM ticker_events e
       LEFT JOIN aircraft a ON a.id = e.aircraft_id
       WHERE ((e.aircraft_id IS NOT NULL AND e.ts > ?) OR (e.aircraft_id IS NULL AND e.ts > ?))${eventVis}
       ORDER BY e.ts DESC LIMIT 20`
    )
    .all(now - 45 * 60_000, now - 6 * 3600 * 1000) as TickerItem[];

  const notes = db
    .prepare(
      `SELECT an.created_at AS ts, an.text, an.mode, a.id AS aircraftId, a.registration, a.callsign
       FROM annotations an JOIN aircraft a ON a.id = an.aircraft_id
       WHERE ((an.mode = 'until' AND an.until_ts > ? AND an.status != 'done')
          OR (an.mode = 'next_flight' AND an.status = 'pending'))${visFilter}
       ORDER BY an.created_at DESC LIMIT 10`
    )
    .all(now) as { ts: number; text: string; mode: string; aircraftId: number; registration: string; callsign: string }[];

  const noteItems: TickerItem[] = notes.map((n) => ({
    ts: n.ts,
    aircraftId: n.aircraftId,
    text: `${displayCallsign(n.callsign || n.registration)}${n.mode === 'next_flight' ? ' NEXT FLIGHT' : ''} — ${n.text.toUpperCase()}`,
  }));

  const taglines = db
    .prepare(
      `SELECT a.id AS aircraftId, a.registration, a.callsign, a.tagline FROM aircraft a
       WHERE a.deleted_at IS NULL AND a.enabled = 1 AND a.tagline != ''${visFilter}
       ORDER BY a.sort_order`
    )
    .all() as { aircraftId: number; registration: string; callsign: string; tagline: string }[];

  const taglineItems: TickerItem[] = taglines.map((t) => ({
    ts: 0,
    aircraftId: t.aircraftId,
    text: `${displayCallsign(t.callsign || t.registration)} — ${t.tagline.toUpperCase()}`,
  }));

  const timed = [...noteItems, ...events].sort((a, b) => b.ts - a.ts).slice(0, 20);
  return [...timed, ...taglineItems];
}

export function pruneTicker(db: Database): void {
  db.prepare('DELETE FROM ticker_events WHERE ts < ?').run(Date.now() - 7 * 24 * 3600 * 1000);
  db.prepare("UPDATE annotations SET status = 'done' WHERE mode = 'until' AND until_ts < ?").run(Date.now());
}
