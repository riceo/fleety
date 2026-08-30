import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestDb } from './db/index.js';
import { buildServer } from './server.js';
import { Settings } from './settings.js';
import { LiveBus } from './live/liveBus.js';
import { FlightDetector } from './tracking/flightDetector.js';
import { Poller } from './tracking/poller.js';
import { Clubs } from './clubs.js';
import { createSession } from './auth/sessions.js';
import { hashPassword } from './auth/passwords.js';
import { displayCallsignFor, escapeRegex } from './clubs.js';

const H = (host: string, cookie?: string) => ({
  host,
  'x-fleetview': '1',
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
});

interface World {
  db: Database;
  app: FastifyInstance;
  clubA: number;
  clubB: number;
  adminACookie: string;
}

async function build(): Promise<World> {
  const db = openTestDb();
  const now = Date.now();
  const mkClub = (slug: string) =>
    Number(
      db.prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES (?, ?, ?, ?)").run(slug, slug.toUpperCase(), `kiosk-${slug}-000000000000`, now).lastInsertRowid
    );
  const clubA = mkClub('alpha');
  const clubB = mkClub('bravo');
  const hash = await hashPassword('password-123');
  const mkUser = (email: string, platform = 0) =>
    Number(
      db
        .prepare("INSERT INTO users (username, email, password_hash, role, platform_admin, created_at) VALUES (?, ?, ?, 'member', ?, ?)")
        .run(email.split('@')[0], email, hash, platform, now).lastInsertRowid
    );
  const adminA = mkUser('admin@alpha.club');
  db.prepare("INSERT INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, 'admin', ?)").run(adminA, clubA, now);

  const settings = new Settings(db);
  const live = new LiveBus();
  const clubs = new Clubs(db);
  const detector = new FlightDetector(db);
  const poller = new Poller(db, [{ name: 'test', fetchStates: async () => ({ positions: [], presences: [] }) }], settings, detector, live);
  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'fleety-sec-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html><head><title>Fleety</title>\n<!--fleety:meta--><!--/fleety:meta-->\n</head><body></body></html>');
  const app = await buildServer({ db, settings, live, poller, detector, clubs, webDist });
  return { db, app, clubA, clubB, adminACookie: `fv_session=${createSession(db, 'user', adminA)}` };
}

