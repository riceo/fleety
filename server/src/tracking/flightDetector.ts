import type { Database } from 'better-sqlite3';
import type { AirfieldRow, NormPosition } from '../types.js';
import { angleDiff, bearingDeg, haversineNm } from './geo.js';

// Tunables. GA aircraft at low level drop out of aggregator coverage all the
// time, so the machine never closes a flight the instant data stops — it
// classifies the loss (landing vs coverage gap) first.
export const DETECTOR_DEFAULTS = {
  groundGsKt: 35, // at/below this and near field elevation => on the ground
  airGsKt: 55, // at/above this => flying (≈ rotation speed for a club fleet)
  airAglFt: 800, // above this AGL => flying regardless of GS
  fieldAltMarginFt: 400, // "at field elevation" tolerance (baro/geo error at circuit height)
  airfieldMatchNm: 5, // how close a fix must be to attribute an airfield
  gapRecordSec: 120, // gaps longer than this are recorded and excluded from distance
  silenceClassifySec: 300, // classify landing-vs-lost after this much silence
  lostTimeoutSec: 3600, // give up and close the flight after this much silence
  rejoinMin: 15, // reappearing airborne within this of an ended flight reopens it
  landingAglFt: 1500, // below this + descending near a field looks like a landing
};

export type DetectorConfig = typeof DETECTOR_DEFAULTS;

type State = 'ground' | 'airborne' | 'lost';

// The aircraft reference the detector works with — club scoping decides which
// airfield set applies.
export interface AircraftRef {
  id: number;
  club_id: number;
}

interface AircraftState {
  clubId: number;
  state: State;
  flightId: number | null;
  last: NormPosition | null;
  lastGroundFix: { lat: number; lon: number } | null;
}

type Classification = 'ground' | 'air' | 'ambiguous';

export interface DetectorEvents {
  onFlightStarted?: (flightId: number, aircraft: AircraftRef, callsign: string | null) => void;
  onFlightEnded?: (flightId: number, aircraft: AircraftRef) => void;
}

export class FlightDetector {
  private states = new Map<number, AircraftState>();
  private airfields = new Map<number, AirfieldRow[]>(); // clubId -> fields
  readonly cfg: DetectorConfig;

  constructor(
    private db: Database,
    cfg: Partial<DetectorConfig> = {},
    private events: DetectorEvents = {}
  ) {
    this.cfg = { ...DETECTOR_DEFAULTS, ...cfg };
    this.reloadAirfields();
    this.restore();
  }

  reloadAirfields(): void {
    this.airfields.clear();
    for (const af of this.db.prepare('SELECT * FROM airfields').all() as AirfieldRow[]) {
      const list = this.airfields.get(af.club_id) ?? [];
      list.push(af);
      this.airfields.set(af.club_id, list);
    }
  }

  // Rebuild in-memory state after a restart: open flights stay open and the
  // next tick() closes them properly if the aircraft has been silent too long.
  private restore(): void {
    const open = this.db
      .prepare(
        'SELECT f.id, f.aircraft_id, a.club_id FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE f.ended_at IS NULL'
      )
      .all() as { id: number; aircraft_id: number; club_id: number }[];
    for (const f of open) {
      const last = this.db
        .prepare('SELECT * FROM positions WHERE aircraft_id = ? ORDER BY ts DESC LIMIT 1')
        .get(f.aircraft_id) as { ts: number; lat: number; lon: number } | undefined;
      this.states.set(f.aircraft_id, {
        clubId: f.club_id,
        state: 'lost',
        flightId: f.id,
        last: last
          ? ({ ts: last.ts, lat: last.lat, lon: last.lon, gs: null, track: null } as NormPosition)
          : null,
        lastGroundFix: null,
      });
    }
  }

  private stateFor(ac: AircraftRef): AircraftState {
    let s = this.states.get(ac.id);
    if (!s) {
      s = { clubId: ac.club_id, state: 'ground', flightId: null, last: null, lastGroundFix: null };
      this.states.set(ac.id, s);
    }
    s.clubId = ac.club_id;
    return s;
  }

  nearestAirfield(clubId: number, lat: number, lon: number): { af: AirfieldRow; distNm: number } | null {
    let best: { af: AirfieldRow; distNm: number } | null = null;
    for (const af of this.airfields.get(clubId) ?? []) {
      const d = haversineNm(lat, lon, af.lat, af.lon);
      if (!best || d < best.distNm) best = { af, distNm: d };
    }
    return best;
  }

  private altFt(p: NormPosition): number | null {
    return p.altGeom ?? p.altBaro;
  }

  classify(clubId: number, p: NormPosition): Classification {
    if (p.onGround) return 'ground';
    const near = this.nearestAirfield(clubId, p.lat, p.lon);
    const alt = this.altFt(p);
    if (alt !== null && near && near.distNm <= this.cfg.airfieldMatchNm) {
      const agl = alt - near.af.elevation_ft;
      if (agl > this.cfg.airAglFt) return 'air';
      if (p.gs !== null && p.gs <= this.cfg.groundGsKt && agl <= this.cfg.fieldAltMarginFt) return 'ground';
    }
    if (p.gs !== null && p.gs >= this.cfg.airGsKt) return 'air';
    if (alt !== null && (!near || near.distNm > this.cfg.airfieldMatchNm)) {
      // Away from any known airfield with a real altitude: call it airborne.
      return 'air';
    }
    if (p.gs !== null && p.gs <= this.cfg.groundGsKt && alt === null) return 'ground';
    return 'ambiguous';
  }

