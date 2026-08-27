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
import { config, uploadsDir } from './config.js';
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
  createSession,
  destroyKioskSessions,
  destroySession,
  destroyUserSessions,
  resolveSession,
} from './auth/sessions.js';
import { dbFileSizeBytes } from './db/index.js';
import { postTickerMessage, tickerItems } from './annotations.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface ServerDeps {
  db: Database;
  settings: Settings;
  live: LiveBus;
  poller: Poller;
  detector: FlightDetector;
  webDist: string;
}

const SETTINGS_WHITELIST = new Set([
  'public_mode',
  'site_name',
  'poll_fast_ms',
  'poll_slow_ms',
  'raw_retention_days',
  'poll_log_retention_days',
  'tile_style_url',
  'map_center',
  'map_zoom',
  'deadman_url',
]);

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { db, settings, live, poller, detector } = deps;
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1024 * 1024 });

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  const audit = (req: FastifyRequest, action: string, detail = '') => {
    db.prepare('INSERT INTO audit_log (ts, user_id, username, action, detail) VALUES (?, ?, ?, ?, ?)').run(
      Date.now(),
      req.auth?.userId ?? null,
      req.auth?.username ?? '',
      action,
      detail
    );
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
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      // CSRF: mutating requests must carry the app's custom header; browsers
      // won't attach it cross-site.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-fleetview'] !== '1') {
        return reply.code(403).send({ error: 'missing_csrf_header' });
      }
      // A user who must change their password can only do that (and look at
      // who they are / log out).
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
  });

  const isPublic = () => settings.getBool('public_mode');
  const audienceOf = (req: FastifyRequest): Audience =>
    req.auth?.kind === 'user' ? 'member' : 'restricted';

  // Live views: members, kiosk sessions, or anyone when the site is public.
  const requireViewer = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.auth || isPublic()) return true;
    reply.code(401).send({ error: 'auth_required' });
    return false;
  };
  // History views: members or public mode — the kiosk token is live-view only.
  const requireMemberView = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.auth?.kind === 'user' || isPublic()) return true;
    reply.code(401).send({ error: 'auth_required' });
    return false;
  };
  const requireUser = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.auth?.kind === 'user') return true;
    reply.code(401).send({ error: 'auth_required' });
    return false;
  };
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.auth?.kind === 'user' && req.auth.role === 'admin') return true;
    reply.code(403).send({ error: 'admin_required' });
    return false;
  };

  // ---------- auth ----------

  app.post(
    '/api/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
      if (!username || !password) return reply.code(400).send({ error: 'missing_credentials' });
      const user = db
        .prepare('SELECT id, username, password_hash, role, must_change_password FROM users WHERE username = ?')
        .get(username) as
        | { id: number; username: string; password_hash: string; role: 'member' | 'admin'; must_change_password: number }
        | undefined;
      const ok = user ? await verifyPassword(user.password_hash, password) : false;
      if (!user || !ok) {
        // Hash anyway on unknown users to keep timing flat.
        if (!user) await hashPassword(password).catch(() => {});
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
      const token = createSession(db, 'user', user.id);
      setSessionCookie(reply, token);
      return {
        user: {
          username: user.username,
          role: user.role,
          mustChangePassword: user.must_change_password === 1,
        },
      };
    }
  );

  app.post('/api/logout', async (req, reply) => {
    destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({
    user:
      req.auth?.kind === 'user'
        ? {
            username: req.auth.username,
            role: req.auth.role,
            mustChangePassword: req.auth.mustChangePassword,
          }
        : null,
    kiosk: req.auth?.kind === 'kiosk',
    publicMode: isPublic(),
  }));

  app.post('/api/change-password', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const { current, next } = (req.body ?? {}) as { current?: string; next?: string };
    if (!current || !next || next.length < 8) {
      return reply.code(400).send({ error: 'password_too_short' });
    }
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.auth!.userId) as
      | { password_hash: string }
      | undefined;
    if (!user || !(await verifyPassword(user.password_hash, current))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
      await hashPassword(next),
      req.auth!.userId
    );
    return { ok: true };
  });

  app.post(
    '/api/kiosk/exchange',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { token } = (req.body ?? {}) as { token?: string };
      const expected = settings.get('kiosk_token');
      if (!token || !expected || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
        return reply.code(401).send({ error: 'invalid_kiosk_token' });
      }
      const session = createSession(db, 'kiosk', null);
      setSessionCookie(reply, session);
      return { ok: true };
    }
  );

  // ---------- public config + live data ----------

  app.get('/api/config', async () => ({
    siteName: settings.get('site_name', 'FleetView'),
    tileStyleUrl: settings.get('tile_style_url'),
    mapCenter: settings.get('map_center', '51.3519,0.5033'),
    mapZoom: Number(settings.get('map_zoom', '9')),
    publicMode: isPublic(),
    logoUrl: settings.get('logo_path') ? `/uploads/${settings.get('logo_path')}` : null,
  }));

  app.get('/api/state', async (req, reply) => {
    if (!requireViewer(req, reply)) return;
    reply.type('application/json');
    return live.snapshotPayload(audienceOf(req));
  });

  app.get('/api/events', (req, reply) => {
    if (!requireViewer(req, reply)) return;
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const lastIdHeader = req.headers['last-event-id'];
    const lastEventId = lastIdHeader ? Number(lastIdHeader) : undefined;
    const clientId = live.addClient(
      res,
      audienceOf(req),
      req.auth !== null,
      Number.isFinite(lastEventId) ? lastEventId : undefined
    );
    req.raw.on('close', () => live.removeClient(clientId));
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
    if (!requireMemberView(req, reply)) return;
    const q = req.query as { aircraftId?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(q.limit) || 50, 200);
    const offset = Number(q.offset) || 0;
    const audience = audienceOf(req);
    const visFilter = audience === 'member' ? '' : " AND a.visibility = 'public'";
    const where = q.aircraftId
      ? `WHERE f.aircraft_id = ? AND f.position_count > 2${visFilter}`
      : `WHERE f.position_count > 2${visFilter}`;
    const params: unknown[] = q.aircraftId ? [Number(q.aircraftId), limit, offset] : [limit, offset];
    const rows = db
      .prepare(`${flightListSql} ${where} ORDER BY f.started_at DESC LIMIT ? OFFSET ?`)
      .all(...params);
    return { flights: rows };
  });

  app.get('/api/flights/:id', async (req, reply) => {
    if (!requireMemberView(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const visFilter = audienceOf(req) === 'member' ? '' : " AND a.visibility = 'public'";
    const row = db.prepare(`${flightListSql} WHERE f.id = ?${visFilter}`).get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { flight: row };
  });

  app.get('/api/flights/:id/track', async (req, reply) => {
    if (!requireMemberView(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const visCheck = db
      .prepare('SELECT a.visibility FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE f.id = ?')
      .get(id) as { visibility: string } | undefined;
    if (!visCheck) return reply.code(404).send({ error: 'not_found' });
    if (audienceOf(req) !== 'member' && visCheck.visibility !== 'public') {
      return reply.code(404).send({ error: 'not_found' });
    }
    const points = db
      .prepare(
        'SELECT ts, lat, lon, alt_baro, alt_geom, gs, track FROM positions WHERE flight_id = ? ORDER BY ts LIMIT 50000'
      )
      .all(id) as { ts: number; lat: number; lon: number; alt_baro: number | null; alt_geom: number | null; gs: number | null; track: number | null }[];
    return {
      points: points.map((p) => [p.lon, p.lat, p.ts, p.alt_baro ?? p.alt_geom, p.gs, p.track]),
    };
  });

  // Public list of visible aircraft (for history filters and panels).
  app.get('/api/aircraft', async (req, reply) => {
    if (!requireMemberView(req, reply)) return;
    const visFilter = audienceOf(req) === 'member' ? '' : " AND visibility = 'public'";
    const rows = db
      .prepare(
        `SELECT id, hex, registration, callsign, type_name, nickname, tagline, category, color, icon, icon_path, photo_path, enabled
         FROM aircraft WHERE deleted_at IS NULL${visFilter} ORDER BY sort_order, id`
      )
      .all();
    return { aircraft: rows };
  });

  // Ticker feed: departures/landings, standing messages, aircraft taglines.
  app.get('/api/ticker', async (req, reply) => {
    if (!requireViewer(req, reply)) return;
    return { items: tickerItems(db, audienceOf(req)) };
  });

  // Club airfields for the map (base + regular markers).
  app.get('/api/airfields', async (req, reply) => {
    if (!requireViewer(req, reply)) return;
    return {
      airfields: db
        .prepare('SELECT id, code, name, lat, lon, is_base FROM airfields ORDER BY is_base DESC, code')
        .all(),
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
    // The site logo shows on the login screen, so it is always fetchable.
    const isLogo = file === settings.get('logo_path');
    if (!isLogo && !requireViewer(req, reply)) return;
    return reply.sendFile(file);
  });

  app.post('/api/admin/branding/logo', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });
    const buf = await part.toBuffer();
    let out: Buffer;
    try {
      const img = sharp(buf, { failOn: 'error', limitInputPixels: 50_000_000 });
      const meta = await img.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) {
        return reply.code(400).send({ error: 'unsupported_format' });
      }
      out = await img.resize(512, 256, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    } catch {
      return reply.code(400).send({ error: 'invalid_image' });
    }
    fs.mkdirSync(uploadsDir(), { recursive: true });
    const name = `branding-logo-${crypto.randomBytes(6).toString('hex')}.png`;
    fs.writeFileSync(path.join(uploadsDir(), name), out);
    const old = settings.get('logo_path');
    if (old) fs.rmSync(path.join(uploadsDir(), old), { force: true });
    settings.set('logo_path', name);
    audit(req, 'branding.logo', name);
    return { path: `/uploads/${name}` };
  });

  app.delete('/api/admin/branding/logo', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const old = settings.get('logo_path');
    if (old) fs.rmSync(path.join(uploadsDir(), old), { force: true });
    settings.set('logo_path', '');
    return { ok: true };
  });

  // ---------- admin ----------

  const aircraftBody = (body: Record<string, unknown>) => ({
    hex: String(body.hex ?? '').trim().toLowerCase(),
    registration: String(body.registration ?? '').trim().toUpperCase(),
    callsign: String(body.callsign ?? '').trim().toUpperCase(),
    type_name: String(body.typeName ?? '').trim(),
    icao_type: String(body.icaoType ?? '').trim().toUpperCase(),
    nickname: String(body.nickname ?? '').trim(),
    tagline: String(body.tagline ?? '').trim().slice(0, 160),
    operator: String(body.operator ?? '').trim(),
    icon: String(body.icon ?? 'low-wing'),
    color: /^#[0-9a-fA-F]{6}$/.test(String(body.color)) ? String(body.color) : '#46549a',
    enabled: body.enabled === false ? 0 : 1,
    category: body.category === 'guest' ? 'guest' : 'fleet',
    visibility: body.visibility === 'members' ? 'members' : 'public',
    track_until: typeof body.trackUntil === 'string' && body.trackUntil ? body.trackUntil : null,
    sort_order: Number(body.sortOrder) || 0,
    notes: String(body.notes ?? ''),
  });

  app.get('/api/admin/aircraft', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      aircraft: db
        .prepare('SELECT * FROM aircraft WHERE deleted_at IS NULL ORDER BY sort_order, id')
        .all(),
    };
  });

  app.post('/api/admin/aircraft', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const a = aircraftBody(req.body as Record<string, unknown>);
    if (!/^[0-9a-f]{6}$/.test(a.hex)) return reply.code(400).send({ error: 'invalid_hex' });
    const now = Date.now();
    try {
      const res = db
        .prepare(
          `INSERT INTO aircraft (hex, registration, callsign, type_name, icao_type, nickname, tagline, operator, icon, color,
             enabled, category, visibility, track_until, sort_order, notes, created_at, updated_at)
           VALUES (@hex, @registration, @callsign, @type_name, @icao_type, @nickname, @tagline, @operator, @icon, @color,
             @enabled, @category, @visibility, @track_until, @sort_order, @notes, ${now}, ${now})`
        )
        .run(a);
      audit(req, 'aircraft.create', `${a.registration} (${a.hex})`);
      return { id: Number(res.lastInsertRowid) };
    } catch (err) {
      if (String(err).includes('UNIQUE')) return reply.code(409).send({ error: 'hex_exists' });
      throw err;
    }
  });

  app.put('/api/admin/aircraft/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const a = aircraftBody(req.body as Record<string, unknown>);
    if (!/^[0-9a-f]{6}$/.test(a.hex)) return reply.code(400).send({ error: 'invalid_hex' });
    const res = db
      .prepare(
        `UPDATE aircraft SET hex=@hex, registration=@registration, callsign=@callsign, type_name=@type_name,
           icao_type=@icao_type, nickname=@nickname, tagline=@tagline, operator=@operator, icon=@icon, color=@color, enabled=@enabled,
           category=@category, visibility=@visibility, track_until=@track_until, sort_order=@sort_order, notes=@notes,
           updated_at=${Date.now()}
         WHERE id = @id AND deleted_at IS NULL`
      )
      .run({ ...a, id });
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    audit(req, 'aircraft.update', `${a.registration} (${a.hex})`);
    return { ok: true };
  });

  app.delete('/api/admin/aircraft/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    // Soft delete: history (flights/positions) stays intact.
    const res = db
      .prepare('UPDATE aircraft SET deleted_at = ?, enabled = 0 WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    audit(req, 'aircraft.delete', String(id));
    return { ok: true };
  });

  app.get('/api/admin/lookup', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const reg = String((req.query as { reg?: string }).reg ?? '').trim();
    if (!reg) return reply.code(400).send({ error: 'missing_reg' });
    return await lookupByRegistration(reg);
  });

  app.post('/api/admin/aircraft/:id/image', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const kind = (req.query as { kind?: string }).kind === 'icon' ? 'icon' : 'photo';
    const ac = db.prepare('SELECT id, icon_path, photo_path FROM aircraft WHERE id = ? AND deleted_at IS NULL').get(id) as
      | { id: number; icon_path: string | null; photo_path: string | null }
      | undefined;
    if (!ac) return reply.code(404).send({ error: 'not_found' });
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'no_file' });
    const buf = await part.toBuffer();

    // Re-encode through sharp: rejects non-images, strips metadata/payloads.
    // SVG is deliberately not accepted (stored-XSS vector).
    let out: Buffer;
    let ext: string;
    try {
      const img = sharp(buf, { failOn: 'error', limitInputPixels: 50_000_000 });
      const meta = await img.metadata();
      if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '')) {
        return reply.code(400).send({ error: 'unsupported_format' });
      }
      if (kind === 'icon') {
        out = await img
          .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();
        ext = 'png';
      } else {
        out = await img.resize(1400, 1400, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        ext = 'webp';
      }
    } catch {
      return reply.code(400).send({ error: 'invalid_image' });
    }

    fs.mkdirSync(uploadsDir(), { recursive: true });
    const name = `${id}-${kind}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir(), name), out);
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
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const kind = (req.query as { kind?: string }).kind === 'icon' ? 'icon' : 'photo';
    const col = kind === 'icon' ? 'icon_path' : 'photo_path';
    const ac = db.prepare(`SELECT ${col} AS p FROM aircraft WHERE id = ?`).get(id) as { p: string | null } | undefined;
    if (ac?.p) fs.rmSync(path.join(uploadsDir(), ac.p), { force: true });
    db.prepare(`UPDATE aircraft SET ${col} = NULL, updated_at = ? WHERE id = ?`).run(Date.now(), id);
    return { ok: true };
  });

  // ---- users ----

  app.get('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      users: db
        .prepare('SELECT id, username, role, must_change_password, created_at, last_login_at FROM users ORDER BY username')
        .all(),
    };
  });

  app.post('/api/admin/users', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { username, password, role } = (req.body ?? {}) as { username?: string; password?: string; role?: string };
    if (!username || !/^[a-zA-Z0-9._-]{2,40}$/.test(username)) return reply.code(400).send({ error: 'invalid_username' });
    if (!password || password.length < 8) return reply.code(400).send({ error: 'password_too_short' });
    try {
      const res = db
        .prepare('INSERT INTO users (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(username, await hashPassword(password), role === 'admin' ? 'admin' : 'member', Date.now());
      audit(req, 'user.create', username);
      return { id: Number(res.lastInsertRowid) };
    } catch (err) {
      if (String(err).includes('UNIQUE')) return reply.code(409).send({ error: 'username_exists' });
      throw err;
    }
  });

  app.put('/api/admin/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const { password, role } = (req.body ?? {}) as { password?: string; role?: string };
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; role: string }
      | undefined;
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (role && ['member', 'admin'].includes(role) && role !== target.role) {
      if (target.role === 'admin' && role === 'member') {
        const admins = (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get() as { c: number }).c;
        if (admins <= 1) return reply.code(400).send({ error: 'last_admin' });
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (password) {
      if (password.length < 8) return reply.code(400).send({ error: 'password_too_short' });
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
        await hashPassword(password),
        id
      );
      destroyUserSessions(db, id);
    }
    audit(req, 'user.update', target.username);
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    if (id === req.auth!.userId) return reply.code(400).send({ error: 'cannot_delete_self' });
    const target = db.prepare('SELECT username, role FROM users WHERE id = ?').get(id) as
      | { username: string; role: string }
      | undefined;
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.role === 'admin') {
      const admins = (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get() as { c: number }).c;
      if (admins <= 1) return reply.code(400).send({ error: 'last_admin' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    audit(req, 'user.delete', target.username);
    return { ok: true };
  });

  // ---- settings ----

  app.get('/api/admin/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { settings: settings.all() };
  });

  app.put('/api/admin/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as Record<string, string>;
    const wasPublic = isPublic();
    for (const [key, value] of Object.entries(body)) {
      if (!SETTINGS_WHITELIST.has(key)) continue;
      settings.set(key, String(value));
      audit(req, 'settings.update', `${key}=${value}`);
    }
    if (wasPublic && !isPublic()) {
      // Flipping private must also cut existing anonymous live streams.
      live.dropUnauthenticated();
      audit(req, 'settings.private_mode', 'anonymous live connections dropped');
    }
    return { settings: settings.all() };
  });

  app.post('/api/admin/kiosk-token/rotate', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const token = crypto.randomBytes(24).toString('base64url');
    settings.set('kiosk_token', token);
    destroyKioskSessions(db);
    audit(req, 'kiosk.rotate');
    return { token };
  });

  // ---- airfields ----

  app.get('/api/admin/airfields', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { airfields: db.prepare('SELECT * FROM airfields ORDER BY code').all() };
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
    if (!requireAdmin(req, reply)) return;
    const a = airfieldBody(req.body as Record<string, unknown>);
    if (!a.code || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) {
      return reply.code(400).send({ error: 'invalid_airfield' });
    }
    const res = db
      .prepare(
        'INSERT INTO airfields (code, name, lat, lon, elevation_ft, radius_nm, is_base) VALUES (@code, @name, @lat, @lon, @elevation_ft, @radius_nm, @is_base)'
      )
      .run(a);
    detector.reloadAirfields();
    audit(req, 'airfield.create', a.code);
    return { id: Number(res.lastInsertRowid) };
  });

  app.put('/api/admin/airfields/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const a = airfieldBody(req.body as Record<string, unknown>);
    db.prepare(
      'UPDATE airfields SET code=@code, name=@name, lat=@lat, lon=@lon, elevation_ft=@elevation_ft, radius_nm=@radius_nm, is_base=@is_base WHERE id=@id'
    ).run({ ...a, id });
    detector.reloadAirfields();
    return { ok: true };
  });

  app.delete('/api/admin/airfields/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    db.prepare('UPDATE flights SET origin_airfield_id = NULL WHERE origin_airfield_id = ?').run(id);
    db.prepare('UPDATE flights SET dest_airfield_id = NULL WHERE dest_airfield_id = ?').run(id);
    db.prepare('DELETE FROM airfields WHERE id = ?').run(id);
    detector.reloadAirfields();
    return { ok: true };
  });

  // ---- flights admin: manual route edit, merge, split, delete ----

  app.put('/api/admin/flights/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const { routeOrigin, routeDestination } = (req.body ?? {}) as { routeOrigin?: string; routeDestination?: string };
    const res = db
      .prepare("UPDATE flights SET route_origin = ?, route_destination = ?, route_source = 'manual' WHERE id = ?")
      .run(routeOrigin?.trim().toUpperCase() || null, routeDestination?.trim().toUpperCase() || null, id);
    if (res.changes === 0) return reply.code(404).send({ error: 'not_found' });
    audit(req, 'flight.route', `${id} ${routeOrigin}-${routeDestination}`);
    return { ok: true };
  });

  app.post('/api/admin/flights/merge', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { flightIds } = (req.body ?? {}) as { flightIds?: number[] };
    if (!Array.isArray(flightIds) || flightIds.length < 2) return reply.code(400).send({ error: 'need_two_flights' });
    const flights = db
      .prepare(`SELECT id, aircraft_id, started_at FROM flights WHERE id IN (${flightIds.map(() => '?').join(',')})`)
      .all(...flightIds) as { id: number; aircraft_id: number; started_at: number }[];
    if (flights.length !== flightIds.length) return reply.code(404).send({ error: 'not_found' });
    if (new Set(flights.map((f) => f.aircraft_id)).size !== 1) {
      return reply.code(400).send({ error: 'different_aircraft' });
    }
    flights.sort((a, b) => a.started_at - b.started_at);
    const target = flights[0];
    const merge = db.transaction(() => {
      for (const f of flights.slice(1)) {
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
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const { atTs } = (req.body ?? {}) as { atTs?: number };
    const flight = db.prepare('SELECT * FROM flights WHERE id = ?').get(id) as
      | { id: number; aircraft_id: number; ended_at: number | null; end_confidence: string | null }
      | undefined;
    if (!flight || !atTs) return reply.code(400).send({ error: 'invalid_split' });
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
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const del = db.transaction(() => {
      db.prepare('UPDATE positions SET flight_id = NULL WHERE flight_id = ?').run(id);
      db.prepare('DELETE FROM flights WHERE id = ?').run(id);
    });
    del();
    audit(req, 'flight.delete', String(id));
    return { ok: true };
  });

  // ---- ticker broadcasts (custom messages on the tape) ----

  app.get('/api/admin/ticker', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      events: db
        .prepare(
          `SELECT e.id, e.ts, e.text, a.registration FROM ticker_events e
           LEFT JOIN aircraft a ON a.id = e.aircraft_id ORDER BY e.ts DESC LIMIT 30`
        )
        .all(),
    };
  });

  app.post('/api/admin/ticker', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { text } = (req.body ?? {}) as { text?: string };
    if (!text?.trim() || text.trim().length > 200) return reply.code(400).send({ error: 'invalid_text' });
    postTickerMessage(db, text.trim(), (ev) => live.broadcastTicker(ev));
    audit(req, 'ticker.post', text.trim().slice(0, 80));
    return { ok: true };
  });

  app.delete('/api/admin/ticker/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    db.prepare('DELETE FROM ticker_events WHERE id = ?').run(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  // ---- kiosk messages (annotations) ----

  app.get('/api/admin/annotations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return {
      annotations: db
        .prepare(
          `SELECT an.*, a.registration, a.callsign FROM annotations an
           JOIN aircraft a ON a.id = an.aircraft_id
           ORDER BY an.created_at DESC LIMIT 50`
        )
        .all(),
    };
  });

  app.post('/api/admin/annotations', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { aircraftId, text, mode, untilTs } = (req.body ?? {}) as {
      aircraftId?: number;
      text?: string;
      mode?: string;
      untilTs?: number;
    };
    if (!aircraftId || !text?.trim() || !['until', 'next_flight'].includes(mode ?? '')) {
      return reply.code(400).send({ error: 'invalid_annotation' });
    }
    if (mode === 'until' && (!untilTs || untilTs < Date.now())) {
      return reply.code(400).send({ error: 'until_must_be_future' });
    }
    const res = db
      .prepare(
        `INSERT INTO annotations (aircraft_id, text, mode, until_ts, status, created_by, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(aircraftId, text.trim().slice(0, 200), mode, mode === 'until' ? untilTs : null, req.auth!.username, Date.now());
    audit(req, 'annotation.create', `${aircraftId}: ${text.slice(0, 60)}`);
    return { id: Number(res.lastInsertRowid) };
  });

  app.delete('/api/admin/annotations/:id', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    db.prepare("UPDATE annotations SET status = 'done' WHERE id = ?").run(id);
    audit(req, 'annotation.clear', String(id));
    return { ok: true };
  });

  // ---- status / audit ----

  app.get('/api/admin/status', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const counts = {
      positions: (db.prepare('SELECT COUNT(*) c FROM positions').get() as { c: number }).c,
      flights: (db.prepare('SELECT COUNT(*) c FROM flights').get() as { c: number }).c,
      aircraft: (db.prepare('SELECT COUNT(*) c FROM aircraft WHERE deleted_at IS NULL').get() as { c: number }).c,
      users: (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c,
    };
    return {
      poller: {
        lastPollAt: poller.lastPollAt,
        ok: poller.lastPollOk,
        error: poller.lastPollError,
      },
      recentPolls: db.prepare('SELECT * FROM poll_log ORDER BY ts DESC LIMIT 30').all(),
      counts,
      dbSizeBytes: dbFileSizeBytes(),
      sseClients: live.clientCount(),
    };
  });

  app.get('/api/admin/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { audit: db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 200').all() };
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
        // Vite emits content-hashed filenames — safe to cache hard.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split('?')[0];
    // Missing files must 404, not fall back to the SPA shell — a stale cached
    // HTML referencing an old bundle would otherwise get HTML as JavaScript.
    if (
      pathname.startsWith('/api/') ||
      pathname.startsWith('/uploads/') ||
      pathname.startsWith('/assets/') ||
      /\.[a-z0-9]+$/i.test(pathname)
    ) {
      return reply.code(404).send({ error: 'not_found' });
    }
    // SPA routes render client-side. no-cache so redeploys take effect on the
    // next load (hashed assets stay long-cacheable).
    return reply
      .type('text/html')
      .header('Cache-Control', 'no-cache')
      .send(fs.readFileSync(path.join(deps.webDist, 'index.html')));
  });

  return app;
}
