import type { NormPosition } from '../types.js';
import { haversineNm } from './geo.js';

// Plausibility gate for incoming fixes. Mode-S-only club aircraft are tracked
// by multilateration (readsb `type: mlat`, nic 0), and MLAT solves from the
// free networks occasionally teleport miles — every implied-speed spike in
// captured data was an MLAT fix, while genuine ADS-B never exceeded 225 kt
// implied. So: one generous physics ceiling for everything, a stricter one for
// MLAT-class fixes, and a quarantine so a genuinely-moved aircraft still gets
// through (two mutually-consistent solves promote; a lone wild solve doesn't).
export const GATE_DEFAULTS = {
  maxKt: 400, // hard ceiling on implied groundspeed for ANY fix
  mlatKt: 250, // ceiling for MLAT/TISB fixes; beyond it they need confirmation
  slackNm: 0.5, // displacement floor — sub-slack solve jitter never gates
  candidateTtlMs: 600_000, // a quarantined solve this old can no longer promote
  minConfirmMs: 2_000, // a confirming solve must be a genuinely new solve…
  echoNm: 0.25, // …not the same one re-reported as its seen_pos grows
};

export type GateConfig = typeof GATE_DEFAULTS;

// accept: plausible continuation of the accepted track.
// promote: implausible from the track, but consistent with the quarantined
//          candidate — the aircraft really is over there; accept from here on.
// suspect: implausible and unconfirmed — store flagged, show nothing.
// echo: the current candidate re-reported (aggregators repeat a stale fix with
//       ts ≈ constant while seen_pos grows) — not new evidence, skip entirely;
//       without this, a bad solve would "confirm" itself one cycle later.
export type GateVerdict = 'accept' | 'promote' | 'suspect' | 'echo';

interface Fix {
  ts: number;
  lat: number;
  lon: number;
}

// evaluate() is pure so the poller can call it inside the DB transaction: a
// rollback leaves the gate untouched. State advances only via commitAccept /
// commitSuspect, which the poller calls AFTER the transaction commits — the
// same contract as the dedupe watermark (see poller.applyBatch).
export class PlausibilityGate {
  private last = new Map<number, Fix>(); // last ACCEPTED fix per aircraft
  private candidate = new Map<number, Fix>(); // freshest quarantined fix
  private suspectedCount = 0;
  private promotedCount = 0;
  private lastSuspectAt: number | null = null;

  // Seed from storage at boot so a restart doesn't re-accept a spike the
  // previous process had quarantined.
  prime(aircraftId: number, fix: Fix): void {
    this.last.set(aircraftId, fix);
  }

  private within(from: Fix, p: Fix, capKt: number, slackNm: number): boolean {
    const dtHr = (p.ts - from.ts) / 3_600_000;
    if (dtHr <= 0) return true; // out-of-order fixes are the watermark's business
    return haversineNm(from.lat, from.lon, p.lat, p.lon) <= capKt * dtHr + slackNm;
  }

  // MLAT/TISB solves carry no integrity figure (nic 0); unknown-typed fixes
  // with nic 0 get the strict cap too rather than the benefit of the doubt.
  private capFor(p: NormPosition, cfg: GateConfig): number {
    const mlatClass = p.posType
      ? p.posType === 'mlat' || p.posType.startsWith('tisb')
      : (p.nic ?? 0) === 0;
    return mlatClass ? cfg.mlatKt : cfg.maxKt;
  }

  evaluate(aircraftId: number, p: NormPosition, cfg: GateConfig = GATE_DEFAULTS): GateVerdict {
    const last = this.last.get(aircraftId);
    if (!last) return 'accept'; // first contact: nothing to judge against
    const cap = this.capFor(p, cfg);
    if (this.within(last, p, cap, cfg.slackNm)) return 'accept';

    const cand = this.candidate.get(aircraftId);
    if (cand) {
      const sinceCand = p.ts - cand.ts;
      if (Math.abs(sinceCand) < cfg.minConfirmMs && haversineNm(cand.lat, cand.lon, p.lat, p.lon) <= cfg.echoNm) {
        return 'echo';
      }
      if (sinceCand >= cfg.minConfirmMs && sinceCand <= cfg.candidateTtlMs && this.within(cand, p, cap, cfg.slackNm)) {
        return 'promote';
      }
    }
    return 'suspect';
  }

  commitAccept(aircraftId: number, p: NormPosition, promoted = false): void {
    // The accepted lineage wins: any pending candidate dies here, which is
    // what keeps two MLAT networks ping-ponging from ever promoting the
    // wrong one while real fixes keep flowing.
    this.candidate.delete(aircraftId);
    this.last.set(aircraftId, { ts: p.ts, lat: p.lat, lon: p.lon });
    if (promoted) this.promotedCount++;
  }

  commitSuspect(aircraftId: number, p: NormPosition): void {
    this.candidate.set(aircraftId, { ts: p.ts, lat: p.lat, lon: p.lon });
    this.suspectedCount++;
    this.lastSuspectAt = Date.now();
  }

  stats(): { suspected: number; promoted: number; lastSuspectAt: number | null } {
    return { suspected: this.suspectedCount, promoted: this.promotedCount, lastSuspectAt: this.lastSuspectAt };
  }
}
