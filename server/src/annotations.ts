import type { Database } from 'better-sqlite3';

// Flight annotations for the plane-spotting kiosk: a message pinned to an
// aircraft either until a set time, or "for the next flight" — armed when the
// aircraft takes off, cleared automatically when it lands.

export interface ActiveNote {
  aircraftId: number;
  text: string;
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

export function writeTickerEvent(db: Database, aircraftId: number | null, text: string): void {
  db.prepare('INSERT INTO ticker_events (ts, aircraft_id, text) VALUES (?, ?, ?)').run(
    Date.now(),
    aircraftId,
    text
  );
}

function aircraftLabel(db: Database, aircraftId: number): { label: string; reg: string } {
  const ac = db.prepare('SELECT registration, callsign FROM aircraft WHERE id = ?').get(aircraftId) as
    | { registration: string; callsign: string }
    | undefined;
  const reg = ac?.registration ?? '?';
  return { label: ac?.callsign || reg, reg };
}

// Take-off: arm pending next-flight notes and write the departure ticker line
// (with the note appended, e.g. "INV08 HAS TAKEN OFF FROM ROCHESTER — PAX: …").
export function onTakeoff(db: Database, flightId: number, aircraftId: number): void {
  db.prepare(
    `UPDATE annotations SET status = 'active', flight_id = ?
     WHERE aircraft_id = ? AND mode = 'next_flight' AND status = 'pending'`
  ).run(flightId, aircraftId);

  const { label } = aircraftLabel(db, aircraftId);
  const flight = db
    .prepare(
      `SELECT af.name AS origin_name FROM flights f LEFT JOIN airfields af ON af.id = f.origin_airfield_id WHERE f.id = ?`
    )
    .get(flightId) as { origin_name: string | null } | undefined;
  const note = activeNotes(db).get(aircraftId);
  const from = flight?.origin_name ? ` FROM ${flight.origin_name.toUpperCase()}` : '';
  writeTickerEvent(db, aircraftId, `${label} HAS TAKEN OFF${from}${note ? ` — ${note.toUpperCase()}` : ''}`);
}

export function onLanding(db: Database, flightId: number, aircraftId: number): void {
  const flight = db
    .prepare(
      `SELECT f.end_confidence, af.name AS dest_name
       FROM flights f LEFT JOIN airfields af ON af.id = f.dest_airfield_id WHERE f.id = ?`
    )
    .get(flightId) as { end_confidence: string | null; dest_name: string | null } | undefined;
  const { label } = aircraftLabel(db, aircraftId);
  if (flight?.end_confidence === 'confirmed' || flight?.end_confidence === 'assumed') {
    const at = flight.dest_name ? ` AT ${flight.dest_name.toUpperCase()}` : '';
    writeTickerEvent(db, aircraftId, `${label} HAS LANDED${at}`);
  }
  // The flight is over — retire its next-flight notes.
  db.prepare(
    `UPDATE annotations SET status = 'done'
     WHERE aircraft_id = ? AND mode = 'next_flight' AND (flight_id = ? OR status = 'active')`
  ).run(aircraftId, flightId);
}

export interface TickerItem {
  ts: number;
  text: string;
}

// The kiosk ticker: recent departures/landings plus standing notes.
export function tickerItems(db: Database, now = Date.now()): TickerItem[] {
  const events = db
    .prepare('SELECT ts, text FROM ticker_events WHERE ts > ? ORDER BY ts DESC LIMIT 20')
    .all(now - 6 * 3600 * 1000) as TickerItem[];

  const notes = db
    .prepare(
      `SELECT an.created_at AS ts, an.text, an.mode, an.status, a.registration, a.callsign
       FROM annotations an JOIN aircraft a ON a.id = an.aircraft_id
       WHERE (an.mode = 'until' AND an.until_ts > ? AND an.status != 'done')
          OR (an.mode = 'next_flight' AND an.status = 'pending')
       ORDER BY an.created_at DESC LIMIT 10`
    )
    .all(now) as { ts: number; text: string; mode: string; status: string; registration: string; callsign: string }[];

  const noteItems = notes.map((n) => ({
    ts: n.ts,
    text: `${n.callsign || n.registration}${n.mode === 'next_flight' ? ' NEXT FLIGHT' : ''} — ${n.text.toUpperCase()}`,
  }));

  return [...noteItems, ...events].sort((a, b) => b.ts - a.ts).slice(0, 24);
}

export function pruneTicker(db: Database): void {
  db.prepare('DELETE FROM ticker_events WHERE ts < ?').run(Date.now() - 7 * 24 * 3600 * 1000);
  db.prepare("UPDATE annotations SET status = 'done' WHERE mode = 'until' AND until_ts < ?").run(Date.now());
}
