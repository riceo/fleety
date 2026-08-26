import { describe, expect, it } from 'vitest';
import { openTestDb } from './db/index.js';
import { activeNotes, onLanding, onTakeoff, tickerItems } from './annotations.js';

function setup() {
  const db = openTestDb();
  const now = Date.now();
  const aircraftId = Number(
    db
      .prepare(
        "INSERT INTO aircraft (hex, registration, callsign, created_at, updated_at) VALUES ('402217','G-KAIR','INV08', ?, ?)"
      )
      .run(now, now).lastInsertRowid
  );
  const airfieldId = Number(
    db
      .prepare("INSERT INTO airfields (code, name, lat, lon, elevation_ft) VALUES ('EGTO','Rochester',51.35,0.5,436)")
      .run().lastInsertRowid
  );
  const flightId = Number(
    db
      .prepare('INSERT INTO flights (aircraft_id, started_at, origin_airfield_id, created_at) VALUES (?, ?, ?, ?)')
      .run(aircraftId, now, airfieldId, now).lastInsertRowid
  );
  return { db, aircraftId, flightId };
}

describe('kiosk annotations', () => {
  it('arms a next-flight note at take-off and clears it at landing', () => {
    const { db, aircraftId, flightId } = setup();
    db.prepare(
      "INSERT INTO annotations (aircraft_id, text, mode, status, created_at) VALUES (?, 'PAX: Bob and Jess experience', 'next_flight', 'pending', ?)"
    ).run(aircraftId, Date.now());

    expect(activeNotes(db).get(aircraftId)).toBe('PAX: Bob and Jess experience');

    onTakeoff(db, flightId, aircraftId);
    const ticker = tickerItems(db);
    expect(ticker.some((t) => t.text.includes('INV08 HAS TAKEN OFF FROM ROCHESTER'))).toBe(true);
    expect(ticker.some((t) => t.text.includes('PAX: BOB AND JESS EXPERIENCE'))).toBe(true);
    expect(activeNotes(db).get(aircraftId)).toBe('PAX: Bob and Jess experience');

    db.prepare("UPDATE flights SET ended_at = ?, end_confidence = 'confirmed', dest_airfield_id = 1 WHERE id = ?").run(
      Date.now(),
      flightId
    );
    onLanding(db, flightId, aircraftId);
    expect(activeNotes(db).get(aircraftId)).toBeUndefined();
    expect(tickerItems(db).some((t) => t.text.includes('INV08 HAS LANDED AT ROCHESTER'))).toBe(true);
  });

  it('timed notes expire on their own', () => {
    const { db, aircraftId } = setup();
    db.prepare(
      "INSERT INTO annotations (aircraft_id, text, mode, until_ts, status, created_at) VALUES (?, 'Fly-in weekend!', 'until', ?, 'pending', ?)"
    ).run(aircraftId, Date.now() + 60_000, Date.now());
    expect(activeNotes(db).get(aircraftId)).toBe('Fly-in weekend!');
    expect(activeNotes(db, Date.now() + 120_000).get(aircraftId)).toBeUndefined();
  });
});