describe('security fixes', () => {
  let w: World;
  beforeEach(async () => {
    w = await build();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('locks a specific account after repeated failures, regardless of source IP', async () => {
    const login = (password: string, xff: string) =>
      w.app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { ...H('alpha.fleety.live'), 'x-forwarded-for': xff },
        payload: { email: 'admin@alpha.club', password },
      });
    // 8 wrong passwords, each from a DIFFERENT spoofed IP (defeats per-IP only).
    for (let i = 0; i < 8; i++) {
      const r = await login('nope', `203.0.113.${i}`);
      expect(r.statusCode).toBe(401);
    }
    // The account is now locked even from a fresh IP and even with the RIGHT password.
    const locked = await login('password-123', '198.51.100.9');
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toEqual({ error: 'too_many_attempts' });
    // A different account is unaffected (per-account, not global).
    const other = await login('password-123', '198.51.100.9');
    expect(other.statusCode).toBe(429); // same locked account
    const freshAccount = await w.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: H('alpha.fleety.live'),
      payload: { email: 'someone-else@x.com', password: 'x' },
    });
    expect(freshAccount.statusCode).toBe(401); // not locked
  });

  it('refuses to delete or split a flight that is still in progress', async () => {
    const acId = Number(
      w.db
        .prepare("INSERT INTO aircraft (club_id, hex, registration, visibility, enabled, created_at, updated_at) VALUES (?, 'fl1234', 'G-FLY', 'public', 1, 0, 0)")
        .run(w.clubA).lastInsertRowid
    );
    const fId = Number(
      w.db
        .prepare('INSERT INTO flights (aircraft_id, started_at, ended_at, position_count, created_at) VALUES (?, 1000, NULL, 5, 0)')
        .run(acId).lastInsertRowid
    );
    const del = await w.app.inject({ method: 'DELETE', url: `/api/admin/flights/${fId}`, headers: H('alpha.fleety.live', w.adminACookie), payload: {} });
    expect(del.statusCode).toBe(409);
    const split = await w.app.inject({
      method: 'POST',
      url: `/api/admin/flights/${fId}/split`,
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { atTs: 1500 },
    });
    expect(split.statusCode).toBe(409);
  });

  it('escapeRegex neutralises metacharacters and displayCallsignFor never throws', () => {
    expect(escapeRegex('G-(')).toBe('G-\\(');
    // A malicious prefix must be matched literally, not compiled as a regex.
    expect(() => displayCallsignFor('INV01', [{ prefix: 'A(', spoken: 'X' }])).not.toThrow();
    expect(displayCallsignFor('G-( 5', [{ prefix: 'G-(', spoken: 'PITTS' }])).toBe('PITTS 5');
  });

  it('rejects callsign-rule prefixes containing regex metacharacters on save', async () => {
    const res = await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { callsignRules: [{ prefix: 'G-(', spoken: 'X' }, { prefix: 'INV', spoken: 'INVICTA' }] },
    });
    expect(res.statusCode).toBe(200);
    const rules = JSON.parse((res.json() as { club: { callsign_rules: string } }).club.callsign_rules);
    expect(rules).toEqual([{ prefix: 'INV', spoken: 'INVICTA' }]); // the metachar rule dropped
  });

  it('a password reset for a platform admin is never handed back to a club admin', async () => {
    // A platform admin who is also a member of the attacker's club.
    const victim = Number(
      w.db
        .prepare("INSERT INTO users (username, email, password_hash, role, platform_admin, created_at) VALUES ('v','v@x.com','h','member',1,0)")
        .run().lastInsertRowid
    );
    w.db.prepare("INSERT INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, 'member', 0)").run(victim, w.clubA);
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/admin/members/${victim}/reset`,
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { resetLink: string | null };
    expect(body.resetLink).toBeNull(); // no link, even though email isn't configured
  });

  it('inviting an already-active account does not mint a set-password link', async () => {
    // Existing account with a password set, member of another club.
    const other = Number(
      w.db
        .prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES ('o','o@x.com','realhash','member',0)")
        .run().lastInsertRowid
    );
    w.db.prepare("INSERT INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, 'member', 0)").run(other, w.clubB);
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/admin/members',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { email: 'o@x.com', role: 'member' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { inviteLink: string | null }).inviteLink).toBeNull();
    // But the membership is granted (the intended feature).
    const m = w.db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND club_id = ?').get(other, w.clubA);
    expect(m).toBeTruthy();
  });

  it('re-enabling a lapsed guest clears the past track-until so it is not auto-disabled again', async () => {
    const acId = Number(
      w.db
        .prepare("INSERT INTO aircraft (club_id, hex, registration, category, track_until, enabled, created_at, updated_at) VALUES (?, 'ggg555', 'G-GST', 'guest', '2000-01-01', 0, 0, 0)")
        .run(w.clubA).lastInsertRowid
    );
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/admin/aircraft/${acId}/enabled`,
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(200);
    const row = w.db.prepare('SELECT enabled, track_until FROM aircraft WHERE id = ?').get(acId) as { enabled: number; track_until: string | null };
    expect(row.enabled).toBe(1);
    expect(row.track_until).toBeNull(); // stale past date cleared so it sticks
  });

  it('the tracking toggle preserves the description', async () => {
    const acId = Number(
      w.db
        .prepare("INSERT INTO aircraft (club_id, hex, registration, description, enabled, created_at, updated_at) VALUES (?, 'abc123', 'G-TEST', '4-seat tourer', 1, 0, 0)")
        .run(w.clubA).lastInsertRowid
    );
    const res = await w.app.inject({
      method: 'POST',
      url: `/api/admin/aircraft/${acId}/enabled`,
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    const row = w.db.prepare('SELECT enabled, description FROM aircraft WHERE id = ?').get(acId) as { enabled: number; description: string };
    expect(row.enabled).toBe(0);
    expect(row.description).toBe('4-seat tourer'); // not wiped
  });

  it('the share card renders for a public aircraft but 404s for members-only / private', async () => {
    await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { publicMode: true },
    });
    w.db
      .prepare("INSERT INTO aircraft (club_id, hex, registration, callsign, visibility, enabled, created_at, updated_at) VALUES (?, 'ccc111', 'G-PUB', 'INV01', 'public', 1, 0, 0)")
      .run(w.clubA);
    w.db
      .prepare("INSERT INTO aircraft (club_id, hex, registration, visibility, enabled, created_at, updated_at) VALUES (?, 'ddd222', 'G-HID', 'members', 1, 0, 0)")
      .run(w.clubA);
    const pub = await w.app.inject({ method: 'GET', url: '/ac/G-PUB/og.jpg', headers: { host: 'alpha.fleety.live' } });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/jpeg');
    expect(pub.rawPayload.length).toBeGreaterThan(1000); // a real JPEG came back
    // Members-only aircraft: no card.
    const hid = await w.app.inject({ method: 'GET', url: '/ac/G-HID/og.jpg', headers: { host: 'alpha.fleety.live' } });
    expect(hid.statusCode).toBe(404);
    // Private club (bravo): no card even for a public aircraft.
    w.db
      .prepare("INSERT INTO aircraft (club_id, hex, registration, visibility, enabled, created_at, updated_at) VALUES (?, 'eee333', 'G-BRV', 'public', 1, 0, 0)")
      .run(w.clubB);
    const priv = await w.app.inject({ method: 'GET', url: '/ac/G-BRV/og.jpg', headers: { host: 'bravo.fleety.live' } });
    expect(priv.statusCode).toBe(404);
  });

  it('share card: evergreen bare URL vs live minute-bucketed ?s share', async () => {
    await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { publicMode: true },
    });
    w.db
      .prepare("INSERT INTO aircraft (club_id, hex, registration, callsign, visibility, enabled, created_at, updated_at) VALUES (?, 'fff444', 'G-EVR', 'INV01', 'public', 1, 0, 0)")
      .run(w.clubA);

    // Bare URL: durable card, modest edge TTL (revocation propagates in mins),
    // no ?s echoed into the image.
    const ever = await w.app.inject({ method: 'GET', url: '/ac/G-EVR/og.jpg', headers: { host: 'alpha.fleety.live' } });
    expect(ever.statusCode).toBe(200);
    expect(ever.headers['cache-control']).toContain('max-age=600');
    const everShell = await w.app.inject({ method: 'GET', url: '/ac/G-EVR', headers: { host: 'alpha.fleety.live' } });
    expect(everShell.body).toContain('/ac/G-EVR/og.jpg" '); // clean image URL, no ?s
    expect(everShell.body).toContain('Track it live'); // durable tail, no altitude

    // Share-button URL (?s=minute): live card, short cache, bucket echoed on.
    const live = await w.app.inject({ method: 'GET', url: '/ac/G-EVR/og.jpg?s=29160500', headers: { host: 'alpha.fleety.live' } });
    expect(live.statusCode).toBe(200);
    expect(live.headers['cache-control']).toContain('max-age=120');
    const liveShell = await w.app.inject({ method: 'GET', url: '/ac/G-EVR?s=29160500', headers: { host: 'alpha.fleety.live' } });
    expect(liveShell.body).toContain('/ac/G-EVR/og.jpg?s=29160500');

    // A junk ?s (non-numeric) is ignored — treated as the evergreen card.
    const junk = await w.app.inject({ method: 'GET', url: '/ac/G-EVR/og.jpg?s=evil', headers: { host: 'alpha.fleety.live' } });
    expect(junk.headers['cache-control']).toContain('max-age=600');
  });

  it('/uploads will not serve a members-only aircraft image to a public viewer, or another club file', async () => {
    // Public club A with one members-only aircraft whose photo is 'p.webp'.
    // Flip public mode through the API so the server's club cache reloads.
    await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { publicMode: true },
    });
    w.db
      .prepare("INSERT INTO aircraft (club_id, hex, registration, visibility, photo_path, enabled, created_at, updated_at) VALUES (?, 'aaa111', 'G-SEC', 'members', 'p.webp', 1, 0, 0)")
      .run(w.clubA);
    // Anonymous public viewer of club A cannot fetch the members-only photo.
    const r1 = await w.app.inject({ method: 'GET', url: '/uploads/p.webp', headers: { host: 'alpha.fleety.live' } });
    expect(r1.statusCode).toBe(404);
    // A file that belongs to no aircraft in this club is not served.
    const r2 = await w.app.inject({ method: 'GET', url: '/uploads/other.webp', headers: { host: 'alpha.fleety.live' } });
    expect(r2.statusCode).toBe(404);
  });
});

