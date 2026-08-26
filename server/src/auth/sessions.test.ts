import { describe, expect, it } from 'vitest';
import { openTestDb } from '../db/index.js';
import { createSession, destroyKioskSessions, destroySession, resolveSession } from './sessions.js';

describe('sessions', () => {
  it('creates and resolves user sessions, and destroys them', () => {
    const db = openTestDb();
    const userId = Number(
      db
        .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES ('bob','x','member', 0)")
        .run().lastInsertRowid
    );
    const token = createSession(db, 'user', userId);
    const auth = resolveSession(db, token);
    expect(auth?.kind).toBe('user');
    expect(auth?.username).toBe('bob');
    expect(auth?.role).toBe('member');
    destroySession(db, token);
    expect(resolveSession(db, token)).toBeNull();
  });

  it('kiosk sessions resolve without a user and can be revoked in bulk', () => {
    const db = openTestDb();
    const token = createSession(db, 'kiosk', null);
    expect(resolveSession(db, token)?.kind).toBe('kiosk');
    destroyKioskSessions(db);
    expect(resolveSession(db, token)).toBeNull();
  });

  it('rejects unknown and garbage tokens', () => {
    const db = openTestDb();
    expect(resolveSession(db, undefined)).toBeNull();
    expect(resolveSession(db, 'nonsense')).toBeNull();
  });
});
