import type { Database } from 'better-sqlite3';
import { haversineNm } from './geo.js';

const GAP_SEC = 120;

// Recompute a flight's aggregate stats from its positions — used after admin
// merge/split operations rather than trusting incremental counters.
export function recomputeFlightStats(db: Database, flightId: number): void {
  const rows = db
    .prepare(
      'SELECT ts, lat, lon, alt_baro, gs, callsign FROM positions WHERE flight_id = ? ORDER BY ts'
    )
    .all(flightId) as {
    ts: number;
    lat: number;
    lon: number;
    alt_baro: number | null;
    gs: number | null;
    callsign: string | null;
  }[];
  if (rows.length === 0) {
    db.prepare(
      'UPDATE flights SET position_count = 0, distance_nm = 0, gap_count = 0, gap_seconds = 0, max_alt = NULL, max_gs = NULL WHERE id = ?'
    ).run(flightId);
    return;
  }
  let distance = 0;
  let gapCount = 0;
  let gapSeconds = 0;
  let maxAlt: number | null = null;
  let maxGs: number | null = null;
  let callsign: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.alt_baro !== null) maxAlt = maxAlt === null ? r.alt_baro : Math.max(maxAlt, r.alt_baro);
    if (r.gs !== null) maxGs = maxGs === null ? r.gs : Math.max(maxGs, r.gs);
    if (r.callsign) callsign = r.callsign;
    if (i > 0) {
      const prev = rows[i - 1];
      const gap = (r.ts - prev.ts) / 1000;
      if (gap > GAP_SEC) {
        gapCount++;
        gapSeconds += Math.round(gap);
      } else {
        distance += haversineNm(prev.lat, prev.lon, r.lat, r.lon);
      }
    }
  }
  db.prepare(
    `UPDATE flights SET position_count = ?, distance_nm = ?, gap_count = ?, gap_seconds = ?,
     max_alt = ?, max_gs = ?, callsign = COALESCE(?, callsign),
     started_at = ?, ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END
     WHERE id = ?`
  ).run(
    rows.length,
    distance,
    gapCount,
    gapSeconds,
    maxAlt,
    maxGs,
    callsign,
    rows[0].ts,
    rows[rows.length - 1].ts,
    flightId
  );
}
