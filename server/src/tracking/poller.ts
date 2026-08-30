import type { Database } from 'better-sqlite3';
import type { AdsbProvider, ProviderStates } from '../providers/index.js';
import type { Settings } from '../settings.js';
import type { LiveBus } from '../live/liveBus.js';
import type { AircraftRow, NormPosition, OtherAircraft } from '../types.js';
import { otherTrafficPrefs } from '../clubs.js';
import { FlightDetector } from './flightDetector.js';
import { filterOtherTraffic } from './otherTraffic.js';
import { activeNotesByClub } from '../annotations.js';

const MAX_BACKOFF_MS = 5 * 60_000;
const HEXES_PER_CALL = 100;
// A sighting older than this doesn't count as "heard" for failover purposes —
// a primary returning rotting cached records must not suppress a failover
// that might have live data.
const HEARD_FRESH_SEC = 60;
// After a failover error, leave it alone for a while (a hanging failover must
// not add its timeout to every cycle).
const FAILOVER_COOLDOWN_MS = 60_000;
// When the primary keeps failing while the failover rescues cycles, probe the
// primary only every Nth cycle instead of hammering it at full cadence.
const PRIMARY_PROBE_EVERY = 6;
// Rescue tier (ADSBx, paid per request): probe an aircraft at most this often.
const RESCUE_MIN_INTERVAL_MS = 120_000;
const RESCUE_MAX_PER_CYCLE = 2;
// Ambient other-traffic area query: at most this often per club — context can
// lag a few seconds; the fleet keeps the fast cadence.
const OTHER_TRAFFIC_MIN_INTERVAL_MS = 10_000;

export interface RescueTier {
  provider: AdsbProvider;
  monthlyBudget: number; // hard cap on requests per UTC month
}

// ONE poller for the whole platform: every tracked hex across every club is
// batched into shared upstream calls, so API load stays near-constant no
// matter how many clubs join. Results fan out to each club that tracks the
// aircraft (two clubs watching the same airframe share the same fix).
export class Poller {
  private lastTsByAircraft = new Map<number, number>();
  private consecutiveErrors = 0;
  private primaryErrorStreak = 0;
  private cycleCount = 0;
  private failoverCursor = 0;
  private failoverCooldownUntil = 0;
  private rescueCooldownUntil = 0;
  private lastRescueProbe = new Map<string, number>();
  private lastRescueErrLogAt = 0;
  private lastOkLogAt = 0;
  private lastFailoverErrLogAt = 0;
  private lastTrafficFetchByClub = new Map<number, number>();
  private lastTrafficErrLogAt = 0;
  private lastDeadmanAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  lastPollAt = 0;
  lastPollOk = false;
  lastPollError: string | null = null;

  constructor(
    private db: Database,
    // providers[0] is the primary; providers[1] is the failover, queried only
    // for hexes the primary didn't (freshly) hear.
    private providers: AdsbProvider[],
    private settings: Settings,
    private detector: FlightDetector,
    private live: LiveBus,
    // Optional paid rescue tier: fired ONLY for aircraft whose open flight
    // vanished from every free network, under a hard persistent budget.
    private rescue?: RescueTier
  ) {
    // Prime dedupe watermarks so a restart doesn't re-store stale fixes.
    const rows = this.db
      .prepare('SELECT aircraft_id, MAX(ts) ts FROM positions GROUP BY aircraft_id')
      .all() as { aircraft_id: number; ts: number }[];
    for (const r of rows) this.lastTsByAircraft.set(r.aircraft_id, r.ts);
  }

