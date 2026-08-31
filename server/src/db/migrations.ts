import type { Database } from 'better-sqlite3';

interface Migration {
  id: number;
  sql: string;
}

const migrations: Migration[] = [
  {
    id: 1,
    sql: `
CREATE TABLE aircraft (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hex TEXT NOT NULL,
  registration TEXT NOT NULL DEFAULT '',
  callsign TEXT NOT NULL DEFAULT '',
  type_name TEXT NOT NULL DEFAULT '',
  icao_type TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  operator TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT 'low-wing',
  icon_path TEXT,
  photo_path TEXT,
  color TEXT NOT NULL DEFAULT '#38bdf8',
  enabled INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL DEFAULT 'fleet' CHECK(category IN ('fleet','guest')),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','members')),
  track_until TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_aircraft_hex_active ON aircraft(hex) WHERE deleted_at IS NULL;

CREATE TABLE airfields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  elevation_ft INTEGER NOT NULL DEFAULT 0,
  radius_nm REAL NOT NULL DEFAULT 3
);

CREATE TABLE flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id INTEGER NOT NULL REFERENCES aircraft(id),
  callsign TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_confidence TEXT CHECK(end_confidence IN ('confirmed','assumed','lost')),
  max_alt INTEGER,
  max_gs REAL,
  distance_nm REAL NOT NULL DEFAULT 0,
  position_count INTEGER NOT NULL DEFAULT 0,
  gap_count INTEGER NOT NULL DEFAULT 0,
  gap_seconds INTEGER NOT NULL DEFAULT 0,
  origin_airfield_id INTEGER REFERENCES airfields(id),
  dest_airfield_id INTEGER REFERENCES airfields(id),
  route_origin TEXT,
  route_destination TEXT,
  route_source TEXT CHECK(route_source IN ('detected','lookup','manual')),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_flights_aircraft ON flights(aircraft_id, started_at DESC);
CREATE INDEX idx_flights_open ON flights(ended_at) WHERE ended_at IS NULL;

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id INTEGER NOT NULL REFERENCES aircraft(id),
  flight_id INTEGER REFERENCES flights(id),
  ts INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  alt_baro INTEGER,
  alt_geom INTEGER,
  on_ground INTEGER NOT NULL DEFAULT 0,
  gs REAL,
  track REAL,
  baro_rate INTEGER,
  geom_rate INTEGER,
  ias INTEGER,
  tas INTEGER,
  mach REAL,
  squawk TEXT,
  callsign TEXT,
  nic INTEGER,
  nac_p INTEGER,
  sil INTEGER,
  rssi REAL,
  messages INTEGER,
  seen_pos REAL,
  wd INTEGER,
  ws INTEGER,
  nav_qnh REAL,
  source TEXT NOT NULL DEFAULT 'adsb.lol',
  raw TEXT
);
CREATE UNIQUE INDEX idx_positions_dedupe ON positions(aircraft_id, ts);
CREATE INDEX idx_positions_flight ON positions(flight_id);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN ('user','kiosk')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE poll_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  error TEXT,
  aircraft_returned INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
CREATE INDEX idx_poll_log_ts ON poll_log(ts);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  username TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
`,
  },
  {
    id: 2,
    sql: `
ALTER TABLE airfields ADD COLUMN is_base INTEGER NOT NULL DEFAULT 0;
UPDATE airfields SET is_base = 1 WHERE code IN ('EGTO', 'EGMD');
UPDATE aircraft SET color = '#46549a' WHERE color = '#38bdf8';
`,
  },
  {
    id: 3,
    sql: `
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id INTEGER NOT NULL REFERENCES aircraft(id),
  text TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('until','next_flight')),
  until_ts INTEGER,
  flight_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','done')),
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_annotations_aircraft ON annotations(aircraft_id, status);

CREATE TABLE ticker_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  aircraft_id INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX idx_ticker_ts ON ticker_events(ts);
`,
  },
  {
    id: 4,
    sql: `
ALTER TABLE aircraft ADD COLUMN tagline TEXT NOT NULL DEFAULT '';
UPDATE aircraft SET color = '#e32636' WHERE color = '#46549a';
UPDATE aircraft SET tagline = 'Our aerobatic display ship — where''s he displaying next?' WHERE callsign = 'INV01';
UPDATE settings SET value = 'https://tiles.openfreemap.org/styles/dark'
  WHERE key = 'tile_style_url' AND value = 'https://tiles.openfreemap.org/styles/liberty';
`,
  },
  {
    // Fleety: multi-tenant. Clubs own aircraft/airfields/branding; users are
    // global with per-club memberships. The existing installation becomes
    // club #1 ("invicta"), carrying over its branding settings.
    id: 5,
    sql: `
CREATE TABLE clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  subheading TEXT NOT NULL DEFAULT 'OPERATIONS BOARD',
  theme TEXT NOT NULL DEFAULT 'ops',
  accent TEXT NOT NULL DEFAULT '#e32636',
  logo_path TEXT,
  map_center TEXT NOT NULL DEFAULT '51.3519,0.5033',
  map_zoom REAL NOT NULL DEFAULT 9,
  tile_style_url TEXT NOT NULL DEFAULT 'https://tiles.openfreemap.org/styles/dark',
  public_mode INTEGER NOT NULL DEFAULT 0,
  kiosk_token TEXT NOT NULL,
  callsign_rules TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

INSERT INTO clubs (slug, name, subheading, logo_path, map_center, map_zoom, tile_style_url, public_mode, kiosk_token, callsign_rules, created_at)
SELECT
  'invicta',
  COALESCE((SELECT value FROM settings WHERE key = 'site_name'), 'Invicta FleetView'),
  'OPERATIONS BOARD',
  NULLIF((SELECT value FROM settings WHERE key = 'logo_path'), ''),
  COALESCE((SELECT value FROM settings WHERE key = 'map_center'), '51.3519,0.5033'),
  COALESCE(CAST((SELECT value FROM settings WHERE key = 'map_zoom') AS REAL), 9),
  COALESCE((SELECT value FROM settings WHERE key = 'tile_style_url'), 'https://tiles.openfreemap.org/styles/dark'),
  COALESCE(CAST((SELECT value FROM settings WHERE key = 'public_mode') AS INTEGER), 0),
  COALESCE((SELECT value FROM settings WHERE key = 'kiosk_token'), lower(hex(randomblob(18)))),
  '[{"prefix":"INV","spoken":"INVICTA"}]',
  ${Date.now()};

ALTER TABLE aircraft ADD COLUMN club_id INTEGER REFERENCES clubs(id);
UPDATE aircraft SET club_id = 1;
DROP INDEX idx_aircraft_hex_active;
CREATE UNIQUE INDEX idx_aircraft_hex_active ON aircraft(club_id, hex) WHERE deleted_at IS NULL;

ALTER TABLE airfields ADD COLUMN club_id INTEGER REFERENCES clubs(id);
UPDATE airfields SET club_id = 1;

ALTER TABLE ticker_events ADD COLUMN club_id INTEGER REFERENCES clubs(id);
UPDATE ticker_events SET club_id = 1;

ALTER TABLE sessions ADD COLUMN club_id INTEGER REFERENCES clubs(id);
UPDATE sessions SET club_id = 1 WHERE kind = 'kiosk';

ALTER TABLE audit_log ADD COLUMN club_id INTEGER REFERENCES clubs(id);

ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE;
ALTER TABLE users ADD COLUMN platform_admin INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_users_email ON users(email) WHERE email IS NOT NULL;
UPDATE users SET platform_admin = 1 WHERE role = 'admin';

CREATE TABLE memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, club_id)
);
INSERT INTO memberships (user_id, club_id, role, created_at)
SELECT id, 1, role, ${Date.now()} FROM users;

CREATE TABLE login_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('invite','reset')),
  club_id INTEGER REFERENCES clubs(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
`,
  },
  {
    // Viewer-facing aircraft description ("4-seat tourer — our IFR trainer"),
    // distinct from the admin-only notes field.
    id: 6,
    sql: `
ALTER TABLE aircraft ADD COLUMN description TEXT NOT NULL DEFAULT '';
`,
  },
  {
    // Landing-page waitlist. marketing_opt_in records explicit consent for
    // product updates (signup itself only ever triggers the operator ping).
    id: 7,
    sql: `
CREATE TABLE waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT ''
);
`,
  },
  {
    // Per-club kiosk preferences as JSON — room for future kiosk settings
    // without a migration each ({"viewMode": "target" | "overview"}).
    id: 8,
    sql: `
ALTER TABLE clubs ADD COLUMN kiosk_prefs TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    // Per-club display timezone (the board renders times in the club's local
    // zone, not the founding club's). IANA name; UI validates on save.
    id: 9,
    sql: `
ALTER TABLE clubs ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Europe/London';
`,
  },
  {
    // Indexes for the two hottest tenant-scoped reads: newest-first flight
    // history, and the nightly raw-JSON retention sweep.
    id: 10,
    sql: `
CREATE INDEX IF NOT EXISTS idx_flights_started ON flights(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_positions_raw ON positions(ts) WHERE raw IS NOT NULL;
`,
  },
  {
    // Per-club toggle for the significant-weather radar overlay on the live
    // and kiosk maps (client-rendered from RainViewer tiles). On by default;
    // admins can switch it off in club settings.
    id: 11,
    sql: `
ALTER TABLE clubs ADD COLUMN weather_layer INTEGER NOT NULL DEFAULT 1;
`,
  },
  {
    // Per-club "other traffic" prefs: show non-fleet ADS-B traffic near the
    // club as faded context icons on the live/kiosk map. One JSON blob (like
    // kiosk_prefs) so future knobs don't each need a migration.
    id: 12,
    sql: `
ALTER TABLE clubs ADD COLUMN other_traffic TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    // Global per-club fleet colour, with a per-aircraft override flag. Backfill
    // each club's fleet_color to its current *modal* aircraft colour, and mark
    // only the aircraft that already differ as explicit overrides — so existing
    // boards render identically after deploy, yet changing the club colour now
    // recolours every aircraft that hadn't been individually customised.
    id: 13,
    sql: `
ALTER TABLE clubs ADD COLUMN fleet_color TEXT NOT NULL DEFAULT '#e32636';
ALTER TABLE aircraft ADD COLUMN color_custom INTEGER NOT NULL DEFAULT 0;
UPDATE clubs SET fleet_color = COALESCE((
  SELECT a.color FROM aircraft a
   WHERE a.club_id = clubs.id AND a.deleted_at IS NULL
   GROUP BY a.color ORDER BY COUNT(*) DESC, a.color LIMIT 1
), fleet_color);
UPDATE aircraft SET color_custom = 1
 WHERE color <> (SELECT fleet_color FROM clubs WHERE clubs.id = aircraft.club_id);
`,
  },
  {
    // Plausibility gate (tracking/gate.ts): pos_type records the readsb source
    // class (adsb_icao / mlat / tisb_*) the normaliser used to drop; suspect
    // marks fixes the gate rejected as physically implausible — stored for
    // audit/tuning (full history is deliberate) but excluded from the detector,
    // the live board, and every aircraft-keyed read. Backfill pos_type from the
    // raw blobs that retention hasn't nulled yet.
    id: 14,
    sql: `
ALTER TABLE positions ADD COLUMN pos_type TEXT;
ALTER TABLE positions ADD COLUMN suspect INTEGER NOT NULL DEFAULT 0;
UPDATE positions SET pos_type = json_extract(raw, '$.type') WHERE raw IS NOT NULL;
`,
  },
];

export function migrate(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
  );
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id)
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
    });
    run();
  }
}
