// Normalized position — every provider maps its own response into this shape
// at the boundary. All timestamps are ms epoch UTC and reflect the *position*
// time (provider poll time minus seen_pos), not the time we happened to poll.
export interface NormPosition {
  hex: string;
  ts: number;
  lat: number;
  lon: number;
  altBaro: number | null; // ft, pressure altitude (1013 hPa)
  altGeom: number | null; // ft, GNSS altitude
  onGround: boolean;
  gs: number | null; // kt
  track: number | null; // deg true
  baroRate: number | null; // ft/min
  geomRate: number | null;
  ias: number | null;
  tas: number | null;
  mach: number | null;
  squawk: string | null;
  callsign: string | null;
  nic: number | null;
  nacP: number | null;
  sil: number | null;
  rssi: number | null;
  messages: number | null;
  seenPos: number | null; // seconds
  wd: number | null; // wind direction
  ws: number | null; // wind speed
  navQnh: number | null;
  source: string;
  raw: unknown;
}

export interface AircraftRow {
  id: number;
  club_id: number;
  hex: string;
  registration: string;
  callsign: string;
  type_name: string;
  icao_type: string;
  nickname: string;
  tagline: string;
  description: string;
  operator: string;
  icon: string;
  icon_path: string | null;
  photo_path: string | null;
  color: string;
  enabled: number;
  category: 'fleet' | 'guest';
  visibility: 'public' | 'members';
  track_until: string | null;
  sort_order: number;
  notes: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AirfieldRow {
  id: number;
  club_id: number;
  code: string;
  name: string;
  lat: number;
  lon: number;
  elevation_ft: number;
  radius_nm: number;
  is_base: number;
}

export interface FlightRow {
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
  origin_airfield_id: number | null;
  dest_airfield_id: number | null;
  route_origin: string | null;
  route_destination: string | null;
  route_source: 'detected' | 'lookup' | 'manual' | null;
  created_at: number;
}

// A transponder sighting without a position — "awake" on the ground, the way
// FR24 shows powered-up aircraft before taxi. Never persisted; live-state only.
export interface NormPresence {
  hex: string;
  ts: number; // ms epoch = poll time - seen seconds
  seen: number; // seconds since the aggregator last heard the transponder
  callsign: string | null;
  squawk: string | null;
  onGround: boolean | null;
  source: string;
}

export type AircraftStatus = 'airborne' | 'ground' | 'awake' | 'offline';

export interface LiveAircraft {
  id: number;
  hex: string;
  registration: string;
  callsign: string; // expected callsign from admin config
  liveCallsign: string | null; // callsign currently transmitted
  typeName: string;
  nickname: string;
  tagline: string; // standing per-aircraft message ("aerobatic display ship…")
  description: string; // viewer-facing blurb ("4-seat tourer")
  category: 'fleet' | 'guest';
  visibility: 'public' | 'members';
  icon: string;
  iconUrl: string | null;
  photoUrl: string | null;
  color: string;
  status: AircraftStatus;
  awakeTs: number | null; // last transponder sighting (with or without position)
  note: string | null; // active kiosk annotation
  flightId: number | null;
  pos: {
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
  } | null;
  trail: [number, number][]; // [lon, lat] of current flight, bounded
}
