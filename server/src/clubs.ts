import type { Database } from 'better-sqlite3';
import { config } from './config.js';

export interface ClubRow {
  id: number;
  slug: string;
  name: string;
  subheading: string;
  theme: string;
  accent: string;
  logo_path: string | null;
  map_center: string;
  map_zoom: number;
  tile_style_url: string;
  public_mode: number;
  kiosk_token: string;
  kiosk_prefs: string;
  timezone: string;
  weather_layer: number;
  callsign_rules: string; // JSON [{prefix, spoken}]
  other_traffic: string; // JSON OtherTrafficPrefs
  created_at: number;
}

export interface CallsignRule {
  prefix: string;
  spoken: string;
}

// Ambient non-fleet traffic layer (kiosk/live map). Off by default — it costs
// an upstream area query per cycle and busies the board, so a club opts in.
export interface OtherTrafficPrefs {
  enabled: boolean;
  maxAltFt: number; // hide traffic above this altitude (keeps airway metal off a circuit-height board)
  radiusNm: number; // area-query radius around the club's map centre
  color: string; // single icon tint for every non-fleet aircraft
}

export const OTHER_TRAFFIC_DEFAULTS: OtherTrafficPrefs = {
  enabled: false,
  maxAltFt: 10_000,
  radiusNm: 30,
  color: '#7d8db5',
};

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

// Tolerant parse of the stored JSON — a corrupt value degrades to defaults,
// never throws into a request or the poll loop.
export function otherTrafficPrefs(club: Pick<ClubRow, 'other_traffic'>): OtherTrafficPrefs {
  let raw: Partial<OtherTrafficPrefs>;
  try {
    raw = JSON.parse(club.other_traffic || '{}') as Partial<OtherTrafficPrefs>;
  } catch {
    raw = {};
  }
  const d = OTHER_TRAFFIC_DEFAULTS;
  return {
    enabled: !!raw.enabled,
    maxAltFt: clampInt(raw.maxAltFt, 500, 60_000, d.maxAltFt),
    radiusNm: clampInt(raw.radiusNm, 5, 100, d.radiusNm),
    color: /^#[0-9a-fA-F]{6}$/.test(String(raw.color)) ? String(raw.color) : d.color,
  };
}

// Small in-memory cache — every request resolves its club from the Host
// header, and the table is tiny.
export class Clubs {
  private bySlug = new Map<string, ClubRow>();
  private byId = new Map<number, ClubRow>();

  constructor(private db: Database) {
    this.reload();
  }

  reload(): void {
    this.bySlug.clear();
    this.byId.clear();
    for (const row of this.db.prepare('SELECT * FROM clubs').all() as ClubRow[]) {
      this.bySlug.set(row.slug.toLowerCase(), row);
      this.byId.set(row.id, row);
    }
  }

  get(id: number): ClubRow | undefined {
    return this.byId.get(id);
  }

  slug(slug: string): ClubRow | undefined {
    return this.bySlug.get(slug.toLowerCase());
  }

  all(): ClubRow[] {
    return [...this.byId.values()];
  }

  // invicta.fleety.live -> club "invicta". Anything that isn't a club
  // subdomain of the base domain (apex, www, localhost, raw IP) returns null.
  fromHost(hostHeader: string | undefined): ClubRow | null {
    const host = (hostHeader ?? '').split(':')[0].toLowerCase();
    const base = config.baseDomain.toLowerCase();
    if (host && base && host.endsWith(`.${base}`)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && sub !== 'www' && !sub.includes('.')) {
        return this.slug(sub) ?? null;
      }
    }
    return null;
  }

  // Is this host the platform's own domain (apex/www/any *.base subdomain)?
  // Those must NEVER fall back to the default club — the apex shows the
  // Fleety landing page. The default-club fallback exists only for hosts
  // outside the base domain entirely (localhost, raw IPs, dev tunnels).
  isBaseHost(hostHeader: string | undefined): boolean {
    const host = (hostHeader ?? '').split(':')[0].toLowerCase();
    const base = config.baseDomain.toLowerCase();
    return !!host && !!base && (host === base || host.endsWith(`.${base}`));
  }

  rules(club: ClubRow): CallsignRule[] {
    try {
      const parsed = JSON.parse(club.callsign_rules) as CallsignRule[];
      return Array.isArray(parsed) ? parsed.filter((r) => r && r.prefix && r.spoken) : [];
    } catch {
      return [];
    }
  }
}

// Escape regex metacharacters so an admin-entered prefix like "G-(" is matched
// literally instead of compiling to (or throwing as) a regex.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function displayCallsignFor(cs: string, rules: CallsignRule[]): string {
  const clean = cs.trim().toUpperCase();
  for (const r of rules) {
    const m = new RegExp(`^${escapeRegex(r.prefix.toUpperCase())}\\s?(\\d+)$`).exec(clean);
    if (m) return `${r.spoken.toUpperCase()} ${m[1]}`;
  }
  return clean;
}
