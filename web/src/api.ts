// Shared API client. Every request carries the x-fleetview header — the
// server rejects mutating requests without it (CSRF defence).

export interface LivePos {
  ts: number;
  lat: number;
  lon: number;
  altBaro: number | null;
  altGeom: number | null;
  gs: number | null;
  track: number | null;
  baroRate: number | null;
  squawk: string | null;
  onGround: boolean;
}

export interface LiveAircraft {
  id: number;
  hex: string;
  registration: string;
  callsign: string;
  liveCallsign: string | null;
  typeName: string;
  nickname: string;
  tagline: string;
  description: string;
  category: 'fleet' | 'guest';
  visibility: 'public' | 'members';
  icon: string;
  iconUrl: string | null;
  photoUrl: string | null;
  color: string;
  status: 'airborne' | 'ground' | 'awake' | 'offline';
  awakeTs: number | null;
  note: string | null;
  flightId: number | null;
  pos: LivePos | null;
  trail: [number, number][];
}

export interface TickerItem {
  ts: number;
  text: string;
  aircraftId: number | null;
}

export interface LiveDelta extends Omit<LiveAircraft, 'trail'> {
  trailAppend: [number, number] | null;
  trailReset: boolean;
}

export interface CallsignRule {
  prefix: string;
  spoken: string;
}

export interface AppConfig {
  platform: boolean; // true = apex/unknown host: show the Fleety landing
  clubSlug?: string;
  siteName: string;
  subheading?: string;
  theme?: string;
  accent?: string;
  tileStyleUrl?: string;
  mapCenter?: string;
  mapZoom?: number;
  publicMode?: boolean;
  logoUrl?: string | null;
  callsignRules?: CallsignRule[];
}

export interface Me {
  user: {
    username: string;
    email: string | null;
    platformAdmin: boolean;
    role: 'member' | 'admin' | null;
    mustChangePassword: boolean;
  } | null;
  kiosk: boolean;
  publicMode: boolean;
}

export interface Flight {
  id: number;
  aircraft_id: number;
  callsign: string | null;
  started_at: number;
  ended_at: number | null;
  end_confidence: 'confirmed' | 'assumed' | 'lost' | null;
  max_alt: number | null;
  max_gs: number | null;
  distance_nm: number;
  position_count: number;
  gap_count: number;
  gap_seconds: number;
  route_origin: string | null;
  route_destination: string | null;
  route_source: string | null;
  registration: string;
  expected_callsign: string;
  type_name: string;
  color: string;
  origin_code: string | null;
  dest_code: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'x-fleetview': '1',
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) code = body.error;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, code);
  }
  return (await res.json()) as T;
}

export const post = <T,>(path: string, body?: unknown): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = <T,>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });
