import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { openTestDb } from './db/index.js';
import { buildServer } from './server.js';
import { Settings } from './settings.js';
import { LiveBus } from './live/liveBus.js';
import { FlightDetector } from './tracking/flightDetector.js';
import { Poller } from './tracking/poller.js';
import { Clubs } from './clubs.js';
import { createSession } from './auth/sessions.js';
import { hashPassword } from './auth/passwords.js';

// Cross-tenant isolation: THE bug class a multi-club tracker cannot have.
// Two clubs, one user in each, plus a members-only aircraft per club — no
// request on club A's host may ever see club B's data.

const HOST_A = { host: 'alpha.fleety.live' };
const HOST_B = { host: 'bravo.fleety.live' };

interface World {
  db: Database;
  app: FastifyInstance;
  clubs: Clubs;
  clubA: number;
  clubB: number;
  aircraftA: number;
  aircraftB: number;
  cookieAdminA: string;
  cookieMemberB: string;
  kioskCookieA: string;
}

async function build(): Promise<World> {
  const db = openTestDb();
  const now = Date.now();
  const mkClub = (slug: string) =>
    Number(
      db
        .prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES (?, ?, ?, ?)")
        .run(slug, slug.toUpperCase(), `kiosk-${slug}-token-000000`, now).lastInsertRowid
    );
  // NB: migration 5 already seeds the founding 'invicta' club, which also
  // serves as the DEFAULT_CLUB target for the localhost-fallback assertion.
  const clubA = mkClub('alpha');
  const clubB = mkClub('bravo');

  const mkAircraft = (club: number, hex: string, reg: string, visibility: string) =>
    Number(
      db
        .prepare(
          'INSERT INTO aircraft (club_id, hex, registration, callsign, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(club, hex, reg, '', visibility, now, now).lastInsertRowid
    );
  const aircraftA = mkAircraft(clubA, 'aaaaaa', 'G-AAAA', 'members');
  const aircraftB = mkAircraft(clubB, 'bbbbbb', 'G-BBBB', 'members');

  const hash = await hashPassword('password-123');
  const mkUser = (email: string, club: number, role: string) => {
    const id = Number(
      db
        .prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES (?, ?, ?, 'member', ?)")
        .run(email.split('@')[0], email, hash, now).lastInsertRowid
    );
    db.prepare('INSERT INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, ?, ?)').run(id, club, role, now);
    return id;
  };
  const adminA = mkUser('admin@alpha.club', clubA, 'admin');
  const memberB = mkUser('member@bravo.club', clubB, 'member');

  const settings = new Settings(db);
  const live = new LiveBus();
  const clubs = new Clubs(db);
  const detector = new FlightDetector(db);
  const poller = new Poller(db, { name: 'test', fetchPositions: async () => [] }, settings, detector, live);
  const app = await buildServer({ db, settings, live, poller, detector, clubs, webDist: '/tmp' });

  return {
    db,
    app,
    clubs,
    clubA,
    clubB,
    aircraftA,
    aircraftB,
    cookieAdminA: `fv_session=${createSession(db, 'user', adminA)}`,
    cookieMemberB: `fv_session=${createSession(db, 'user', memberB)}`,
    kioskCookieA: `fv_session=${createSession(db, 'kiosk', null, clubA)}`,
  };
}

describe('tenant isolation', () => {
  let w: World;
  beforeEach(async () => {
    w = await build();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('resolves the club from the subdomain', async () => {
    const res = await w.app.inject({ url: '/api/config', headers: HOST_A });
    expect(res.json().siteName).toBe('ALPHA');
    const resB = await w.app.inject({ url: '/api/config', headers: HOST_B });
    expect(resB.json().siteName).toBe('BRAVO');
  });

  it('the apex and unknown base-domain subdomains get the platform landing, never a club', async () => {
    const apex = await w.app.inject({ url: '/api/config', headers: { host: 'fleety.live' } });
    expect(apex.json().platform).toBe(true);
    const www = await w.app.inject({ url: '/api/config', headers: { host: 'www.fleety.live' } });
    expect(www.json().platform).toBe(true);
    const unknown = await w.app.inject({ url: '/api/config', headers: { host: 'nosuchclub.fleety.live' } });
    expect(unknown.json().platform).toBe(true);
    // Off-domain hosts (local dev) still fall back to the default club.
    const local = await w.app.inject({ url: '/api/config', headers: { host: 'localhost:8080' } });
    expect(local.json().clubSlug).toBe('invicta');
  });

  it("a member of club B cannot view club A's data", async () => {
    const res = await w.app.inject({ url: '/api/aircraft', headers: { ...HOST_A, cookie: w.cookieMemberB } });
    expect(res.statusCode).toBe(401); // not a member, club A is private
    const state = await w.app.inject({ url: '/api/state', headers: { ...HOST_A, cookie: w.cookieMemberB } });
    expect(state.statusCode).toBe(401);
  });

  it('a public club exposes only public-visibility aircraft to anonymous viewers', async () => {
    w.db.prepare('UPDATE clubs SET public_mode = 1 WHERE id = ?').run(w.clubA);
    w.db
      .prepare("INSERT INTO aircraft (club_id, hex, registration, visibility, created_at, updated_at) VALUES (?, 'cccccc', 'G-PUBL', 'public', 0, 0)")
      .run(w.clubA);
    w.clubs.reload();
    const res = await w.app.inject({ url: '/api/aircraft', headers: HOST_A });
    expect(res.statusCode).toBe(200);
    const regs = (res.json().aircraft as { registration: string }[]).map((a) => a.registration);
    expect(regs).toContain('G-PUBL');
    expect(regs).not.toContain('G-AAAA'); // members-only stays hidden
    expect(regs).not.toContain('G-BBBB'); // other club stays invisible
  });

  it("club A's admin cannot read or edit club B's aircraft", async () => {
    const list = await w.app.inject({ url: '/api/admin/aircraft', headers: { ...HOST_A, cookie: w.cookieAdminA } });
    expect(list.statusCode).toBe(200);
    const regs = (list.json().aircraft as { registration: string }[]).map((a) => a.registration);
    expect(regs).toContain('G-AAAA');
    expect(regs).not.toContain('G-BBBB');

    const edit = await w.app.inject({
      method: 'PUT',
      url: `/api/admin/aircraft/${w.aircraftB}`,
      headers: { ...HOST_A, cookie: w.cookieAdminA, 'x-fleetview': '1', 'content-type': 'application/json' },
      payload: { hex: 'bbbbbb', registration: 'HIJACK' },
    });
    expect(edit.statusCode).toBe(404);

    // Nor via their own host with B's id — ownership is checked, not just auth.
    const del = await w.app.inject({
      method: 'DELETE',
      url: `/api/admin/aircraft/${w.aircraftB}`,
      headers: { ...HOST_A, cookie: w.cookieAdminA, 'x-fleetview': '1' },
    });
    expect(del.statusCode).toBe(404);
  });

  it("club A's admin has no admin rights on club B's host", async () => {
    const res = await w.app.inject({ url: '/api/admin/aircraft', headers: { ...HOST_B, cookie: w.cookieAdminA } });
    expect(res.statusCode).toBe(403);
  });

  it("a kiosk session for club A does not work on club B", async () => {
    const ok = await w.app.inject({ url: '/api/state', headers: { ...HOST_A, cookie: w.kioskCookieA } });
    expect(ok.statusCode).toBe(200);
    const denied = await w.app.inject({ url: '/api/state', headers: { ...HOST_B, cookie: w.kioskCookieA } });
    expect(denied.statusCode).toBe(401);
  });

  it('login works by email and reports per-club role', async () => {
    const login = await w.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { ...HOST_A, 'x-fleetview': '1', 'content-type': 'application/json' },
      payload: { email: 'admin@alpha.club', password: 'password-123' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers['set-cookie'] as string;
    const meA = await w.app.inject({ url: '/api/me', headers: { ...HOST_A, cookie } });
    expect(meA.json().user.role).toBe('admin');
    const meB = await w.app.inject({ url: '/api/me', headers: { ...HOST_B, cookie } });
    expect(meB.json().user.role).toBeNull();
  });

  it('platform admin flag is manageable but the last one is protected', async () => {
    const adminId = (w.db.prepare("SELECT id FROM users WHERE email='admin@alpha.club'").get() as { id: number }).id;
    const memberId = (w.db.prepare("SELECT id FROM users WHERE email='member@bravo.club'").get() as { id: number }).id;

    // A club admin without the flag cannot touch platform users.
    const denied = await w.app.inject({
      method: 'PUT',
      url: `/api/platform/users/${memberId}`,
      headers: { ...HOST_A, cookie: w.cookieAdminA, 'x-fleetview': '1', 'content-type': 'application/json' },
      payload: { platformAdmin: true },
    });
    expect(denied.statusCode).toBe(403);

    w.db.prepare('UPDATE users SET platform_admin = 1 WHERE id = ?').run(adminId);
    const cookie = `fv_session=${createSession(w.db, 'user', adminId)}`;
    const headers = { ...HOST_A, cookie, 'x-fleetview': '1', 'content-type': 'application/json' };

    const grant = await w.app.inject({
      method: 'PUT',
      url: `/api/platform/users/${memberId}`,
      headers,
      payload: { platformAdmin: true },
    });
    expect(grant.statusCode).toBe(200);

    const revokeOther = await w.app.inject({
      method: 'PUT',
      url: `/api/platform/users/${memberId}`,
      headers,
      payload: { platformAdmin: false },
    });
    expect(revokeOther.statusCode).toBe(200);

    // Now the only platform admin cannot demote themselves.
    const revokeSelf = await w.app.inject({
      method: 'PUT',
      url: `/api/platform/users/${adminId}`,
      headers,
      payload: { platformAdmin: false },
    });
    expect(revokeSelf.statusCode).toBe(400);
  });

  it('platform admins can create clubs; club admins cannot', async () => {
    const denied = await w.app.inject({
      method: 'POST',
      url: '/api/platform/clubs',
      headers: { ...HOST_A, cookie: w.cookieAdminA, 'x-fleetview': '1', 'content-type': 'application/json' },
      payload: { slug: 'charlie', name: 'Charlie Flyers' },
    });
    expect(denied.statusCode).toBe(403);

    w.db.prepare("UPDATE users SET platform_admin = 1 WHERE email = 'admin@alpha.club'").run();
    const cookie = `fv_session=${createSession(w.db, 'user', (w.db.prepare("SELECT id FROM users WHERE email='admin@alpha.club'").get() as { id: number }).id)}`;
    const ok = await w.app.inject({
      method: 'POST',
      url: '/api/platform/clubs',
      headers: { ...HOST_A, cookie, 'x-fleetview': '1', 'content-type': 'application/json' },
      payload: { slug: 'charlie', name: 'Charlie Flyers' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