  private looksLikeLanding(clubId: number, p: NormPosition): { landing: boolean; airfieldId: number | null } {
    const near = this.nearestAirfield(clubId, p.lat, p.lon);
    if (!near || near.distNm > 10) return { landing: false, airfieldId: null };
    const alt = this.altFt(p);
    const agl = alt !== null ? alt - near.af.elevation_ft : null;
    const rate = p.baroRate ?? p.geomRate;
    const descending = rate !== null && rate < -100;
    const low = agl !== null && agl < this.cfg.landingAglFt;
    const inside = near.distNm <= near.af.radius_nm;
    const toward =
      p.track !== null && angleDiff(p.track, bearingDeg(p.lat, p.lon, near.af.lat, near.af.lon)) < 60;
    if (low && (inside || ((descending || (agl !== null && agl < 700)) && toward))) {
      return { landing: true, airfieldId: near.af.id };
    }
    return { landing: false, airfieldId: null };
  }

  private airfieldIdNear(clubId: number, lat: number, lon: number): number | null {
    const near = this.nearestAirfield(clubId, lat, lon);
    return near && near.distNm <= this.cfg.airfieldMatchNm ? near.af.id : null;
  }

  private codeFor(clubId: number, airfieldId: number | null): string | null {
    if (airfieldId === null) return null;
    return (this.airfields.get(clubId) ?? []).find((a) => a.id === airfieldId)?.code ?? null;
  }

