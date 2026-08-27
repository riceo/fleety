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

    const emitted: { text: string; aircraftId: number | null }[] = [];
    onTakeoff(db, flightId, aircraftId, (ev) => emitted.push(ev));
    const ticker = tickerItems(db, 'member');
    expect(ticker.some((t) => t.text.includes('INVICTA 08 HAS DEPARTED ROCHESTER!'))).toBe(true);
    expect(ticker.some((t) => t.text.includes('PAX: BOB AND JESS EXPERIENCE'))).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].aircraftId).toBe(aircraftId);
    expect(activeNotes(db).get(aircraftId)).toBe('PAX: Bob and Jess experience');

    db.prepare("UPDATE flights SET ended_at = ?, end_confidence = 'confirmed', dest_airfield_id = 1 WHERE id = ?").run(
      Date.now(),
      flightId
    );
    onLanding(db, flightId, aircraftId);
    expect(activeNotes(db).get(aircraftId)).toBeUndefined();
    expect(tickerItems(db, 'member').some((t) => t.text.includes('INVICTA 08 HAS LANDED AT ROCHESTER'))).toBe(true);
  });

  it('hides members-only aircraft from the restricted ticker and surfaces taglines', () => {
    const { db, aircraftId, flightId } = setup();
    db.prepare("UPDATE aircraft SET visibility = 'members', tagline = 'Aerobatic ship — where next?' WHERE id = ?").run(
      aircraftId
    );
    onTakeoff(db, flightId, aircraftId);
    expect(tickerItems(db, 'member').some((t) => t.text.includes('HAS DEPARTED'))).toBe(true);
    expect(tickerItems(db, 'restricted')).toHaveLength(0);
    expect(tickerItems(db, 'member').some((t) => t.text.includes('AEROBATIC SHIP — WHERE NEXT?'))).toBe(true);
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