  start(): void {
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private trackedAircraft(): AircraftRow[] {
    // Guests past their track-until date drop out automatically (but keep
    // their history; admins can re-enable).
    this.db
      // Auto-expire a lapsed guest. The date is kept (so the admin can see why
      // it went dark); the enable toggle clears a past date on re-enable, so
      // this won't re-fire against an aircraft the admin turns back on.
      .prepare(
        "UPDATE aircraft SET enabled = 0, updated_at = ? WHERE track_until IS NOT NULL AND track_until < date('now') AND enabled = 1"
      )
      .run(Date.now());
    return this.db
      .prepare('SELECT * FROM aircraft WHERE deleted_at IS NULL ORDER BY club_id, sort_order, id')
      .all() as AircraftRow[];
  }

  private logPoll(
    providerName: string,
    ok: boolean,
    status: number | null,
    error: string | null,
    count: number,
    durationMs: number
  ): void {
    const now = Date.now();
    if (ok && now - this.lastOkLogAt < 60_000) return;
    if (ok) this.lastOkLogAt = now;
    this.db
      .prepare(
        'INSERT INTO poll_log (ts, provider, ok, status, error, aircraft_returned, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(now, providerName, ok ? 1 : 0, status, error, count, durationMs);
  }

  private deadmanPing(): void {
    const url = this.settings.get('deadman_url');
    if (!url || Date.now() - this.lastDeadmanAt < 60_000) return;
    this.lastDeadmanAt = Date.now();
    fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) }).catch(() => {});
  }

  private insertPosition(aircraftId: number, p: NormPosition, flightId: number | null): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO positions
         (aircraft_id, flight_id, ts, lat, lon, alt_baro, alt_geom, on_ground, gs, track, baro_rate, geom_rate,
          ias, tas, mach, squawk, callsign, nic, nac_p, sil, rssi, messages, seen_pos, wd, ws, nav_qnh, source, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        aircraftId,
        flightId,
        p.ts,
        p.lat,
        p.lon,
        p.altBaro,
        p.altGeom,
        p.onGround ? 1 : 0,
        p.gs,
        p.track,
        p.baroRate,
        p.geomRate,
        p.ias,
        p.tas,
        p.mach,
        p.squawk,
        p.callsign,
        p.nic,
        p.nacP,
        p.sil,
        p.rssi,
        p.messages,
        p.seenPos,
        p.wd,
        p.ws,
        p.navQnh,
        p.source,
        JSON.stringify(p.raw)
      );
  }

  // Apply one provider batch: positions in a transaction (detector + storage +
  // live), then presence fan-out (live-state only). Returns whether anything
  // suggests an active flight.
  private applyBatch(states: ProviderStates, byHex: Map<string, AircraftRow[]>): boolean {
    let anyActive = false;
    // The in-memory dedupe watermark and live/UI state are advanced only AFTER
    // the DB transaction commits. Otherwise a rollback (realistically disk-full)
    // would leave the watermark ahead of the rolled-back inserts and silently
    // lose those fixes forever.
    const applied: { clubId: number; acId: number; p: NormPosition; flightId: number | null }[] = [];
    const apply = this.db.transaction(() => {
      for (const p of states.positions) {
        for (const ac of byHex.get(p.hex) ?? []) {
          const lastTs = this.lastTsByAircraft.get(ac.id) ?? 0;
          if (p.ts <= lastTs) continue; // stale fix repeated by the aggregator
          const flightId = this.detector.onPosition({ id: ac.id, club_id: ac.club_id }, p);
          this.insertPosition(ac.id, p, flightId);
          applied.push({ clubId: ac.club_id, acId: ac.id, p, flightId });
        }
      }
    });
    apply(); // throws (and rolls back) on failure — the post-commit block is skipped
    for (const a of applied) {
      this.lastTsByAircraft.set(a.acId, a.p.ts);
      this.live.update(a.clubId, a.acId, a.p, a.flightId);
      if (a.flightId !== null && a.p.ts > Date.now() - 120_000) anyActive = true;
    }
    for (const pr of states.presences) {
      for (const ac of byHex.get(pr.hex) ?? []) {
        this.live.presence(ac.club_id, ac.id, pr.ts);
      }
    }
    return anyActive;
  }

  // Persistent request budget for the rescue tier — survives restarts (we
  // redeploy often; an in-memory counter would quietly reset the meter).
  private rescueUsage(): { month: string; used: number; day: string; usedToday: number } {
    const now = new Date();
    const month = now.toISOString().slice(0, 7);
    const day = now.toISOString().slice(0, 10);
    let u: { month: string; used: number; day: string; usedToday: number };
    try {
      u = JSON.parse(this.settings.get('adsbx_usage', '{}'));
    } catch {
      u = { month, used: 0, day, usedToday: 0 };
    }
    if (u.month !== month) u = { month, used: 0, day, usedToday: 0 };
    if (u.day !== day) {
      u.day = day;
      u.usedToday = 0;
    }
    if (!Number.isFinite(u.used)) u.used = 0;
    if (!Number.isFinite(u.usedToday)) u.usedToday = 0;
    return u;
  }

  private rescueBudgetAllows(n: number): boolean {
    if (!this.rescue) return false;
    const u = this.rescueUsage();
    // Daily throttle at 2x the monthly average smooths bursts while the
    // monthly cap stays absolute.
    const dailyCap = Math.ceil((this.rescue.monthlyBudget / 30) * 2);
    return u.used + n <= this.rescue.monthlyBudget && u.usedToday + n <= dailyCap;
  }

  private spendRescue(n: number): void {
    const u = this.rescueUsage();
    u.used += n;
    u.usedToday += n;
    this.settings.set('adsbx_usage', JSON.stringify(u));
  }

  // Vanished-in-flight rescue: an aircraft with an OPEN flight that no free
  // network freshly hears gets an ADSBx probe, at most every 2 minutes, at
  // most 2 hexes per cycle, inside the hard budget. Requests are spent even
  // when the call fails — RapidAPI meters attempts, so must we.
  private async rescuePass(byHex: Map<string, AircraftRow[]>, freshlyHeard: Set<string>): Promise<boolean> {
    if (!this.rescue || Date.now() < this.rescueCooldownUntil) return false;
    const now = Date.now();
    const candidates = [...byHex.entries()]
      .filter(
        ([hex, acs]) =>
          !freshlyHeard.has(hex) &&
          acs.some((ac) => this.detector.currentFlightId(ac.id) !== null) &&
          now - (this.lastRescueProbe.get(hex) ?? 0) >= RESCUE_MIN_INTERVAL_MS
      )
      .map(([hex]) => hex)
      .slice(0, RESCUE_MAX_PER_CYCLE);
    if (candidates.length === 0 || !this.rescueBudgetAllows(candidates.length)) return false;
    this.spendRescue(candidates.length);
    for (const h of candidates) this.lastRescueProbe.set(h, now);
    try {
      const states = await this.rescue.provider.fetchStates(candidates);
      const active = this.applyBatch(states, byHex);
      // A partial failure (e.g. a 429 on one hex) still keeps the salvaged fix,
      // but backs the paid provider off so we don't keep metering into an error.
      if (states.partial) this.rescueCooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS;
      return active;
    } catch (err) {
      this.rescueCooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS;
      if (Date.now() - this.lastRescueErrLogAt > 5 * 60_000) {
        this.lastRescueErrLogAt = Date.now();
        this.logPoll(this.rescue.provider.name, false, null, String(err), 0, 0);
      }
      return false;
    }
  }

  // Admin-triggered ADSBx probe for one aircraft. The automatic tier only
  // fires for OPEN flights, so a flight that BEGINS inside a free-network
  // blackspot never triggers it — this is the bootstrap: one manual hit that,
  // if it finds the aircraft airborne, opens the flight and hands coverage to
  // the automatic tier. Spends the same budget; bypasses the interval floor.
  async manualRescue(aircraftId: number): Promise<
    | { ok: true; found: boolean; posAgeSec: number | null; used: number; budget: number }
    | { ok: false; error: 'not_configured' | 'unknown_aircraft' | 'budget_exhausted' | 'provider_error' }
  > {
    if (!this.rescue) return { ok: false, error: 'not_configured' };
    const target = this.db
      .prepare('SELECT * FROM aircraft WHERE id = ? AND deleted_at IS NULL')
      .get(aircraftId) as AircraftRow | undefined;
    if (!target) return { ok: false, error: 'unknown_aircraft' };
    if (!this.rescueBudgetAllows(1)) return { ok: false, error: 'budget_exhausted' };

    const hex = target.hex.toLowerCase();
    // Fan out to every club tracking this airframe, like a normal cycle.
    const sharing = this.db
      .prepare('SELECT * FROM aircraft WHERE lower(hex) = ? AND deleted_at IS NULL AND enabled = 1')
      .all(hex) as AircraftRow[];
    const byHex = new Map<string, AircraftRow[]>([[hex, sharing.length > 0 ? sharing : [target]]]);

    this.spendRescue(1); // RapidAPI meters attempts, so spend before the call
    this.lastRescueProbe.set(hex, Date.now()); // automatic tier won't double-probe
    const started = Date.now();
    let states: ProviderStates;
    try {
      states = await this.rescue.provider.fetchStates([hex]);
    } catch (err) {
      this.db
        .prepare(
          'INSERT INTO poll_log (ts, provider, ok, status, error, aircraft_returned, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(Date.now(), `${this.rescue.provider.name} (manual)`, 0, null, String(err), 0, Date.now() - started);
      return { ok: false, error: 'provider_error' };
    }
    this.applyBatch(states, byHex);
    this.detector.tick(Date.now());
    this.live.refreshStatuses();
    this.live.flush();
    this.db
      .prepare(
        'INSERT INTO poll_log (ts, provider, ok, status, error, aircraft_returned, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(Date.now(), `${this.rescue.provider.name} (manual)`, 1, 200, null, states.positions.length, Date.now() - started);

    const freshest = states.positions
      .filter((p) => p.hex === hex)
      .sort((a, b) => b.ts - a.ts)[0];
    const presence = states.presences.find((p) => p.hex === hex);
    const u = this.rescueUsage();
    return {
      ok: true,
      found: !!freshest || !!presence,
      posAgeSec: freshest ? Math.max(0, Math.round((Date.now() - freshest.ts) / 1000)) : null,
      used: u.used,
      budget: this.rescue.monthlyBudget,
    };
  }

  // Ambient other-traffic pass: for clubs that opted in, one area query around
  // the club's map centre, published to the live bus only — never stored.
  // Fully self-contained error handling: a traffic failure must never mark the
  // fleet poll unhealthy, and must never throw into the cycle.
  private async otherTrafficPass(): Promise<void> {
    let rows: { id: number; map_center: string; other_traffic: string }[];
    try {
      rows = this.db
        .prepare('SELECT id, map_center, other_traffic FROM clubs')
        .all() as { id: number; map_center: string; other_traffic: string }[];
    } catch {
      return;
    }
    for (const c of rows) {
      try {
        const prefs = otherTrafficPrefs(c);
        if (!prefs.enabled) {
          this.live.setOtherTraffic(c.id, []); // authoritative clear (no-op when already empty)
          continue;
        }
        if (this.live.clientCount(c.id) === 0) continue; // nobody watching: skip the upstream spend
        const now = Date.now();
        if (now - (this.lastTrafficFetchByClub.get(c.id) ?? 0) < OTHER_TRAFFIC_MIN_INTERVAL_MS) continue;
        const [lat, lon] = c.map_center.split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        this.lastTrafficFetchByClub.set(c.id, now);
        let area: OtherAircraft[] | null = null;
        for (const p of this.providers) {
          if (!p.fetchArea) continue;
          try {
            area = await p.fetchArea(lat, lon, prefs.radiusNm);
            break;
          } catch (err) {
            if (Date.now() - this.lastTrafficErrLogAt > 5 * 60_000) {
              this.lastTrafficErrLogAt = Date.now();
              this.logPoll(`${p.name} (traffic)`, false, (err as { status?: number }).status ?? null, String(err), 0, 0);
            }
          }
        }
        if (!area) continue; // both networks down: keep the last list; clients age entries out
        const own = new Set(
          (
            this.db
              .prepare('SELECT lower(hex) h FROM aircraft WHERE club_id = ? AND deleted_at IS NULL')
              .all(c.id) as { h: string }[]
          ).map((r) => r.h)
        );
        this.live.setOtherTraffic(c.id, filterOtherTraffic(area, own, prefs, lat, lon));
      } catch {
        /* one club's traffic failing must not starve the rest */
      }
    }
  }

  // One full poll cycle. Public so tests can drive it directly.
  async runCycle(): Promise<void> {
    const started = Date.now();
    this.cycleCount++;
    let anyActive = false;
    try {
      const aircraft = this.trackedAircraft();

      // Every club syncs its roster — including clubs whose roster just
      // emptied, so their removal deltas still go out.
      const byClub = new Map<number, AircraftRow[]>();
      for (const c of this.db.prepare('SELECT id FROM clubs').all() as { id: number }[]) {
        byClub.set(c.id, []);
      }
      for (const a of aircraft) {
        byClub.get(a.club_id)?.push(a) ?? byClub.set(a.club_id, [a]);
      }
      for (const [clubId, rows] of byClub) this.live.syncAircraftList(clubId, rows);

      const enabled = aircraft.filter((a) => a.enabled === 1);
      const byHex = new Map<string, AircraftRow[]>();
      for (const a of enabled) {
        const key = a.hex.toLowerCase();
        const list = byHex.get(key) ?? [];
        list.push(a);
        byHex.set(key, list);
      }

      if (byHex.size > 0) {
        const hexes = [...byHex.keys()];
        const primary = this.providers[0];
        const primaryStates: ProviderStates = { positions: [], presences: [] };
        let primaryError: unknown = null;

        // Soft backoff: a repeatedly failing primary (while the failover
        // rescues) is probed occasionally, not hammered every cycle.
        const probePrimary =
          this.primaryErrorStreak < 3 || this.cycleCount % PRIMARY_PROBE_EVERY === 0;
        if (probePrimary) {
          try {
            for (let i = 0; i < hexes.length; i += HEXES_PER_CALL) {
              const chunk = await primary.fetchStates(hexes.slice(i, i + HEXES_PER_CALL));
              primaryStates.positions.push(...chunk.positions);
              primaryStates.presences.push(...chunk.presences);
            }
            this.primaryErrorStreak = 0;
          } catch (err) {
            primaryError = err;
            this.primaryErrorStreak++;
          }
        } else {
          primaryError = new Error('primary in soft backoff');
        }

        // Apply the primary's data immediately — a slow failover must never
        // delay fresh positions reaching the board.
        anyActive = this.applyBatch(primaryStates, byHex) || anyActive;

        // Failover: only for hexes the primary didn't FRESHLY hear (stale
        // cached records don't count), rotating through the missing set so a
        // >100-hex outage still covers everything across cycles.
        const failover = this.providers[1];
        const freshlyHeard = new Set([
          ...primaryStates.positions.filter((p) => (p.seenPos ?? 0) <= HEARD_FRESH_SEC).map((p) => p.hex),
          ...primaryStates.presences.filter((p) => p.seen <= HEARD_FRESH_SEC).map((p) => p.hex),
        ]);
        const missing = hexes.filter((h) => !freshlyHeard.has(h));
        let rescued = false;
        // Rescue is gated on fresh POSITIONS only, never presences: an aircraft
        // heard as a bare Mode-S sighting with no position is exactly the
        // vanished-in-flight case the paid tier exists to cover.
        const positionFresh = new Set(
          primaryStates.positions.filter((p) => (p.seenPos ?? 0) <= HEARD_FRESH_SEC).map((p) => p.hex)
        );
        if (failover && missing.length > 0 && Date.now() >= this.failoverCooldownUntil) {
          const start = this.failoverCursor % missing.length;
          const window = missing.slice(start, start + HEXES_PER_CALL);
          if (window.length < HEXES_PER_CALL && missing.length > window.length) {
            window.push(...missing.slice(0, Math.min(HEXES_PER_CALL - window.length, start)));
          }
          this.failoverCursor = (start + HEXES_PER_CALL) % Math.max(missing.length, 1);
          try {
            const fo = await failover.fetchStates(window);
            anyActive = this.applyBatch(fo, byHex) || anyActive;
            rescued = fo.positions.length > 0 || fo.presences.length > 0;
            for (const x of fo.positions) if ((x.seenPos ?? 0) <= HEARD_FRESH_SEC) positionFresh.add(x.hex);
          } catch (foErr) {
            this.failoverCooldownUntil = Date.now() + FAILOVER_COOLDOWN_MS;
            if (Date.now() - this.lastFailoverErrLogAt > 5 * 60_000) {
              this.lastFailoverErrLogAt = Date.now();
              this.logPoll(failover.name, false, null, String(foErr), 0, Date.now() - started);
            }
          }
        }

        anyActive = (await this.rescuePass(byHex, positionFresh)) || anyActive;

        this.detector.tick(Date.now());

        if (primaryError) {
          // Honest logging: the primary failed — record it with its HTTP
          // status; never credit it with the failover's data.
          const status = (primaryError as { status?: number }).status ?? null;
          this.logPoll(primary.name, false, status, String(primaryError), 0, Date.now() - started);
          if (rescued || this.providers[1]) {
            // The platform is still serving (or degraded but retrying):
            // don't engage global backoff while a failover exists.
            this.lastPollOk = rescued;
            this.lastPollError = rescued ? null : String(primaryError);
            this.consecutiveErrors = rescued ? 0 : this.consecutiveErrors;
          } else {
            throw primaryError;
          }
        } else {
          this.lastPollOk = true;
          this.lastPollError = null;
          this.consecutiveErrors = 0;
          this.logPoll(primary.name, true, 200, null, primaryStates.positions.length, Date.now() - started);
          this.deadmanPing();
        }
        if (rescued) this.deadmanPing();
      } else {
        this.detector.tick(Date.now());
        this.lastPollOk = true;
        this.lastPollError = null;
      }
    } catch (err) {
      this.consecutiveErrors++;
      this.lastPollOk = false;
      this.lastPollError = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status ?? null;
      this.logPoll(this.providers[0]?.name ?? 'unknown', false, status, this.lastPollError, 0, Date.now() - started);
    }
    this.lastPollAt = Date.now();

    // The live fan-out tail must never stop the loop: a throw here (e.g. a
    // write on a half-closed socket) is caught, logged, and the next cycle is
    // still scheduled in the finally.
    try {
      for (const [clubId, notes] of activeNotesByClub(this.db)) {
        this.live.setNotes(clubId, notes);
      }
      this.live.refreshStatuses();
      this.live.flush();
      // Ambient other-traffic runs AFTER the fleet deltas are on the wire, so
      // a slow area query (up to its fetch timeout) can never delay a fleet
      // update reaching the boards. It catches internally (and again here) so
      // the fleet-health flags stay honest; the second flush ships only the
      // traffic event and is a no-op when nothing changed. Kept inside this
      // try/finally so the reschedule below always runs and cycles never
      // overlap a still-running pass.
      await this.otherTrafficPass().catch(() => {});
      this.live.flush();
    } catch (tailErr) {
      this.lastPollError = tailErr instanceof Error ? tailErr.message : String(tailErr);
    } finally {
      // Only the started loop schedules follow-ups (tests drive runCycle directly).
      if (this.running) {
        const fast = this.settings.getNum('poll_fast_ms', 5000);
        const slow = this.settings.getNum('poll_slow_ms', 30000);
        let delay = anyActive ? fast : slow;
        if (this.consecutiveErrors > 0) {
          delay = Math.min(slow * 2 ** Math.min(this.consecutiveErrors, 5), MAX_BACKOFF_MS);
        }
        // Jitter ±10% keeps us from syncing up with other pollers on the API.
        delay = Math.round(delay * (0.9 + Math.random() * 0.2));
        this.timer = setTimeout(() => void this.loop(), delay);
      }
    }
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    await this.runCycle();
  }
}