describe('club settings', () => {
  let w: World;
  beforeEach(async () => {
    w = await build();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('weather overlay defaults on, can be switched off by an admin, and reaches /api/config', async () => {
    const cfg = () => w.app.inject({ method: 'GET', url: '/api/config', headers: H('alpha.fleety.live') });
    expect((await cfg()).json().weatherLayer).toBe(true);

    const off = await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { weatherLayer: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { club: { weather_layer: number } }).club.weather_layer).toBe(0);
    expect((await cfg()).json().weatherLayer).toBe(false);

    // A save that doesn't mention the field leaves it alone.
    await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { name: 'ALPHA AERO' },
    });
    expect((await cfg()).json().weatherLayer).toBe(false);
  });
});

describe('club settings: other traffic', () => {
  let w: World;
  beforeEach(async () => {
    w = await build();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('defaults off, round-trips through admin settings, and reaches /api/config', async () => {
    const cfg = async () =>
      (await w.app.inject({ method: 'GET', url: '/api/config', headers: H('alpha.fleety.live') })).json() as {
        otherTraffic: { enabled: boolean; color: string; maxAltFt: number };
      };
    expect((await cfg()).otherTraffic).toEqual({ enabled: false, color: '#7d8db5', maxAltFt: 10000 });

    const on = await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { otherTraffic: { enabled: true, maxAltFt: 8000, radiusNm: 40, color: '#22ccff' } },
    });
    expect(on.statusCode).toBe(200);
    const stored = JSON.parse((on.json() as { club: { other_traffic: string } }).club.other_traffic);
    expect(stored).toEqual({ enabled: true, maxAltFt: 8000, radiusNm: 40, color: '#22ccff' });
    expect((await cfg()).otherTraffic).toEqual({ enabled: true, color: '#22ccff', maxAltFt: 8000 });

    // A save that doesn't mention the field leaves it alone.
    await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { name: 'ALPHA AERO' },
    });
    expect((await cfg()).otherTraffic.enabled).toBe(true);
  });

  it('clamps out-of-range numbers and rejects a non-hex colour', async () => {
    const r = await w.app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: H('alpha.fleety.live', w.adminACookie),
      payload: { otherTraffic: { enabled: true, maxAltFt: 999999, radiusNm: 1, color: 'url(javascript:x)' } },
    });
    expect(r.statusCode).toBe(200);
    const stored = JSON.parse((r.json() as { club: { other_traffic: string } }).club.other_traffic);
    expect(stored).toEqual({ enabled: true, maxAltFt: 60000, radiusNm: 5, color: '#7d8db5' });
  });
});
