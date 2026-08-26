import type { Database } from 'better-sqlite3';
import { config } from '../config.js';

const HEXDB = 'https://hexdb.io/api/v1';

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': config.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.error === 'string') return null;
    return body;
  } catch {
    return null;
  }
}

export interface RegLookupResult {
  hex: string | null;
  registration: string;
  typeName: string;
  icaoType: string;
  operator: string;
}

// Resolve a registration to hex + metadata. UK G-regs are not derivable
// algorithmically, so this is a lookup-service call; the admin UI keeps the
// hex editable in case the service is stale.
export async function lookupByRegistration(reg: string): Promise<RegLookupResult> {
  const clean = reg.trim().toUpperCase();
  const result: RegLookupResult = { hex: null, registration: clean, typeName: '', icaoType: '', operator: '' };

  const hexRes = await fetch(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(clean)}`, {
    headers: { 'User-Agent': config.userAgent },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (hexRes?.ok) {
    const text = (await hexRes.text()).trim();
    if (/^[0-9a-fA-F]{6}$/.test(text)) result.hex = text.toLowerCase();
  }

  if (result.hex) {
    const info = await getJson(`${HEXDB}/aircraft/${result.hex}`);
    if (info) {
      result.typeName = String(info.Type ?? '');
      result.icaoType = String(info.ICAOTypeCode ?? '');
      result.operator = String(info.RegisteredOwners ?? '');
    }
  }
  return result;
}

// Best-effort route lookup by callsign (crowd-sourced DB: solid for airline
// callsigns, usually empty for GA). Writes the route onto the flight unless
// an admin has set one manually.
export async function lookupRouteForFlight(db: Database, flightId: number, callsign: string | null): Promise<void> {
  if (!callsign) return;
  const body = await getJson(`${HEXDB}/route/icao/${encodeURIComponent(callsign.trim())}`);
  const route = typeof body?.route === 'string' ? body.route : null;
  if (!route || !route.includes('-')) return;
  const [origin, destination] = route.split('-');
  db.prepare(
    `UPDATE flights SET route_origin = ?, route_destination = ?, route_source = 'lookup'
     WHERE id = ? AND (route_source IS NULL OR route_source = 'detected')`
  ).run(origin, destination, flightId);
}
