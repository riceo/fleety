import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'fv_session';
const USER_SESSION_MS = 30 * 24 * 3600 * 1000; // 30 days
const KIOSK_SESSION_MS = 365 * 24 * 3600 * 1000; // kiosk TVs should not need re-auth
const LOGIN_TOKEN_MS = 48 * 3600 * 1000;

export interface AuthContext {
  kind: 'user' | 'kiosk';
  userId: number | null;
  username: string;
  email: string | null;
  platformAdmin: boolean;
  mustChangePassword: boolean;
  kioskClubId: number | null; // kiosk sessions are pinned to one club
  memberships: Map<number, 'member' | 'admin'>; // clubId -> role
}

// Only a SHA-256 of tokens is stored, so a leaked db copy can't be replayed.
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createSession(
  db: Database,
  kind: 'user' | 'kiosk',
  userId: number | null,
  clubId: number | null = null
): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const ttl = kind === 'kiosk' ? KIOSK_SESSION_MS : USER_SESSION_MS;
  db.prepare(
    'INSERT INTO sessions (id, user_id, kind, club_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(tokenHash(token), userId, kind, clubId, now, now + ttl);
  return token;
}

export function resolveSession(db: Database, token: string | undefined): AuthContext | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.kind, s.user_id, s.club_id, s.expires_at,
              u.username, u.email, u.platform_admin, u.must_change_password
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(tokenHash(token)) as
    | {
        kind: 'user' | 'kiosk';
        user_id: number | null;
        club_id: number | null;
        expires_at: number;
        username: string | null;
        email: string | null;
        platform_admin: number | null;
        must_change_password: number | null;
      }
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
    return null;
  }
  if (row.kind === 'user' && !row.user_id) return null;

  const memberships = new Map<number, 'member' | 'admin'>();
  if (row.user_id) {
    for (const m of db
      .prepare('SELECT club_id, role FROM memberships WHERE user_id = ?')
      .all(row.user_id) as { club_id: number; role: 'member' | 'admin' }[]) {
      memberships.set(m.club_id, m.role);
    }
  }

  return {
    kind: row.kind,
    userId: row.user_id,
    username: row.username ?? '(kiosk)',
    email: row.email,
    platformAdmin: row.platform_admin === 1,
    mustChangePassword: row.must_change_password === 1,
    kioskClubId: row.kind === 'kiosk' ? row.club_id : null,
    memberships,
  };
}

export function roleFor(auth: AuthContext | null, clubId: number): 'member' | 'admin' | null {
  if (!auth || auth.kind !== 'user') return null;
  if (auth.platformAdmin) return 'admin';
  return auth.memberships.get(clubId) ?? null;
}

export function destroySession(db: Database, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash(token));
}

export function destroyUserSessions(db: Database, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function destroyKioskSessions(db: Database, clubId: number): void {
  db.prepare("DELETE FROM sessions WHERE kind = 'kiosk' AND club_id = ?").run(clubId);
}

export function pruneExpiredSessions(db: Database): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').run(Date.now() - 24 * 3600 * 1000);
}

// ---- invite / password-reset tokens ----

export function createLoginToken(
  db: Database,
  userId: number,
  purpose: 'invite' | 'reset',
  clubId: number | null
): string {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO login_tokens (id, user_id, purpose, club_id, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    tokenHash(token),
    userId,
    purpose,
    clubId,
    Date.now() + LOGIN_TOKEN_MS
  );
  return token;
}

export function consumeLoginToken(db: Database, token: string): { userId: number; purpose: string } | null {
  const row = db
    .prepare('SELECT user_id, purpose, expires_at, used_at FROM login_tokens WHERE id = ?')
    .get(tokenHash(token)) as { user_id: number; purpose: string; expires_at: number; used_at: number | null } | undefined;
  if (!row || row.used_at !== null || row.expires_at < Date.now()) return null;
  db.prepare('UPDATE login_tokens SET used_at = ? WHERE id = ?').run(Date.now(), tokenHash(token));
  return { userId: row.user_id, purpose: row.purpose };
}
