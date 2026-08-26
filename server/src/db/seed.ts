import type { Database } from 'better-sqlite3';
import crypto from 'node:crypto';
import { hashPassword } from '../auth/passwords.js';
import { config } from '../config.js';

// Fleet from the club's ICAO INVICTA callsign licence document (Jan 2026).
// Hex codes resolved via hexdb.io. Editable in the admin panel afterwards.
const FLEET: Array<[callsign: string, type: string, reg: string, hex: string, icon: string]> = [
  ['INV01', 'Pitts Special', 'G-PSZB', '40789f', 'biplane'],
  ['INV02', 'CH7A Citabria', 'G-BSLW', '403204', 'high-wing'],
  ['INV04', 'PA28RT Arrow', 'G-CMPA', '4031cf', 'low-wing'],
  ['INV05', 'Cessna 152', 'G-FLIP', '4021ca', 'high-wing'],
  ['INV06', 'PA32-300', 'G-FRAG', '4021cd', 'low-wing'],
  ['INV07', 'Cessna 172', 'G-EDTO', '4010e3', 'high-wing'],
  ['INV08', 'PA28 Archer', 'G-KAIR', '402217', 'low-wing'],
  ['INV09', 'EV-97 Eurostar', 'G-CCTH', '404b1c', 'low-wing'],
  ['INV15', 'Cessna 152', 'G-BNRL', '402941', 'high-wing'],
  ['INV18', 'PA28 Archer', 'G-BJAG', '4011e3', 'low-wing'],
  ['INV25', 'Cessna 152', 'G-BZHE', '404371', 'high-wing'],
];

// Club bases (is_base=1) plus nearby airfields the fleet commonly uses.
const AIRFIELDS: Array<[code: string, name: string, lat: number, lon: number, elevFt: number, radiusNm: number, isBase: number]> = [
  ['EGTO', 'Rochester', 51.3519, 0.5033, 436, 3, 1],
  ['EGMD', 'Lydd', 50.9561, 0.9392, 13, 3, 1],
  ['STOKE', 'Stoke Medway', 51.4463, 0.6272, 10, 2, 0],
  ['EGKH', 'Headcorn (Lashenden)', 51.1569, 0.6417, 72, 3, 0],
  ['EGKB', 'Biggin Hill', 51.3308, 0.0325, 598, 3, 0],
  ['EGMC', 'Southend', 51.5714, 0.6956, 49, 3, 0],
];

const DEFAULT_SETTINGS: Record<string, string> = {
  public_mode: '0',
  site_name: 'Invicta FleetView',
  poll_fast_ms: '5000',
  poll_slow_ms: '30000',
  raw_retention_days: '90',
  poll_log_retention_days: '365',
  tile_style_url: 'https://tiles.openfreemap.org/styles/liberty',
  map_center: '51.3519,0.5033',
  map_zoom: '9',
  deadman_url: '',
};

export async function seed(db: Database): Promise<void> {
  const now = Date.now();

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
    'kiosk_token',
    crypto.randomBytes(24).toString('base64url')
  );

  const aircraftCount = (db.prepare('SELECT COUNT(*) c FROM aircraft').get() as { c: number }).c;
  if (aircraftCount === 0) {
    const ins = db.prepare(`
      INSERT INTO aircraft (hex, registration, callsign, type_name, icon, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    FLEET.forEach(([callsign, type, reg, hex, icon], i) => {
      ins.run(hex, reg, callsign, type, icon, i, now, now);
    });
  }

  const airfieldCount = (db.prepare('SELECT COUNT(*) c FROM airfields').get() as { c: number }).c;
  if (airfieldCount === 0) {
    const ins = db.prepare(
      'INSERT INTO airfields (code, name, lat, lon, elevation_ft, radius_nm, is_base) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const a of AIRFIELDS) ins.run(...a);
  }

  const userCount = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
  if (userCount === 0) {
    if (!config.adminUser || !config.adminPassword) {
      throw new Error(
        'No users exist and ADMIN_USER/ADMIN_PASSWORD are not set. Set them for the first run.'
      );
    }
    const hash = await hashPassword(config.adminPassword);
    db.prepare(
      'INSERT INTO users (username, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, 1, ?)'
    ).run(config.adminUser, hash, 'admin', now);
  }
}
