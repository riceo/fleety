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
