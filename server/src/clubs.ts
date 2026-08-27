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
  callsign_rules: string; // JSON [{prefix, spoken}]
  created_at: number;
}

export interface CallsignRule {
  prefix: string;
  spoken: string;
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

export function displayCallsignFor(cs: string, rules: CallsignRule[]): string {
  const clean = cs.trim().toUpperCase();
  for (const r of rules) {
    const m = new RegExp(`^${r.prefix.toUpperCase()}\\s?(\\d+)$`).exec(clean);
    if (m) return `${r.spoken.toUpperCase()} ${m[1]}`;
  }
  return clean;
}
