import { describe, expect, it } from 'vitest';
import { openTestDb } from './db/index.js';
import { activeNoteFor, onLanding, onTakeoff, postTickerMessage, tickerItems } from './annotations.js';

function setup() {
  const db = openTestDb();
  const now = Date.now();
  const clubId = Number(
    db
      .prepare(
        `INSERT INTO clubs (slug, name, kiosk_token, callsign_rules, created_at)
         VALUES ('test','Test Club','tok','[{"prefix":"INV","spoken":"INVICTA"}]', ?)`
      )
      .run(now).lastInsertRowid
  );
  const aircraftId = Number(
    db
      .prepare(
        "INSERT INTO aircraft (club_id, hex, registration, callsign, created_at, updated_at) VALUES (?, '402217','G-KAIR','INV08', ?, ?)"
      )
      .run(clubId, now, now).lastInsertRowid
  );
  const airfieldId = Number(
    db
      .prepare("INSERT INTO airfields (club_id, code, name, lat, lon, elevation_ft) VALUES (?, 'EGTO','Rochester',51.35,0.5,436)")
      .run(clubId).lastInsertRowid
  );
  const flightId = Number(
    db
      .prepare('INSERT INTO flights (aircraft_id, started_at, origin_airfield_id, created_at) VALUES (?, ?, ?, ?)')
      .run(aircraftId, now, airfieldId, now).lastInsertRowid
  );
  return { db, clubId, aircraftId, flightId };
}

describe('kiosk annotations', () => {
  it('arms a next-flight note at take-off and clears it at landing', () => {
    const { db, clubId, aircraftId, flightId } = setup();
    db.prepare(
      "INSERT INTO annotations (aircraft_id, text, mode, status, created_at) VALUES (?, 'PAX: Bob and Jess experience', 'next_flight', 'pending', ?)"
    ).run(aircraftId, Date.now());

    expect(activeNoteFor(db, aircraftId)).toBe('PAX: Bob and Jess experience');

    const emitted: { text: string; aircraftId: number | null; clubId: number }[] = [];
    onTakeoff(db, flightId, aircraftId, (ev) => emitted.push(ev));
    const ticker = tickerItems(db, clubId, 'member');
    expect(ticker.some((t) => t.text.includes('INVICTA 08 HAS DEPARTED ROCHESTER!'))).toBe(true);
    expect(ticker.some((t) => t.text.includes('PAX: BOB AND JESS EXPERIENCE'))).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].clubId).toBe(clubId);

    db.prepare("UPDATE flights SET ended_at = ?, end_confidence = 'confirmed', dest_airfield_id = 1 WHERE id = ?").run(
      Date.now(),
      flightId
    );
    onLanding(db, flightId, aircraftId);
    expect(activeNoteFor(db, aircraftId)).toBeUndefined();
    expect(tickerItems(db, clubId, 'member').some((t) => t.text.includes('INVICTA 08 HAS LANDED AT ROCHESTER'))).toBe(true);
  });

  it('hides members-only aircraft from the restricted ticker and surfaces taglines', () => {
    const { db, clubId, aircraftId, flightId } = setup();
    db.prepare("UPDATE aircraft SET visibility = 'members', tagline = 'Aerobatic ship — where next?' WHERE id = ?").run(
      aircraftId
    );
    onTakeoff(db, flightId, aircraftId);
    expect(tickerItems(db, clubId, 'member').some((t) => t.text.includes('HAS DEPARTED'))).toBe(true);
    expect(tickerItems(db, clubId, 'restricted')).toHaveLength(0);
    expect(tickerItems(db, clubId, 'member').some((t) => t.text.includes('AEROBATIC SHIP — WHERE NEXT?'))).toBe(true);
  });

  it('custom broadcasts reach everyone but never leak into other clubs', () => {
    const { db, clubId } = setup();
    const otherClub = Number(
      db.prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES ('other','Other','tok2', ?)").run(Date.now())
        .lastInsertRowid
    );
    postTickerMessage(db, clubId, 'BBQ at the clubhouse Saturday!');
    expect(tickerItems(db, clubId, 'restricted').some((t) => t.text.includes('BBQ'))).toBe(true);
    expect(tickerItems(db, otherClub, 'member')).toHaveLength(0);
  });

  it('flight events age off the tape after 45 minutes; broadcasts last 6 hours', () => {
    const { db, clubId, aircraftId } = setup();
    const now = Date.now();
    db.prepare('INSERT INTO ticker_events (ts, club_id, aircraft_id, text) VALUES (?, ?, ?, ?)').run(
      now - 60 * 60_000,
      clubId,
      aircraftId,
      'INVICTA 08 HAS DEPARTED ROCHESTER!'
    );
    db.prepare('INSERT INTO ticker_events (ts, club_id, aircraft_id, text) VALUES (?, ?, NULL, ?)').run(
      now - 60 * 60_000,
      clubId,
      'BBQ Saturday!'
    );
    const items = tickerItems(db, clubId, 'member', now);
    expect(items.some((t) => t.text.includes('HAS DEPARTED'))).toBe(false);
    expect(items.some((t) => t.text.includes('BBQ Saturday!'))).toBe(true);
  });

  it('timed notes expire on their own', () => {
    const { db, aircraftId } = setup();
    db.prepare(
      "INSERT INTO annotations (aircraft_id, text, mode, until_ts, status, created_at) VALUES (?, 'Fly-in weekend!', 'until', ?, 'pending', ?)"
    ).run(aircraftId, Date.now() + 60_000, Date.now());
    expect(activeNoteFor(db, aircraftId)).toBe('Fly-in weekend!');
    expect(activeNoteFor(db, aircraftId, Date.now() + 120_000)).toBeUndefined();
  });
});
