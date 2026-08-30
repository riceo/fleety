import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { clubUrl, config, uploadsDir } from './config.js';
import type { Settings } from './settings.js';
import type { LiveBus, Audience } from './live/liveBus.js';
import type { Poller } from './tracking/poller.js';
import type { FlightDetector } from './tracking/flightDetector.js';
import { recomputeFlightStats } from './tracking/flightStats.js';
import { lookupByRegistration } from './enrichment/lookup.js';
import { hashPassword, verifyPassword } from './auth/passwords.js';
import {
  SESSION_COOKIE,
  type AuthContext,
  consumeLoginToken,
  createLoginToken,
  createSession,
  destroyKioskSessions,
  destroySession,
  destroyUserSessions,
  resolveSession,
  roleFor,
} from './auth/sessions.js';
import { dbFileSizeBytes } from './db/index.js';
import { postTickerMessage, tickerItems, type TickerEmit } from './annotations.js';
import { Clubs, displayCallsignFor, otherTrafficPrefs, type ClubRow } from './clubs.js';
import { emailConfigured, sendInviteEmail, sendResetEmail, sendWaitlistNotification } from './email.js';
import { renderAircraftOgCard } from './og.js';
import { collectMetrics } from './metrics.js';
import { escapeHtml } from './escape.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    club: ClubRow | null;
  }
}

export interface ServerDeps {
  db: Database;
  settings: Settings;
  live: LiveBus;
  poller: Poller;
  detector: FlightDetector;
  clubs: Clubs;
  webDist: string;
}

const THEMES = new Set(['ops', 'terminal', 'heritage', 'daylight']);

// Defense-in-depth. Locked where it costs nothing (no external scripts beyond
// PostHog, no framing, no <base>/object/form hijack); permissive on connect/img
// so admin-configurable map tiles, Google Fonts and PostHog keep working.
// 'unsafe-inline' script is the pragmatic concession for the inline PostHog
// bootstrap — escaping is the primary XSS defense, this is the backstop.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://eu.i.posthog.com https://eu-assets.i.posthog.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ');

