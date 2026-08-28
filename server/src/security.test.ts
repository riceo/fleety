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