  private startFlight(ac: AircraftRef, p: NormPosition, s: AircraftState): void {
    // A flight restarting shortly after the previous one ended (touch-and-go,
    // stop-and-go circuits) continues the same flight instead of fragmenting.
    const recent = this.db
      .prepare(
        `SELECT id, ended_at, end_confidence FROM flights
         WHERE aircraft_id = ? AND ended_at IS NOT NULL AND end_confidence != 'lost'
         ORDER BY ended_at DESC LIMIT 1`
      )
      .get(ac.id) as { id: number; ended_at: number; end_confidence: string } | undefined;
    const nearRecentEnd = (): boolean => {
      if (!recent) return false;
      const lastFix = this.db
        .prepare('SELECT lat, lon FROM positions WHERE flight_id = ? ORDER BY ts DESC LIMIT 1')
        .get(recent.id) as { lat: number; lon: number } | undefined;
      return !lastFix || haversineNm(lastFix.lat, lastFix.lon, p.lat, p.lon) < 10;
    };
    if (recent && p.ts - recent.ended_at < this.cfg.rejoinMin * 60_000 && nearRecentEnd()) {
      this.db
        .prepare(
          `UPDATE flights SET ended_at = NULL, end_confidence = NULL, dest_airfield_id = NULL,
           route_destination = CASE WHEN route_source = 'manual' THEN route_destination ELSE NULL END
           WHERE id = ?`
        )
        .run(recent.id);
      s.flightId = recent.id;
      s.state = 'airborne';
      return;
    }

    const originFix = s.lastGroundFix ?? { lat: p.lat, lon: p.lon };
    const originId = this.airfieldIdNear(s.clubId, originFix.lat, originFix.lon);
    const originCode = this.codeFor(s.clubId, originId);
    const res = this.db
      .prepare(
        `INSERT INTO flights (aircraft_id, callsign, started_at, origin_airfield_id, route_origin, route_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(ac.id, p.callsign, p.ts, originId, originCode, originCode ? 'detected' : null, Date.now());
    s.flightId = Number(res.lastInsertRowid);
    s.state = 'airborne';
    this.events.onFlightStarted?.(s.flightId, ac, p.callsign);
  }

  private endFlight(
    s: AircraftState,
    ac: AircraftRef,
    endedAt: number,
    confidence: 'confirmed' | 'assumed' | 'lost',
    destAirfieldId: number | null
  ): void {
    if (s.flightId === null) return;
    const destCode = this.codeFor(s.clubId, destAirfieldId);
    this.db
      .prepare(
        `UPDATE flights SET ended_at = ?, end_confidence = ?, dest_airfield_id = ?,
         route_destination = CASE WHEN route_source = 'manual' THEN route_destination ELSE COALESCE(?, route_destination) END
         WHERE id = ?`
      )
      .run(endedAt, confidence, destAirfieldId, destCode, s.flightId);
    this.events.onFlightEnded?.(s.flightId, ac);
    s.flightId = null;
    s.state = 'ground';
  }

  private addToFlight(s: AircraftState, p: NormPosition): void {
    if (s.flightId === null || !s.last) return;
    const gapSec = (p.ts - s.last.ts) / 1000;
    const isGap = gapSec > this.cfg.gapRecordSec;
    const segNm = isGap ? 0 : haversineNm(s.last.lat, s.last.lon, p.lat, p.lon);
    this.db
      .prepare(
        `UPDATE flights SET
           position_count = position_count + 1,
           distance_nm = distance_nm + ?,
           gap_count = gap_count + ?,
           gap_seconds = gap_seconds + ?,
           max_alt = CASE WHEN ? IS NULL THEN max_alt ELSE MAX(COALESCE(max_alt, 0), ?) END,
           max_gs = CASE WHEN ? IS NULL THEN max_gs ELSE MAX(COALESCE(max_gs, 0), ?) END,
           callsign = COALESCE(?, callsign)
         WHERE id = ?`
      )
      .run(
        segNm,
        isGap ? 1 : 0,
        isGap ? Math.round(gapSec) : 0,
        p.altBaro,
        p.altBaro,
        p.gs,
        p.gs,
        p.callsign,
        s.flightId
      );
  }

  private plausibleContinuation(last: NormPosition, p: NormPosition): boolean {
    const gapHr = (p.ts - last.ts) / 3_600_000;
    const speed = last.gs ?? 120;
    const maxNm = gapHr * speed * 1.5 + 5;
    return haversineNm(last.lat, last.lon, p.lat, p.lon) <= maxNm;
  }

  // Feed one stored position (chronological per aircraft). Returns the flight
  // id the position belongs to (null for non-flight ground movement).
  onPosition(ac: AircraftRef, p: NormPosition): number | null {
    const s = this.stateFor(ac);
    if (s.last && p.ts <= s.last.ts) return s.flightId; // stale/duplicate fix

    const cls = this.classify(s.clubId, p);

    if (s.state === 'ground') {
      if (cls === 'air') {
        this.startFlight(ac, p, s);
        this.addToFlightFirst(s, p);
      } else {
        s.lastGroundFix = { lat: p.lat, lon: p.lon };
      }
    } else {
      // airborne or lost
      const gapSec = s.last ? (p.ts - s.last.ts) / 1000 : 0;
      const brokenContinuation =
        s.last &&
        gapSec > this.cfg.gapRecordSec &&
        (gapSec > this.cfg.lostTimeoutSec || (!this.plausibleContinuation(s.last, p) && gapSec > 600));

      if (brokenContinuation) {
        const landing = s.last
          ? this.looksLikeLanding(s.clubId, s.last)
          : { landing: false, airfieldId: null };
        this.endFlight(s, ac, s.last!.ts, landing.landing ? 'assumed' : 'lost', landing.airfieldId);
        s.lastGroundFix = null;
        if (cls === 'air') {
          this.startFlight(ac, p, s);
          this.addToFlightFirst(s, p);
        } else {
          s.lastGroundFix = { lat: p.lat, lon: p.lon };
        }
      } else if (cls === 'ground') {
        // Confirmed landing: this fix still belongs to the flight.
        this.addToFlight(s, p);
        const flightId = s.flightId;
        this.endFlight(s, ac, p.ts, 'confirmed', this.airfieldIdNear(s.clubId, p.lat, p.lon));
        s.lastGroundFix = { lat: p.lat, lon: p.lon };
        s.last = p;
        return flightId;
      } else {
        s.state = 'airborne';
        this.addToFlight(s, p);
      }
    }

    s.last = p;
    return s.flightId;
  }

  private addToFlightFirst(s: AircraftState, p: NormPosition): void {
    if (s.flightId === null) return;
    this.db
      .prepare(
        `UPDATE flights SET position_count = position_count + 1,
           max_alt = CASE WHEN ? IS NULL THEN max_alt ELSE MAX(COALESCE(max_alt, 0), ?) END,
           max_gs = CASE WHEN ? IS NULL THEN max_gs ELSE MAX(COALESCE(max_gs, 0), ?) END
         WHERE id = ?`
      )
      .run(p.altBaro, p.altBaro, p.gs, p.gs, s.flightId);
  }

  // Called every poll cycle regardless of data, to progress silence handling.
  tick(now: number): void {
    for (const [aircraftId, s] of this.states) {
      if (!s.last || s.flightId === null) continue;
      const ac: AircraftRef = { id: aircraftId, club_id: s.clubId };
      const silenceSec = (now - s.last.ts) / 1000;
      if (s.state === 'airborne' && silenceSec > this.cfg.silenceClassifySec) {
        const landing = this.looksLikeLanding(s.clubId, s.last);
        if (landing.landing) {
          this.endFlight(s, ac, s.last.ts, 'assumed', landing.airfieldId);
        } else {
          s.state = 'lost';
        }
      } else if (s.state === 'lost' && silenceSec > this.cfg.lostTimeoutSec) {
        this.endFlight(s, ac, s.last.ts, 'lost', null);
      }
    }
  }

  currentFlightId(aircraftId: number): number | null {
    return this.states.get(aircraftId)?.flightId ?? null;
  }

  currentState(aircraftId: number): State {
    return this.states.get(aircraftId)?.state ?? 'ground';
  }
}