const isHttpUrl = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const isValidTimezone = (v: unknown): boolean => {
  if (typeof v !== 'string' || !v) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: v });
    return true;
  } catch {
    return false;
  }
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, settings, live, poller, detector, clubs } = deps;
  const app = Fastify({
    // Strip the query string from logged request URLs so single-use invite/reset
    // tokens (?token=…) never land in stdout/Docker logs.
    logger: {
      serializers: {
        req: (req) => ({ method: req.method, url: (req.url || '').split('?')[0], host: req.headers?.host }),
      },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false,
    // Key on Cloudflare's authoritative client IP when present (unspoofable
    // once the origin is locked to Cloudflare), else the proxy-derived req.ip.
    keyGenerator: (req) => {
      const cf = req.headers['cf-connecting-ip'];
      const ip = typeof cf === 'string' && cf ? cf : req.ip;
      return ip;
    },
  });

  // Per-ACCOUNT login throttle — independent of IP, so it holds even if the
  // per-IP limiter is defeated by header spoofing on a directly-reachable
  // origin. After too many failures for one email, that account is briefly
  // locked regardless of source address.
  const loginFails = new Map<string, { count: number; windowUntil: number; lockUntil: number }>();
  const LOGIN_MAX_FAILS = 8;
  const LOGIN_WINDOW_MS = 15 * 60_000; // failures counted within this window
  const LOGIN_LOCK_MS = 15 * 60_000; // lock duration once the count is hit
  const accountLocked = (email: string): boolean => {
    const e = loginFails.get(email.toLowerCase());
    return !!e && e.lockUntil > Date.now();
  };
  const noteLoginFail = (email: string): void => {
    const key = email.toLowerCase();
    const now = Date.now();
    let e = loginFails.get(key);
    if (!e || e.windowUntil <= now) e = { count: 0, windowUntil: now + LOGIN_WINDOW_MS, lockUntil: 0 };
    e.count++;
    if (e.count >= LOGIN_MAX_FAILS) e.lockUntil = now + LOGIN_LOCK_MS;
    loginFails.set(key, e);
    if (loginFails.size > 5000) for (const [k, v] of loginFails) if (v.windowUntil <= now && v.lockUntil <= now) loginFails.delete(k);
  };
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  const emitTicker: TickerEmit = (ev) => live.broadcastTicker(ev.clubId, ev);

  const audit = (req: FastifyRequest, action: string, detail = '') => {
    db.prepare(
      'INSERT INTO audit_log (ts, user_id, username, action, detail, club_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(Date.now(), req.auth?.userId ?? null, req.auth?.email ?? req.auth?.username ?? '', action, detail, req.club?.id ?? null);
  };

  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: config.secureCookies,
      sameSite: 'lax',
      maxAge: 365 * 24 * 3600,
    });
  };

  app.addHook('onRequest', async (req, reply) => {
    req.auth = resolveSession(db, req.cookies[SESSION_COOKIE]);
    // Tenant resolution: club subdomains resolve to their club; the apex and
    // unknown *.baseDomain hosts get the platform landing (club = null); only
    // hosts outside the base domain (localhost/dev) fall back to DEFAULT_CLUB.
    req.club =
      clubs.fromHost(req.headers.host) ??
      (clubs.isBaseHost(req.headers.host) ? null : (clubs.slug(config.defaultClubSlug) ?? null));
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-fleetview'] !== '1') {
        return reply.code(403).send({ error: 'missing_csrf_header' });
      }
      if (
        req.auth?.kind === 'user' &&
        req.auth.mustChangePassword &&
        !['/api/me', '/api/change-password', '/api/logout', '/api/config'].includes(req.url.split('?')[0])
      ) {
        return reply.code(403).send({ error: 'password_change_required' });
      }
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', CSP);
  });

  // ---------- access helpers ----------

  const clubOf = (req: FastifyRequest, reply: FastifyReply): ClubRow | null => {
    if (req.club) return req.club;
    reply.code(404).send({ error: 'unknown_club' });
    return null;
  };
  const isKioskFor = (req: FastifyRequest, club: ClubRow): boolean =>
    req.auth?.kind === 'kiosk' && req.auth.kioskClubId === club.id;
  const memberRole = (req: FastifyRequest, club: ClubRow) => roleFor(req.auth, club.id);
  const audienceOf = (req: FastifyRequest, club: ClubRow): Audience =>
    memberRole(req, club) ? 'member' : 'restricted';

  // Live views: members, this club's kiosk, or anyone when the club is public.
  const requireViewer = (req: FastifyRequest, reply: FastifyReply, club: ClubRow): boolean => {
    if (memberRole(req, club) || isKioskFor(req, club) || club.public_mode === 1) return true;
    reply.code(401).send({ error: 'auth_required' });
    return false;
  };
  // History views: members or public mode — the kiosk token is live-view only.
  const requireMemberView = (req: FastifyRequest, reply: FastifyReply, club: ClubRow): boolean => {
    if (memberRole(req, club) || club.public_mode === 1) return true;
    reply.code(401).send({ error: 'auth_required' });
    return false;
  };
  const requireClubAdmin = (req: FastifyRequest, reply: FastifyReply, club: ClubRow): boolean => {
    if (memberRole(req, club) === 'admin') return true;
    reply.code(403).send({ error: 'admin_required' });
    return false;
  };
  const requirePlatform = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.auth?.kind === 'user' && req.auth.platformAdmin) return true;
    reply.code(403).send({ error: 'platform_admin_required' });
    return false;
  };

  const kioskPrefs = (club: ClubRow): { viewMode?: string } => {
    try {
      return JSON.parse(club.kiosk_prefs || '{}') as { viewMode?: string };
    } catch {
      return {};
    }
  };

  // Ownership guard: the aircraft must belong to the request's club.
  const clubAircraft = (club: ClubRow, id: number) =>
    db.prepare('SELECT * FROM aircraft WHERE id = ? AND club_id = ? AND deleted_at IS NULL').get(id, club.id) as
      | Record<string, unknown>
      | undefined;
  const clubFlight = (club: ClubRow, id: number) =>
    db
      .prepare('SELECT f.* FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE f.id = ? AND a.club_id = ?')
      .get(id, club.id) as { id: number; aircraft_id: number; ended_at: number | null; end_confidence: string | null } | undefined;

  // ---------- auth ----------

  app.post(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
      if (!email || !password) return reply.code(400).send({ error: 'missing_credentials' });
      // Per-account lock: defeats brute-force against a known email even when
      // the attacker rotates source IPs.
      if (accountLocked(email)) return reply.code(429).send({ error: 'too_many_attempts' });
      // Email is the identity; username matching keeps pre-Fleety logins alive.
      const user = db
        .prepare(
          'SELECT id, username, email, password_hash, must_change_password FROM users WHERE email = ? OR username = ?'
        )
        .get(email, email) as
        | { id: number; username: string; email: string | null; password_hash: string; must_change_password: number }
        | undefined;
      const ok = user && user.password_hash ? await verifyPassword(user.password_hash, password) : false;
      if (!user || !ok) {
        // Spend the same argon2 time whether the account is missing OR exists
        // but has no password set (invited, never activated) — otherwise the
        // faster path leaks which emails are pending-activation accounts.
        if (!user || !user.password_hash) await hashPassword(password).catch(() => {});
        noteLoginFail(email);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      loginFails.delete(email.toLowerCase()); // success clears the account's failure count
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
      const token = createSession(db, 'user', user.id);
      setSessionCookie(reply, token);
      return { ok: true, mustChangePassword: user.must_change_password === 1 };
    }
  );

  app.post('/api/logout', async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const club = req.club;
    return {
      user:
        req.auth?.kind === 'user'
          ? {
              username: req.auth.username,
              email: req.auth.email,
              platformAdmin: req.auth.platformAdmin,
              mustChangePassword: req.auth.mustChangePassword,
              role: club ? roleFor(req.auth, club.id) : null,
            }
          : null,
      kiosk: club ? isKioskFor(req, club) : false,
      publicMode: club ? club.public_mode === 1 : false,
    };
  });

  app.post('/api/change-password', async (req, reply) => {
    if (req.auth?.kind !== 'user') return reply.code(401).send({ error: 'auth_required' });
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    if (!current || !next || next.length < 8) return reply.code(400).send({ error: 'password_too_short' });
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.auth.userId) as
      | { password_hash: string }
      | undefined;
    if (!user || !(await verifyPassword(user.password_hash, current))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      await hashPassword(next),
      req.auth.userId
    );
    return { ok: true };
  });

  app.post(
    '/api/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req) => {
      const { email } = (req.body ?? {}) as { email?: string };
      // Always 200 — never confirm whether an email exists.
      if (email) {
        const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email) as
          | { id: number; email: string }
          | undefined;
        if (user?.email && emailConfigured()) {
          const token = createLoginToken(db, user.id, 'reset', req.club?.id ?? null);
          const link = `${clubUrl(req.club?.slug ?? config.defaultClubSlug)}/set-password?token=${token}`;
          void sendResetEmail(user.email, link);
        }
      }
      return { ok: true };
    }
  );

  app.post(
    '/api/set-password',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
      if (!token || !password || password.length < 8) return reply.code(400).send({ error: 'password_too_short' });
      const consumed = consumeLoginToken(db, token);
      if (!consumed) return reply.code(401).send({ error: 'invalid_token' });
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
        await hashPassword(password),
        consumed.userId
      );
      destroyUserSessions(db, consumed.userId);
      const session = createSession(db, 'user', consumed.userId);
      setSessionCookie(reply, session);
      return { ok: true };
    }
  );

  app.post(
    '/api/kiosk/exchange',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const club = clubOf(req, reply);
      if (!club) return;
      const { token } = (req.body ?? {}) as { token?: string };
      if (
        !token ||
        token.length !== club.kiosk_token.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(club.kiosk_token))
      ) {
        return reply.code(401).send({ error: 'invalid_kiosk_token' });
      }
      const session = createSession(db, 'kiosk', null, club.id);
      setSessionCookie(reply, session);
      return { ok: true };
    }
  );

  // ---------- club config + live data ----------

  app.get('/api/config', async (req) => {
    const club = req.club;
    if (!club) return { platform: true, siteName: 'Fleety' };
    return {
      platform: false,
      clubSlug: club.slug,
      siteName: club.name,
      subheading: club.subheading,
      theme: club.theme,
      accent: club.accent,
      tileStyleUrl: club.tile_style_url,
      mapCenter: club.map_center,
      mapZoom: club.map_zoom,
      publicMode: club.public_mode === 1,
      logoUrl: club.logo_path ? `/uploads/${club.logo_path}` : null,
      callsignRules: clubs.rules(club),
      kioskViewMode: kioskPrefs(club).viewMode === 'overview' ? 'overview' : 'target',
      timezone: club.timezone,
      weatherLayer: club.weather_layer === 1,
      otherTraffic: (() => {
        const p = otherTrafficPrefs(club);
        // radiusNm stays server-side (it shapes the upstream query, not the render).
        return { enabled: p.enabled, color: p.color, maxAltFt: p.maxAltFt };
      })(),
    };
  });

  // Public waitlist signup from the fleety.live landing page. Idempotent and
  // deliberately quiet about whether an email was already on the list; the
  // operator ping only fires for genuinely new rows.
  app.post(
    '/api/waitlist',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, marketing } = (req.body ?? {}) as { email?: string; marketing?: boolean };
      const clean = (email ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) || clean.length > 254) {
        return reply.code(400).send({ error: 'invalid_email' });
      }
      const existing = db.prepare('SELECT id FROM waitlist WHERE email = ?').get(clean) as
        | { id: number }
        | undefined;
      if (!existing) {
        db.prepare('INSERT INTO waitlist (email, marketing_opt_in, created_at, source) VALUES (?, ?, ?, ?)').run(
          clean,
          marketing ? 1 : 0,
          Date.now(),
          req.club?.slug ?? 'apex' // resolved slug, never the raw attacker-controlled Host
        );
        void sendWaitlistNotification(clean, !!marketing);
      } else if (marketing) {
        // Re-signup with the box ticked upgrades consent; never downgrades.
        db.prepare('UPDATE waitlist SET marketing_opt_in = 1 WHERE id = ?').run(existing.id);
      }
      return { ok: true };
    }
  );

  app.get('/api/state', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireViewer(req, reply, club)) return;
    reply.type('application/json');
    return live.snapshotPayload(club.id, audienceOf(req, club));
  });

  app.get('/api/events', (req, reply) => {
    const club = req.club;
    if (!club) return reply.code(404).send({ error: 'unknown_club' });
    if (!requireViewer(req, reply, club)) return;
    // Bound concurrent streams before hijacking, so a flood of EventSource
    // connections can't exhaust the single process.
    if (live.atCapacity(req.ip)) return reply.code(503).send({ error: 'at_capacity' });
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const lastIdHeader = req.headers['last-event-id'];
    const kiosk = isKioskFor(req, club);
    const authenticated = !!memberRole(req, club) || kiosk;
    const clientId = live.addClient(club.id, res, audienceOf(req, club), authenticated, {
      lastEventId: Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader,
      userId: req.auth?.kind === 'user' ? req.auth.userId : null,
      kiosk,
      ip: req.ip,
    });
    req.raw.on('close', () => live.removeClient(clientId));
  });

  app.get('/api/ticker', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireViewer(req, reply, club)) return;
    return { items: tickerItems(db, club.id, audienceOf(req, club)) };
  });

  app.get('/api/airfields', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireViewer(req, reply, club)) return;
    return {
      airfields: db
        .prepare('SELECT id, code, name, lat, lon, is_base FROM airfields WHERE club_id = ? ORDER BY is_base DESC, code')
        .all(club.id),
    };
  });

  // ---------- flights / history ----------

  const flightListSql = `
    SELECT f.*, a.registration, a.callsign AS expected_callsign, a.type_name, a.color,
           ao.code AS origin_code, ad.code AS dest_code
    FROM flights f
    JOIN aircraft a ON a.id = f.aircraft_id
    LEFT JOIN airfields ao ON ao.id = f.origin_airfield_id
    LEFT JOIN airfields ad ON ad.id = f.dest_airfield_id`;

  app.get('/api/flights', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireMemberView(req, reply, club)) return;
    const q = req.query as { aircraftId?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Number(q.offset) || 0;
    const visFilter = audienceOf(req, club) === 'member' ? '' : " AND a.visibility = 'public'";
    const acFilter = q.aircraftId ? ' AND f.aircraft_id = ?' : '';
    const params: unknown[] = q.aircraftId
      ? [club.id, Number(q.aircraftId), limit, offset]
      : [club.id, limit, offset];
    const rows = db
      .prepare(
        `${flightListSql} WHERE a.club_id = ? AND f.position_count > 2${visFilter}${acFilter}
         ORDER BY f.started_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params);
    return { flights: rows };
  });

  app.get('/api/flights/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireMemberView(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const visFilter = audienceOf(req, club) === 'member' ? '' : " AND a.visibility = 'public'";
    const row = db.prepare(`${flightListSql} WHERE f.id = ? AND a.club_id = ?${visFilter}`).get(id, club.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { flight: row };
  });

  app.get('/api/flights/:id/track', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireMemberView(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const check = db
      .prepare('SELECT a.visibility FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE f.id = ? AND a.club_id = ?')
      .get(id, club.id) as { visibility: string } | undefined;
    if (!check) return reply.code(404).send({ error: 'not_found' });
    if (audienceOf(req, club) !== 'member' && check.visibility !== 'public') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const points = db
      .prepare(
        'SELECT ts, lat, lon, alt_baro, alt_geom, gs, track FROM positions WHERE flight_id = ? ORDER BY ts LIMIT 50000'
      )
      .all(id) as { ts: number; lat: number; lon: number; alt_baro: number | null; alt_geom: number | null; gs: number | null; track: number | null }[];
    return { points: points.map((p) => [p.lon, p.lat, p.ts, p.alt_baro ?? p.alt_geom, p.gs, p.track]) };
  });

  app.get('/api/aircraft', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireMemberView(req, reply, club)) return;
    const visFilter = audienceOf(req, club) === 'member' ? '' : " AND visibility = 'public'";
    return {
      aircraft: db
        .prepare(
          `SELECT id, hex, registration, callsign, type_name, nickname, tagline, description, category, color, icon, icon_path, photo_path, enabled
           FROM aircraft WHERE club_id = ? AND deleted_at IS NULL${visFilter} ORDER BY sort_order, id`
        )
        .all(club.id),
    };
  });

  // ---------- uploads (served) ----------

  await app.register(fastifyStatic, {
    root: uploadsDir(),
    prefix: '/uploads/',
    decorateReply: true,
    serve: false,
  });

  app.get('/uploads/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) return reply.code(400).send({ error: 'bad_name' });
    const club = req.club;
    if (!club) return reply.code(404).send({ error: 'not_found' });
    // The club logo shows on the login screen, so it is always fetchable.
    if (file === club.logo_path) return reply.sendFile(file);
    if (!requireViewer(req, reply, club)) return;
    // Object-level authz: the file must belong to an aircraft in THIS club, and
    // a members-only aircraft's images are not served to a restricted audience.
    const owner = db
      .prepare(
        'SELECT visibility FROM aircraft WHERE club_id = ? AND deleted_at IS NULL AND (icon_path = ? OR photo_path = ?)'
      )
      .get(club.id, file, file) as { visibility: string } | undefined;
    if (!owner) return reply.code(404).send({ error: 'not_found' });
    if (owner.visibility !== 'public' && audienceOf(req, club) !== 'member') {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile(file);
  });

  // ---------- club admin ----------

  const aircraftBody = (body: Record<string, unknown>) => ({
    hex: String(body.hex ?? '').trim().toLowerCase(),
    registration: String(body.registration ?? '').trim().toUpperCase(),
    callsign: String(body.callsign ?? '').trim().toUpperCase(),
    type_name: String(body.typeName ?? '').trim(),
    icao_type: String(body.icaoType ?? '').trim().toUpperCase(),
    nickname: String(body.nickname ?? '').trim(),
    tagline: String(body.tagline ?? '').trim().slice(0, 160),
    description: String(body.description ?? '').trim().slice(0, 240),
    operator: String(body.operator ?? '').trim(),
    icon: String(body.icon ?? 'low-wing'),
    color: /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? String(body.color) : '#e32636',
    enabled: body.enabled === false ? 0 : 1,
    category: body.category === 'guest' ? 'guest' : 'fleet',
    visibility: body.visibility === 'members' ? 'members' : 'public',
    track_until: typeof body.trackUntil === 'string' && body.trackUntil ? body.trackUntil : null,
    sort_order: Number(body.sortOrder) || 0,
    notes: String(body.notes ?? ''),
  });

  app.get('/api/admin/aircraft', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return {
      aircraft: db
        .prepare('SELECT * FROM aircraft WHERE club_id = ? AND deleted_at IS NULL ORDER BY sort_order, id')
        .all(club.id),
    };
  });

  app.post('/api/admin/aircraft', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const a = aircraftBody(req.body as Record<string, unknown>);
    if (!/^[0-9a-f]{6}$/.test(a.hex)) return reply.code(400).send({ error: 'invalid_hex' });
    const now = Date.now();
    try {
      const res = db
        .prepare(
          `INSERT INTO aircraft (club_id, hex, registration, callsign, type_name, icao_type, nickname, tagline, description, operator, icon, color,
             enabled, category, visibility, track_until, sort_order, notes, created_at, updated_at)
           VALUES (@club_id, @hex, @registration, @callsign, @type_name, @icao_type, @nickname, @tagline, @description, @operator, @icon, @color,
             @enabled, @category, @visibility, @track_until, @sort_order, @notes, ${now}, ${now})`
        )
        .run({ ...a, club_id: club.id });
      audit(req, 'aircraft.create', `${a.registration} (${a.hex})`);
      return { id: Number(res.lastInsertRowid) };
    } catch (err) {
      if (String(err).includes('UNIQUE')) return reply.code(409).send({ error: 'hex_exists' });
      throw err;
    }
  });

  app.put('/api/admin/aircraft/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    if (!clubAircraft(club, id)) return reply.code(404).send({ error: 'not_found' });
    const a = aircraftBody(req.body as Record<string, unknown>);
    if (!/^[0-9a-f]{6}$/.test(a.hex)) return reply.code(400).send({ error: 'invalid_hex' });
    try {
      db.prepare(
        `UPDATE aircraft SET hex=@hex, registration=@registration, callsign=@callsign, type_name=@type_name,
           icao_type=@icao_type, nickname=@nickname, tagline=@tagline, description=@description, operator=@operator, icon=@icon, color=@color, enabled=@enabled,
           category=@category, visibility=@visibility, track_until=@track_until, sort_order=@sort_order, notes=@notes,
           updated_at=${Date.now()}
         WHERE id = @id`
      ).run({ ...a, id });
    } catch (err) {
      if (String(err).includes('UNIQUE')) return reply.code(409).send({ error: 'hex_exists' });
      throw err;
    }
    audit(req, 'aircraft.update', `${a.registration} (${a.hex})`);
    return { ok: true };
  });

  // Enable/disable only — a dedicated route so the table toggle never has to
  // resend the whole aircraft (which would blank any field it omits).
  app.post('/api/admin/aircraft/:id/enabled', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    if (!clubAircraft(club, id)) return reply.code(404).send({ error: 'not_found' });
    const enabled = !!(req.body as { enabled?: boolean } | null)?.enabled;
    // Re-enabling a guest whose track-until has already passed clears the stale
    // date, so the poller's auto-expire doesn't flip it straight back off.
    if (enabled) {
      db.prepare(
        "UPDATE aircraft SET enabled = 1, track_until = CASE WHEN track_until < date('now') THEN NULL ELSE track_until END, updated_at = ? WHERE id = ?"
      ).run(Date.now(), id);
    } else {
      db.prepare('UPDATE aircraft SET enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
    }
    audit(req, 'aircraft.enabled', `${id} ${enabled}`);
    return { ok: true };
  });

  app.delete('/api/admin/aircraft/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    if (!clubAircraft(club, id)) return reply.code(404).send({ error: 'not_found' });
    db.prepare('UPDATE aircraft SET deleted_at = ?, enabled = 0 WHERE id = ?').run(Date.now(), id);
    audit(req, 'aircraft.delete', String(id));
    return { ok: true };
  });

  app.get('/api/admin/lookup', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const reg = String((req.query as { reg?: string }).reg ?? '').trim();
    if (!reg) return reply.code(400).send({ error: 'missing_reg' });
    return await lookupByRegistration(reg);
  });

  const processImage = async (
    req: FastifyRequest,
    kind: 'icon' | 'photo' | 'logo'
  ): Promise<{ buffer: Buffer; ext: string } | { error: string }> => {
    const part = await req.file();
    if (!part) return { error: 'no_file' };
    const buf = await part.toBuffer();
    try {
      const img = sharp(buf, { failOn: 'error', limitInputPixels: 50_000_000 });
      const meta = await img.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) return { error: 'unsupported_format' };
      if (kind === 'icon') {
        return {
          buffer: await img.resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
          ext: 'png',
        };
      }
      if (kind === 'logo') {
        return { buffer: await img.resize(512, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer(), ext: 'png' };
      }
      return {
        buffer: await img.resize(1400, 1400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
        ext: 'webp',
      };
    } catch {
      return { error: 'invalid_image' };
    }
  };

  app.post('/api/admin/aircraft/:id/image', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const kind = (req.query as { kind?: string }).kind === 'icon' ? 'icon' : 'photo';
    const ac = clubAircraft(club, id) as { icon_path: string | null; photo_path: string | null } | undefined;
    if (!ac) return reply.code(404).send({ error: 'not_found' });
    const out = await processImage(req, kind);
    if ('error' in out) return reply.code(400).send({ error: out.error });
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const name = `${club.id}-${id}-${kind}-${crypto.randomBytes(6).toString('hex')}.${out.ext}`;
    fs.writeFileSync(path.join(uploadsDir(), name), out.buffer);
    const old = kind === 'icon' ? ac.icon_path : ac.photo_path;
    if (old) fs.rmSync(path.join(uploadsDir(), old), { force: true });
    db.prepare(`UPDATE aircraft SET ${kind === 'icon' ? 'icon_path' : 'photo_path'} = ?, updated_at = ? WHERE id = ?`).run(
      name,
      Date.now(),
      id
    );
    audit(req, 'aircraft.image', `${id} ${kind}`);
    return { path: `/uploads/${name}` };
  });

  app.delete('/api/admin/aircraft/:id/image', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const kind = (req.query as { kind?: string }).kind === 'icon' ? 'icon' : 'photo';
    const col = kind === 'icon' ? 'icon_path' : 'photo_path';
    const ac = clubAircraft(club, id) as Record<string, string | null> | undefined;
    if (!ac) return reply.code(404).send({ error: 'not_found' });
    if (ac[col]) fs.rmSync(path.join(uploadsDir(), ac[col]!), { force: true });
    db.prepare(`UPDATE aircraft SET ${col} = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
    return { ok: true };
  });

  // ---- members (club-scoped user management) ----

  app.get('/api/admin/members', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return {
      members: db
        .prepare(
          `SELECT u.id, u.username, u.email, u.must_change_password, u.last_login_at, m.role, m.created_at
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.club_id = ? ORDER BY u.email`
        )
        .all(club.id),
    };
  });

  // Invite by email: creates the global account if needed, adds the club
  // membership, and emails a set-password link (or returns it for sharing).
  app.post('/api/admin/members', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const { email, name, role } = (req.body ?? {}) as { email?: string; name?: string; role?: string };
    const cleanEmail = email?.trim().toLowerCase();
    if (!cleanEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) {
      return reply.code(400).send({ error: 'invalid_email' });
    }
    const now = Date.now();
    let user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(cleanEmail) as
      | { id: number; password_hash: string }
      | undefined;
    if (!user) {
      const userId = Number(
        db
          .prepare(
            `INSERT INTO users (username, email, password_hash, role, must_change_password, created_at)
             VALUES (?, ?, '', 'member', 0, ?)`
          )
          .run((name?.trim() || cleanEmail.split('@')[0]).slice(0, 40), cleanEmail, now).lastInsertRowid
      );
      user = { id: userId, password_hash: '' };
    }
    db.prepare(
      'INSERT OR IGNORE INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, ?, ?)'
    ).run(user.id, club.id, role === 'admin' ? 'admin' : 'member', now);
    // (Re)send an invite only while the account has never set a password — so a
    // re-invite after an expired token works, but an active account (which may
    // belong to other clubs) never has a set-password link minted for it here.
    let inviteLink: string | null = null;
    let emailed = false;
    if (user.password_hash === '') {
      const token = createLoginToken(db, user.id, 'invite', club.id);
      inviteLink = `${clubUrl(club.slug)}/set-password?token=${token}`;
      emailed = await sendInviteEmail(cleanEmail, club.name, inviteLink);
    }
    audit(req, 'member.invite', cleanEmail);
    // The link comes back to the admin UI only when it could not be emailed.
    return { ok: true, emailed, inviteLink: emailed ? null : inviteLink };
  });

  app.put('/api/admin/members/:userId', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const userId = Number((req.params as { userId: string }).userId);
    const { role } = (req.body ?? {}) as { role?: string };
    if (!['member', 'admin'].includes(role ?? '')) return reply.code(400).send({ error: 'invalid_role' });
    if (role === 'member') {
      const admins = (
        db.prepare("SELECT COUNT(*) c FROM memberships WHERE club_id = ? AND role = 'admin'").get(club.id) as { c: number }
      ).c;
      const isAdminNow = db
        .prepare("SELECT 1 FROM memberships WHERE club_id = ? AND user_id = ? AND role = 'admin'")
        .get(club.id, userId);
      if (isAdminNow && admins <= 1) return reply.code(400).send({ error: 'last_admin' });
    }
    const res = db.prepare('UPDATE memberships SET role = ? WHERE club_id = ? AND user_id = ?').run(role, club.id, userId);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    audit(req, 'member.role', `${userId} -> ${role}`);
    return { ok: true };
  });

  app.post('/api/admin/members/:userId/reset', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const userId = Number((req.params as { userId: string }).userId);
    const member = db
      .prepare(
        `SELECT u.email, u.platform_admin,
                (SELECT COUNT(*) FROM memberships WHERE user_id = u.id) AS club_count
         FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.club_id = ? AND m.user_id = ?`
      )
      .get(club.id, userId) as { email: string | null; platform_admin: number; club_count: number } | undefined;
    if (!member) return reply.code(404).send({ error: 'not_found' });
    const token = createLoginToken(db, userId, 'reset', club.id);
    const link = `${clubUrl(club.slug)}/set-password?token=${token}`;
    const emailed = member.email ? await sendResetEmail(member.email, link) : false;
    audit(req, 'member.reset', String(userId));
    // A reset sets the GLOBAL password, so the link is only ever returned to the
    // admin when doing so cannot grant access beyond this club: the account must
    // belong to no other club and not be a platform admin. Otherwise it can only
    // be delivered to the member's own inbox — never handed to a third party.
    const safeToShare = member.club_count <= 1 && member.platform_admin !== 1;
    if (!emailed && !safeToShare) {
      return { ok: true, emailed: false, resetLink: null, needsSelfReset: true };
    }
    return { ok: true, emailed, resetLink: emailed ? null : link };
  });

  app.delete('/api/admin/members/:userId', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const userId = Number((req.params as { userId: string }).userId);
    if (userId === req.auth!.userId) return reply.code(400).send({ error: 'cannot_remove_self' });
    const isAdminNow = db
      .prepare("SELECT 1 FROM memberships WHERE club_id = ? AND user_id = ? AND role = 'admin'")
      .get(club.id, userId);
    if (isAdminNow) {
      const admins = (
        db.prepare("SELECT COUNT(*) c FROM memberships WHERE club_id = ? AND role = 'admin'").get(club.id) as { c: number }
      ).c;
      if (admins <= 1) return reply.code(400).send({ error: 'last_admin' });
    }
    // Removes club access only — the global account (and any other club
    // memberships) stay intact.
    db.prepare('DELETE FROM memberships WHERE club_id = ? AND user_id = ?').run(club.id, userId);
    live.dropUser(club.id, userId); // cut any live stream that member still holds
    audit(req, 'member.remove', String(userId));
    return { ok: true };
  });

  // ---- club settings / branding ----

  app.get('/api/admin/settings', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return { club: clubs.get(club.id) };
  });

  app.put('/api/admin/settings', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const b = (req.body ?? {}) as Record<string, unknown>;
    const wasPublic = club.public_mode === 1;
    const next = {
      name: String(b.name ?? club.name).trim().slice(0, 60) || club.name,
      subheading: String(b.subheading ?? club.subheading).trim().slice(0, 60),
      theme: THEMES.has(String(b.theme)) ? String(b.theme) : club.theme,
      accent: /^#[0-9a-fA-F]{6}$/.test(String(b.accent)) ? String(b.accent) : club.accent,
      map_center: String(b.mapCenter ?? club.map_center),
      map_zoom: Number(b.mapZoom) || club.map_zoom,
      // Only accept a well-formed absolute http(s) tile URL; viewers' browsers
      // fetch this, so reject javascript:/data:/garbage that could redirect them.
      tile_style_url: isHttpUrl(b.tileStyleUrl) ? String(b.tileStyleUrl) : club.tile_style_url,
      timezone: isValidTimezone(b.timezone) ? String(b.timezone) : club.timezone,
      public_mode: b.publicMode === undefined ? club.public_mode : b.publicMode ? 1 : 0,
      weather_layer: b.weatherLayer === undefined ? club.weather_layer : b.weatherLayer ? 1 : 0,
      kiosk_prefs: (() => {
        if (b.kioskViewMode === undefined) return club.kiosk_prefs;
        const prefs = kioskPrefs(club);
        prefs.viewMode = b.kioskViewMode === 'overview' ? 'overview' : 'target';
        return JSON.stringify(prefs);
      })(),
      other_traffic: (() => {
        if (b.otherTraffic === undefined || typeof b.otherTraffic !== 'object' || b.otherTraffic === null) {
          return club.other_traffic;
        }
        // Merge over the current (parsed+clamped) prefs so a partial payload
        // never resets the untouched knobs; otherTrafficPrefs re-clamps on
        // read, but storing clean values keeps the row inspectable.
        const cur = otherTrafficPrefs(club);
        const o = b.otherTraffic as Record<string, unknown>;
        const int = (v: unknown, lo: number, hi: number, fallback: number): number => {
          const n = Math.round(Number(v));
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
        };
        return JSON.stringify({
          enabled: o.enabled === undefined ? cur.enabled : !!o.enabled,
          maxAltFt: o.maxAltFt === undefined ? cur.maxAltFt : int(o.maxAltFt, 500, 60_000, cur.maxAltFt),
          radiusNm: o.radiusNm === undefined ? cur.radiusNm : int(o.radiusNm, 5, 100, cur.radiusNm),
          color: /^#[0-9a-fA-F]{6}$/.test(String(o.color)) ? String(o.color) : cur.color,
        });
      })(),
      callsign_rules: (() => {
        if (b.callsignRules === undefined) return club.callsign_rules;
        try {
          const rules = (b.callsignRules as { prefix?: string; spoken?: string }[])
            .map((r) => ({ prefix: (r?.prefix ?? '').trim().toUpperCase(), spoken: (r?.spoken ?? '').trim().toUpperCase() }))
            // Prefix is compiled into a RegExp downstream, so restrict it to a
            // safe callsign charset (letters, digits, hyphen) — no metachars.
            .filter((r) => /^[A-Z0-9-]{1,8}$/.test(r.prefix) && r.spoken)
            .slice(0, 10);
          return JSON.stringify(rules);
        } catch {
          return club.callsign_rules;
        }
      })(),
      id: club.id,
    };
    db.prepare(
      `UPDATE clubs SET name=@name, subheading=@subheading, theme=@theme, accent=@accent, map_center=@map_center,
       map_zoom=@map_zoom, tile_style_url=@tile_style_url, public_mode=@public_mode, callsign_rules=@callsign_rules,
       kiosk_prefs=@kiosk_prefs, timezone=@timezone, weather_layer=@weather_layer, other_traffic=@other_traffic
       WHERE id=@id`
    ).run(next);
    clubs.reload();
    audit(req, 'club.settings', JSON.stringify({ name: next.name, theme: next.theme, public: next.public_mode }));
    if (wasPublic && next.public_mode === 0) {
      live.dropUnauthenticated(club.id);
      audit(req, 'club.private_mode', 'anonymous live connections dropped');
    }
    return { club: clubs.get(club.id) };
  });

  app.post('/api/admin/kiosk-token/rotate', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const token = crypto.randomBytes(24).toString('base64url');
    db.prepare('UPDATE clubs SET kiosk_token = ? WHERE id = ?').run(token, club.id);
    destroyKioskSessions(db, club.id);
    live.dropKiosk(club.id); // and cut any kiosk stream still riding the old token
    clubs.reload();
    audit(req, 'kiosk.rotate');
    return { token };
  });

  app.post('/api/admin/branding/logo', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const out = await processImage(req, 'logo');
    if ('error' in out) return reply.code(400).send({ error: out.error });
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const name = `club-${club.id}-logo-${crypto.randomBytes(6).toString('hex')}.png`;
    fs.writeFileSync(path.join(uploadsDir(), name), out.buffer);
    if (club.logo_path) fs.rmSync(path.join(uploadsDir(), club.logo_path), { force: true });
    db.prepare('UPDATE clubs SET logo_path = ? WHERE id = ?').run(name, club.id);
    clubs.reload();
    audit(req, 'branding.logo', name);
    return { path: `/uploads/${name}` };
  });

  app.delete('/api/admin/branding/logo', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    if (club.logo_path) fs.rmSync(path.join(uploadsDir(), club.logo_path), { force: true });
    db.prepare('UPDATE clubs SET logo_path = NULL WHERE id = ?').run(club.id);
    clubs.reload();
    return { ok: true };
  });

  // ---- airfields ----

  app.get('/api/admin/airfields', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return { airfields: db.prepare('SELECT * FROM airfields WHERE club_id = ? ORDER BY code').all(club.id) };
  });

  const airfieldBody = (body: Record<string, unknown>) => ({
    code: String(body.code ?? '').trim().toUpperCase(),
    name: String(body.name ?? '').trim(),
    lat: Number(body.lat),
    lon: Number(body.lon),
    elevation_ft: Number(body.elevationFt) || 0,
    radius_nm: Number(body.radiusNm) || 3,
    is_base: body.isBase ? 1 : 0,
  });

  app.post('/api/admin/airfields', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const a = airfieldBody(req.body as Record<string, unknown>);
    if (!a.code || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) {
      return reply.code(400).send({ error: 'invalid_airfield' });
    }
    const res = db
      .prepare(
        'INSERT INTO airfields (club_id, code, name, lat, lon, elevation_ft, radius_nm, is_base) VALUES (@club_id, @code, @name, @lat, @lon, @elevation_ft, @radius_nm, @is_base)'
      )
      .run({ ...a, club_id: club.id });
    detector.reloadAirfields();
    audit(req, 'airfield.create', a.code);
    return { id: Number(res.lastInsertRowid) };
  });

  app.put('/api/admin/airfields/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const a = airfieldBody(req.body as Record<string, unknown>);
    const res = db
      .prepare(
        'UPDATE airfields SET code=@code, name=@name, lat=@lat, lon=@lon, elevation_ft=@elevation_ft, radius_nm=@radius_nm, is_base=@is_base WHERE id=@id AND club_id=@club_id'
      )
      .run({ ...a, id, club_id: club.id });
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    detector.reloadAirfields();
    return { ok: true };
  });

  app.delete('/api/admin/airfields/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const owned = db.prepare('SELECT 1 FROM airfields WHERE id = ? AND club_id = ?').get(id, club.id);
    if (!owned) return reply.code(404).send({ error: 'not_found' });
    db.prepare('UPDATE flights SET origin_airfield_id = NULL WHERE origin_airfield_id = ?').run(id);
    db.prepare('UPDATE flights SET dest_airfield_id = NULL WHERE dest_airfield_id = ?').run(id);
    db.prepare('DELETE FROM airfields WHERE id = ?').run(id);
    detector.reloadAirfields();
    return { ok: true };
  });

  // ---- ticker broadcasts ----

  app.get('/api/admin/ticker', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return {
      events: db
        .prepare(
          `SELECT e.id, e.ts, e.text, a.registration FROM ticker_events e
           LEFT JOIN aircraft a ON a.id = e.aircraft_id WHERE e.club_id = ? ORDER BY e.ts DESC LIMIT 30`
        )
        .all(club.id),
    };
  });

  app.post('/api/admin/ticker', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text?.trim() || text.trim().length > 200) return reply.code(400).send({ error: 'invalid_text' });
    postTickerMessage(db, club.id, text.trim(), emitTicker);
    audit(req, 'ticker.post', text.trim().slice(0, 80));
    return { ok: true };
  });

  app.delete('/api/admin/ticker/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    db.prepare('DELETE FROM ticker_events WHERE id = ? AND club_id = ?').run(
      Number((req.params as { id: string }).id),
      club.id
    );
    return { ok: true };
  });

  // ---- kiosk messages (annotations) ----

  app.get('/api/admin/annotations', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return {
      annotations: db
        .prepare(
          `SELECT an.*, a.registration, a.callsign FROM annotations an
           JOIN aircraft a ON a.id = an.aircraft_id
           WHERE a.club_id = ? ORDER BY an.created_at DESC LIMIT 50`
        )
        .all(club.id),
    };
  });

  app.post('/api/admin/annotations', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const { aircraftId, text, mode, untilTs } = (req.body ?? {}) as {
      aircraftId?: number;
      text?: string;
      mode?: string;
      untilTs?: number;
    };
    if (!aircraftId || !text?.trim() || !['until', 'next_flight'].includes(mode ?? '')) {
      return reply.code(400).send({ error: 'invalid_annotation' });
    }
    if (!clubAircraft(club, aircraftId)) return reply.code(404).send({ error: 'not_found' });
    if (mode === 'until' && (!untilTs || untilTs < Date.now())) {
      return reply.code(400).send({ error: 'until_must_be_future' });
    }
    const res = db
      .prepare(
        `INSERT INTO annotations (aircraft_id, text, mode, until_ts, status, created_by, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(aircraftId, text.trim().slice(0, 200), mode, mode === 'until' ? untilTs : null, req.auth!.email ?? req.auth!.username, Date.now());
    audit(req, 'annotation.create', `${aircraftId}: ${text.slice(0, 60)}`);
    return { id: Number(res.lastInsertRowid) };
  });

  app.delete('/api/admin/annotations/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const owned = db
      .prepare('SELECT 1 FROM annotations an JOIN aircraft a ON a.id = an.aircraft_id WHERE an.id = ? AND a.club_id = ?')
      .get(id, club.id);
    if (!owned) return reply.code(404).send({ error: 'not_found' });
    db.prepare("UPDATE annotations SET status = 'done' WHERE id = ?").run(id);
    audit(req, 'annotation.clear', String(id));
    return { ok: true };
  });

  // ---- flights admin: manual route edit, merge, split, delete ----

  app.put('/api/admin/flights/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    if (!clubFlight(club, id)) return reply.code(404).send({ error: 'not_found' });
    const { routeOrigin, routeDestination } = (req.body ?? {}) as { routeOrigin?: string; routeDestination?: string };
    db.prepare("UPDATE flights SET route_origin = ?, route_destination = ?, route_source = 'manual' WHERE id = ?").run(
      routeOrigin?.trim().toUpperCase() || null,
      routeDestination?.trim().toUpperCase() || null,
      id
    );
    audit(req, 'flight.route', `${id} ${routeOrigin}-${routeDestination}`);
    return { ok: true };
  });

  app.post('/api/admin/flights/merge', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const { flightIds } = (req.body ?? {}) as { flightIds?: number[] };
    if (!Array.isArray(flightIds) || flightIds.length < 2) return reply.code(400).send({ error: 'need_two_flights' });
    const flights = flightIds.map((id) => clubFlight(club, id)).filter(Boolean) as {
      id: number;
      aircraft_id: number;
      started_at?: number;
      ended_at: number | null;
    }[];
    if (flights.length !== flightIds.length) return reply.code(404).send({ error: 'not_found' });
    // A flight the detector is still tracking (open) must not be merged away —
    // it would leave the detector pointed at a deleted row.
    if (flights.some((f) => f.ended_at === null)) return reply.code(409).send({ error: 'flight_in_progress' });
    if (new Set(flights.map((f) => f.aircraft_id)).size !== 1) {
      return reply.code(400).send({ error: 'different_aircraft' });
    }
    const ordered = db
      .prepare(`SELECT id FROM flights WHERE id IN (${flightIds.map(() => '?').join(',')}) ORDER BY started_at`)
      .all(...flightIds) as { id: number }[];
    const target = ordered[0];
    const merge = db.transaction(() => {
      for (const f of ordered.slice(1)) {
        db.prepare('UPDATE positions SET flight_id = ? WHERE flight_id = ?').run(target.id, f.id);
        db.prepare('DELETE FROM flights WHERE id = ?').run(f.id);
      }
      recomputeFlightStats(db, target.id);
    });
    merge();
    audit(req, 'flight.merge', `${flightIds.join('+')} -> ${target.id}`);
    return { id: target.id };
  });

  app.post('/api/admin/flights/:id/split', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const flight = clubFlight(club, id);
    const { atTs } = (req.body ?? {}) as { atTs?: number };
    if (!flight || !atTs) return reply.code(400).send({ error: 'invalid_split' });
    if (flight.ended_at === null) return reply.code(409).send({ error: 'flight_in_progress' });
    const split = db.transaction(() => {
      const res = db
        .prepare(
          `INSERT INTO flights (aircraft_id, started_at, ended_at, end_confidence, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(flight.aircraft_id, atTs, flight.ended_at, flight.end_confidence ?? 'assumed', Date.now());
      const newId = Number(res.lastInsertRowid);
      db.prepare('UPDATE positions SET flight_id = ? WHERE flight_id = ? AND ts >= ?').run(newId, id, atTs);
      db.prepare("UPDATE flights SET ended_at = ?, end_confidence = 'assumed', dest_airfield_id = NULL WHERE id = ?").run(
        atTs,
        id
      );
      recomputeFlightStats(db, id);
      recomputeFlightStats(db, newId);
      return newId;
    });
    const newId = split();
    audit(req, 'flight.split', `${id} at ${atTs} -> ${newId}`);
    return { id: newId };
  });

  app.delete('/api/admin/flights/:id', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const id = Number((req.params as { id: string }).id);
    const flight = clubFlight(club, id);
    if (!flight) return reply.code(404).send({ error: 'not_found' });
    if (flight.ended_at === null) return reply.code(409).send({ error: 'flight_in_progress' });
    const del = db.transaction(() => {
      db.prepare('UPDATE positions SET flight_id = NULL WHERE flight_id = ?').run(id);
      db.prepare('DELETE FROM flights WHERE id = ?').run(id);
    });
    del();
    audit(req, 'flight.delete', String(id));
    return { ok: true };
  });

  // ---- status / audit ----

  app.get('/api/admin/status', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    const counts = {
      // Sum the per-flight counters (indexed, thousands of rows) instead of
      // walking the whole platform-wide positions table on every 10s poll.
      positions: (
        db
          .prepare(
            'SELECT COALESCE(SUM(f.position_count), 0) c FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE a.club_id = ?'
          )
          .get(club.id) as { c: number }
      ).c,
      flights: (
        db
          .prepare('SELECT COUNT(*) c FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE a.club_id = ?')
          .get(club.id) as { c: number }
      ).c,
      aircraft: (
        db.prepare('SELECT COUNT(*) c FROM aircraft WHERE club_id = ? AND deleted_at IS NULL').get(club.id) as { c: number }
      ).c,
      members: (db.prepare('SELECT COUNT(*) c FROM memberships WHERE club_id = ?').get(club.id) as { c: number }).c,
    };
    // The poll log and DB size are platform-wide (the poller is shared), so a
    // club admin only sees whether the feed is healthy — the raw cross-tenant
    // poll rows and total DB size live on the platform-only status route.
    return {
      poller: { lastPollAt: poller.lastPollAt, ok: poller.lastPollOk, error: poller.lastPollError },
      counts,
      sseClients: live.clientCount(club.id),
    };
  });

  app.get('/api/admin/audit', async (req, reply) => {
    const club = clubOf(req, reply);
    if (!club || !requireClubAdmin(req, reply, club)) return;
    return { audit: db.prepare('SELECT * FROM audit_log WHERE club_id = ? ORDER BY ts DESC LIMIT 200').all(club.id) };
  });

  // ---------- platform admin ----------

  app.get('/api/platform/status', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    return {
      poller: { lastPollAt: poller.lastPollAt, ok: poller.lastPollOk, error: poller.lastPollError },
      recentPolls: db.prepare('SELECT * FROM poll_log ORDER BY ts DESC LIMIT 30').all(),
      dbSizeBytes: dbFileSizeBytes(),
      health: collectMetrics(db, live),
    };
  });

  app.get('/api/platform/clubs', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    return {
      clubs: clubs.all().map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        theme: c.theme,
        publicMode: c.public_mode === 1,
        url: clubUrl(c.slug),
        members: (db.prepare('SELECT COUNT(*) c FROM memberships WHERE club_id = ?').get(c.id) as { c: number }).c,
        aircraft: (
          db.prepare('SELECT COUNT(*) c FROM aircraft WHERE club_id = ? AND deleted_at IS NULL').get(c.id) as { c: number }
        ).c,
      })),
    };
  });

  app.post('/api/platform/clubs', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    const { slug, name } = (req.body ?? {}) as { slug?: string; name?: string };
    const cleanSlug = slug?.trim().toLowerCase();
    if (!cleanSlug || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(cleanSlug) || ['www', 'api', 'app', 'admin'].includes(cleanSlug)) {
      return reply.code(400).send({ error: 'invalid_slug' });
    }
    if (!name?.trim()) return reply.code(400).send({ error: 'invalid_name' });
    try {
      const res = db
        .prepare(
          `INSERT INTO clubs (slug, name, subheading, kiosk_token, created_at) VALUES (?, ?, 'OPERATIONS BOARD', ?, ?)`
        )
        .run(cleanSlug, name.trim(), crypto.randomBytes(24).toString('base64url'), Date.now());
      clubs.reload();
      // The creating platform admin gets an admin membership so they can set
      // the club up before handing it over.
      db.prepare("INSERT INTO memberships (user_id, club_id, role, created_at) VALUES (?, ?, 'admin', ?)").run(
        req.auth!.userId,
        Number(res.lastInsertRowid),
        Date.now()
      );
      audit(req, 'platform.club_create', cleanSlug);
      return { id: Number(res.lastInsertRowid), url: clubUrl(cleanSlug) };
    } catch (err) {
      if (String(err).includes('UNIQUE')) return reply.code(409).send({ error: 'slug_exists' });
      throw err;
    }
  });

  app.get('/api/platform/users', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.email, u.platform_admin, u.last_login_at,
                (SELECT group_concat(c.slug || ':' || m.role) FROM memberships m JOIN clubs c ON c.id = m.club_id WHERE m.user_id = u.id) AS clubs
         FROM users u ORDER BY u.email`
      )
      .all();
    return { users };
  });

  // Grant/revoke platform admin — the last platform admin is protected so the
  // platform can never lock itself out.
  app.put('/api/platform/users/:id', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const { platformAdmin } = (req.body ?? {}) as { platformAdmin?: boolean };
    if (typeof platformAdmin !== 'boolean') return reply.code(400).send({ error: 'invalid_body' });
    if (!platformAdmin) {
      const admins = (db.prepare('SELECT COUNT(*) c FROM users WHERE platform_admin = 1').get() as { c: number }).c;
      const isAdminNow = db.prepare('SELECT 1 FROM users WHERE id = ? AND platform_admin = 1').get(id);
      if (isAdminNow && admins <= 1) return reply.code(400).send({ error: 'last_platform_admin' });
    }
    const res = db.prepare('UPDATE users SET platform_admin = ? WHERE id = ?').run(platformAdmin ? 1 : 0, id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    audit(req, 'platform.admin_flag', `${id} -> ${platformAdmin}`);
    return { ok: true };
  });

  app.get('/api/platform/waitlist', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    return {
      signups: db
        .prepare('SELECT id, email, marketing_opt_in, created_at, source FROM waitlist ORDER BY created_at DESC')
        .all(),
    };
  });

  // The ADSBx rescue tier is platform infrastructure billed to the platform,
  // so its status and the manual probe live here — never in club admin.
  app.get('/api/platform/rescue', async (req, reply) => {
    if (!requirePlatform(req, reply)) return;
    let usage: { month?: string; used?: number } = {};
    try {
      usage = JSON.parse(settings.get('adsbx_usage', '{}'));
    } catch {
      /* unparsed */
    }
    const aircraft = db
      .prepare(
        `SELECT a.id, a.registration, a.callsign, a.hex, c.name club
         FROM aircraft a JOIN clubs c ON c.id = a.club_id
         WHERE a.deleted_at IS NULL AND a.enabled = 1
         ORDER BY c.name, a.registration`
      )
      .all();
    return {
      configured: !!config.adsbxApiKey,
      month: usage.month ?? null,
      used: usage.used ?? 0,
      budget: config.adsbxMonthlyBudget,
      aircraft,
    };
  });

  // Manual ADSBx probe — bootstraps rescue coverage for a flight that began
  // inside a free-network blackspot (the automatic tier needs an open flight).
  // Spends real budget: rate limited against double-clicks, and audited.
  app.post(
    '/api/platform/rescue-probe',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!requirePlatform(req, reply)) return;
      const aircraftId = Number((req.body as { aircraftId?: number } | null)?.aircraftId);
      if (!Number.isInteger(aircraftId)) return reply.code(400).send({ error: 'missing_aircraft' });
      const res = await poller.manualRescue(aircraftId);
      if (!res.ok) {
        const code =
          res.error === 'budget_exhausted' ? 429 : res.error === 'provider_error' ? 502 : 400;
        return reply.code(code).send({ error: res.error });
      }
      audit(req, 'platform.rescue_probe', `${aircraftId}: ${res.found ? 'contact' : 'no contact'}`);
      return res;
    }
  );

  // ---------- SPA shell with social/SEO meta ----------

  // Short-lived in-memory cache of rendered share cards (see the og.jpg route).
  const ogCache = new Map<string, { at: number; buf: Buffer }>();
  const OG_CACHE_MS = 60_000;

  // Distinct live-bucket renders allowed per aircraft per minute (see og.jpg).
  const ogBuckets = new Map<number, { minute: number; seen: Set<string> }>();
  const ogBucketAllowed = (aircraftId: number, bucket: string): boolean => {
    const minute = Math.floor(Date.now() / 60_000);
    let e = ogBuckets.get(aircraftId);
    if (!e || e.minute !== minute) {
      e = { minute, seen: new Set() };
      ogBuckets.set(aircraftId, e);
      if (ogBuckets.size > 500) for (const [k, v] of ogBuckets) if (v.minute < minute) ogBuckets.delete(k);
    }
    if (e.seen.has(bucket)) return true;
    if (e.seen.size >= 3) return false; // cap distinct buckets/aircraft/minute
    e.seen.add(bucket);
    return true;
  };

  interface ShellMeta {
    title: string;
    description: string;
    image: string | null;
    imageType?: string; // e.g. image/jpeg — set for generated share cards
    url: string;
    noindex: boolean;
  }

  // Social scrapers (WhatsApp, iMessage, Twitter…) don't run JS, so share
  // previews must be baked into the HTML per club — and per aircraft for
  // deep links on public clubs.
  const renderShell = (reply: FastifyReply, meta: ShellMeta) => {
    let html: string;
    try {
      html = fs.readFileSync(path.join(deps.webDist, 'index.html'), 'utf8');
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }
    const tags = [
      `<meta name="description" content="${escapeHtml(meta.description)}" />`,
      `<meta property="og:site_name" content="Fleety" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
      `<meta property="og:url" content="${escapeHtml(meta.url)}" />`,
      `<link rel="canonical" href="${escapeHtml(meta.url)}" />`,
      `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}" />`,
      `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
      ...(meta.image
        ? [
            `<meta property="og:image" content="${escapeHtml(meta.image)}" />`,
            `<meta property="og:image:secure_url" content="${escapeHtml(meta.image)}" />`,
            ...(meta.imageType ? [`<meta property="og:image:type" content="${escapeHtml(meta.imageType)}" />`] : []),
            // Our generated share cards are a fixed 1200×630; a logo may not be,
            // so only advertise dimensions for the JPEG cards.
            ...(meta.imageType === 'image/jpeg'
              ? [
                  `<meta property="og:image:width" content="1200" />`,
                  `<meta property="og:image:height" content="630" />`,
                ]
              : []),
            `<meta name="twitter:image" content="${escapeHtml(meta.image)}" />`,
          ]
        : []),
      ...(meta.noindex ? [`<meta name="robots" content="noindex" />`] : []),
    ].join('\n    ');
    // Function replacements: the injected strings contain admin-controlled text
    // and escapeHtml doesn't neutralise `$`, so a literal replacement would let
    // `$&`/`$1` etc. splice the document. A function replacement is `$`-safe.
    html = html
      .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escapeHtml(meta.title)}</title>`)
      .replace(/<!--fleety:meta-->[\s\S]*?<!--\/fleety:meta-->/, () => tags);
    return reply.type('text/html').header('Cache-Control', 'no-cache').send(html);
  };

  const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host ?? config.baseDomain}`;

  const shellMetaFor = (req: FastifyRequest): ShellMeta => {
    const club = req.club;
    if (!club) {
      return {
        title: 'Fleety — live ops boards for flying clubs',
        description:
          'Your club’s aircraft, live on a board built for the clubhouse — flight history, departures ticker and kiosk mode.',
        image: null,
        url: `${baseUrl(req)}/`,
        noindex: false,
      };
    }
    return {
      title: `${club.name} — live ops board`,
      description: `Live fleet tracking for ${club.name}: who's in the air right now, flight history, and the clubhouse departures ticker. Powered by Fleety.`,
      image: club.logo_path ? `${baseUrl(req)}/uploads/${club.logo_path}` : null,
      url: `${baseUrl(req)}${req.url.split('?')[0]}`,
      noindex: club.public_mode !== 1,
    };
  };

  app.get('/', async (req, reply) => renderShell(reply, shellMetaFor(req)));

  // Shared gate for the aircraft deep-link preview and its share card: a rich
  // preview is only produced for a PUBLIC club AND a PUBLIC-visibility aircraft
  // — a shared private-club/members-only link echoes nothing back.
  const publicAircraftFor = (club: ClubRow | null, reg: string) => {
    if (!club || club.public_mode !== 1 || !reg) return undefined;
    return db
      .prepare(
        `SELECT id, registration, callsign, type_name, nickname, description, tagline, photo_path FROM aircraft
         WHERE club_id = ? AND deleted_at IS NULL AND visibility = 'public'
           AND (registration = ? COLLATE NOCASE OR callsign = ? COLLATE NOCASE)`
      )
      .get(club.id, reg, reg) as
      | {
          id: number;
          registration: string;
          callsign: string;
          type_name: string;
          nickname: string;
          description: string;
          tagline: string;
          photo_path: string | null;
        }
      | undefined;
  };

  const liveMetrics = (clubId: number, aircraftId: number) => {
    const a = live.list(clubId, 'restricted').find((x) => x.id === aircraftId);
    if (!a) return null;
    return { status: a.status, altBaro: a.pos?.altBaro ?? null, gs: a.pos?.gs ?? null };
  };

  // The Share button appends ?s=<minute bucket> so each intentional share
  // captures the live moment while staying Cloudflare-cacheable within the
  // minute. A bare URL (no valid bucket) is the evergreen preview. Restricting
  // to digits keeps the cache key from being poisoned with arbitrary values.
  const shareBucket = (req: FastifyRequest): string | null => {
    const s = (req.query as { s?: string }).s;
    return typeof s === 'string' && /^\d{1,12}$/.test(s) ? s : null;
  };

  // Server-rendered JPEG share card for one aircraft (WhatsApp won't preview
  // our webp photos, and this also bakes in the live details). Public only.
  // Rendering is off the event loop (sharp's threadpool) and the response is
  // cacheable; the rate limit caps deliberate cache-busting abuse.
  app.get('/ac/:reg/og.jpg', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const club = req.club;
    const reg = String((req.params as { reg: string }).reg ?? '').trim();
    const ac = publicAircraftFor(club, reg);
    if (!club || !ac) return reply.code(404).send({ error: 'not_found' });
    let bucket = shareBucket(req); // null => evergreen; else a live snapshot
    // Anti-amplification: legitimate shares of an aircraft within a minute all
    // carry the SAME bucket (one render). A flood of varied ?s= values would
    // otherwise force a fresh sharp render each; past a small cap per aircraft
    // per minute, fall back to the (cached) evergreen card.
    if (bucket && !ogBucketAllowed(ac.id, bucket)) bucket = null;
    // In-process cache absorbs the scrape burst (WhatsApp/Slack/Twitter each
    // hit it, plus retries). Keyed by bucket so a new minute renders fresh and
    // the evergreen card is its own entry. Both get a modest edge TTL — long
    // enough for Cloudflare to soak up a burst, short enough that making an
    // aircraft/club private revokes the (photo-bearing) card within minutes.
    const maxAge = bucket ? 120 : 600;
    const key = `${club.id}:${ac.id}:${bucket ?? 'ever'}`;
    const hit = ogCache.get(key);
    if (hit && Date.now() - hit.at < OG_CACHE_MS) {
      return reply.type('image/jpeg').header('Cache-Control', `public, max-age=${maxAge}`).send(hit.buf);
    }
    const spoken = displayCallsignFor(ac.callsign || '', clubs.rules(club));
    const card = await renderAircraftOgCard({
      uploadsDir: uploadsDir(),
      photoPath: ac.photo_path,
      logoPath: club.logo_path,
      accent: club.accent,
      clubName: club.name,
      displayCallsign: spoken || ac.registration,
      registration: ac.registration,
      typeName: ac.type_name,
      nickname: ac.nickname,
      description: ac.description,
      tagline: ac.tagline,
      // Live numbers only for a bucketed share; the bare URL stays evergreen.
      live: bucket ? liveMetrics(club.id, ac.id) : null,
    });
    ogCache.set(key, { at: Date.now(), buf: card });
    // Bounded: Map is insertion-ordered, so drop the oldest without copying the
    // whole keyset on every insert.
    while (ogCache.size > 200) ogCache.delete(ogCache.keys().next().value as string);
    return reply.type('image/jpeg').header('Cache-Control', `public, max-age=${maxAge}`).send(card);
  });

  // Deep link to one aircraft: /ac/G-PSZB (or its callsign).
  app.get('/ac/:reg', async (req, reply) => {
    const club = req.club;
    const reg = String((req.params as { reg: string }).reg ?? '').trim();
    const meta = shellMetaFor(req);
    // Until the aircraft qualifies for a rich preview, the canonical URL is
    // the club root — private-club deep links echo nothing back.
    meta.url = `${baseUrl(req)}/`;
    const ac = publicAircraftFor(club, reg);
    if (club && ac) {
      const spoken = displayCallsignFor(ac.callsign || '', clubs.rules(club));
      const label = spoken || ac.registration;
      const bucket = shareBucket(req); // Share-button link => live snapshot text
      const typeLine = `${ac.type_name}${ac.nickname ? ` “${ac.nickname}”` : ''}.`;
      const rawBlurb = (ac.description || ac.tagline || '').trim();
      // Give the blurb terminal punctuation so it reads as a sentence when the
      // durable/live tail is appended after it.
      const blurb = rawBlurb && !/[.!?…]$/.test(rawBlurb) ? `${rawBlurb}.` : rawBlurb;
      let tail: string;
      if (bucket) {
        const m = liveMetrics(club.id, ac.id);
        tail =
          m?.status === 'airborne'
            ? `Airborne now${m.altBaro != null ? ` at ${Math.round(m.altBaro).toLocaleString()} ft` : ''}${m.gs != null ? `, ${Math.round(m.gs)} kt` : ''}.`
            : m?.status === 'awake'
              ? 'Transponder live now.'
              : m?.status === 'ground'
                ? 'On the ground now.'
                : '';
      } else {
        // Evergreen: durable invitation, no volatile numbers that would be
        // wrong for the days a scraper caches this card.
        tail = `Track it live on the ${club.name} ops board.`;
      }
      meta.title = `${label} · ${ac.registration} — live on ${club.name}`;
      meta.description = [typeLine, blurb, tail].filter(Boolean).join(' ').trim();
      // Canonical/og:url stay the clean URL (SEO dedupes to the evergreen page);
      // only the image carries the bucket so the picture refreshes per share.
      meta.url = `${baseUrl(req)}/ac/${encodeURIComponent(ac.registration)}`;
      meta.image = `${meta.url}/og.jpg${bucket ? `?s=${bucket}` : ''}`;
      meta.imageType = 'image/jpeg';
    }
    return renderShell(reply, meta);
  });

  // ---------- health + SPA ----------

  app.get('/healthz', async (_req, reply) => {
    try {
      db.prepare('SELECT 1').get();
      return { ok: true };
    } catch {
      return reply.code(500).send({ ok: false });
    }
  });

  await app.register(fastifyStatic, {
    root: deps.webDist,
    prefix: '/',
    decorateReply: false,
    // wildcard keeps file resolution dynamic — a frontend rebuild must not
    // require a server restart to serve its new hashed assets.
    wildcard: true,
    index: ['index.html'],
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0];
    if (
      pathname.startsWith('/api/') ||
      pathname.startsWith('/uploads/') ||
      pathname.startsWith('/assets/') ||
      /\.[a-z0-9]+$/i.test(pathname)
    ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return renderShell(reply, shellMetaFor(req));
  });

  return app;
}
