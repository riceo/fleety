import { describe, expect, it } from 'vitest';
import { openTestDb } from '../db/index.js';
import {
  consumeLoginToken,
  createLoginToken,
  createSession,
  destroyKioskSessions,
  destroySession,
  resolveSession,
  roleFor,
} from './sessions.js';

function setup() {
  const db = openTestDb();
  const now = Date.now();
  const clubId = Number(
    db.prepare("INSERT INTO clubs (slug, name, kiosk_token, created_at) VALUES ('test','Test','tok', ?)").run(now)
      .lastInsertRowid
  );
  const userId = Number(
    db
      .prepare("INSERT INTO users (username, email, password_hash, role, created_at) VALUES ('bob','bob@x.com','x','member', 0)")
      .run().lastInsertRowid
  );
  db.prepare("INSERT INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, 'member', ?)").run(
    userId,
    clubId,
    now
  );
  return { db, clubId, userId };
}

describe('sessions', () => {
  it('resolves user sessions with memberships, and destroys them', () => {
    const { db, clubId, userId } = setup();
    const token = createSession(db, 'user', userId);
    const auth = resolveSession(db, token);
    expect(auth?.kind).toBe('user');
    expect(auth?.email).toBe('bob@x.com');
    expect(roleFor(auth, clubId)).toBe('member');
    expect(roleFor(auth, clubId + 99)).toBeNull();
    destroySession(db, token);
    expect(resolveSession(db, token)).toBeNull();
  });

  it('platform admins get admin role everywhere', () => {
    const { db, clubId, userId } = setup();
    db.prepare('UPDATE users SET platform_admin = 1 WHERE id = ?').run(userId);
    const auth = resolveSession(db, createSession(db, 'user', userId));
    expect(roleFor(auth, clubId)).toBe('admin');
    expect(roleFor(auth, clubId + 99)).toBe('admin');
  });

  it('kiosk sessions are pinned to their club and revocable per club', () => {
    const { db, clubId } = setup();
    const token = createSession(db, 'kiosk', null, clubId);
    const auth = resolveSession(db, token);
    expect(auth?.kind).toBe('kiosk');
    expect(auth?.kioskClubId).toBe(clubId);
    destroyKioskSessions(db, clubId + 1); // other club: no effect
    expect(resolveSession(db, token)?.kind).toBe('kiosk');
    destroyKioskSessions(db, clubId);
    expect(resolveSession(db, token)).toBeNull();
  });

  it('login tokens are single-use and expire', () => {
    const { db, userId } = setup();
    const token = createLoginToken(db, userId, 'invite', null);
    expect(consumeLoginToken(db, token)?.userId).toBe(userId);
    expect(consumeLoginToken(db, token)).toBeNull(); // already used
    expect(consumeLoginToken(db, 'garbage')).toBeNull();
  });
});
