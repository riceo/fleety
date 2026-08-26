import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'fv_session';
const USER_SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days
const KIOSK_SESSION_MS = 365 * 24 * 3600 * 1000; // kiosk TVs should not need re-auth

export interface AuthContext {
  kind: 'user' | 'kiosk';
  userId: number | null;
  username: string;
  role: 'member' | 'admin' | null;
  mustChangePassword: boolean;
}

// Only a SHA-256 of the token is stored, so a leaked db copy can't be replayed.
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(db: Database, kind: 'user' | 'kiosk', userId: number | null): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = kind === 'kiosk' ? KIOSK_SESSION_MS : USER_SESSION_MS;
  db.prepare('INSERT INTO sessions (id, user_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    tokenHash(token),
    userId,
    kind,
    now,
    now + ttl
  );
  return token;
}

export function resolveSession(db: Database, token: string | undefined): AuthContext | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.kind, s.user_id, s.expires_at, u.username, u.role, u.must_change_password
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(tokenHash(token)) as
    | {
        kind: 'user' | 'kiosk';
        user_id: number | null;
        expires_at: number;
        username: string | null;
        role: 'member' | 'admin' | null;
        must_change_password: number | null;
      }
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
    return null;
  }
  if (row.kind === 'user' && !row.user_id) return null;
  return {
    kind: row.kind,
    userId: row.user_id,
    username: row.username ?? '(kiosk)',
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
  };
}

export function destroySession(db: Database, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
}

export function destroyUserSessions(db: Database, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function destroyKioskSessions(db: Database): void {
  db.prepare("DELETE FROM sessions WHERE kind = 'kiosk'").run();
}

export function pruneExpiredSessions(db: Database): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}
