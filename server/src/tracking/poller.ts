import type { Database } from 'better-sqlite3';
import type { AdsbProvider } from '../providers/index.js';
import type { Settings } from '../settings.js';
import type { LiveBus } from '../live/liveBus.js';
import type { AircraftRow, NormPosition } from '../types.js';
import { FlightDetector } from './flightDetector.js';
import { activeNotes } from '../annotations.js';

const MAX_BACKOFF_MS = 5 * 60_000;

export class Poller {
  private lastTsByAircraft = new Map<number, number>();
  private consecutiveErrors = 0;
  private lastOkLogAt = 0;
  private lastDeadmanAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  lastPollAt = 0;
  lastPollOk = false;
  lastPollError: string | null = null;

  constructor(
    private db: Database,
    private provider: AdsbProvider,
    private settings: Settings,
    private detector: FlightDetector,
    private live: LiveBus
  ) {
    // Prime dedupe watermarks so a restart doesn't re-store stale fixes.
    const rows = this.db
      .prepare('SELECT aircraft_id, MAX(ts) ts FROM positions GROUP BY aircraft_id')
      .all() as { aircraft_id: number; ts: number }[];
    for (const r of rows) this.lastTsByAircraft.set(r.aircraft_id, r.ts);
  }

  start(): void {
    this.stopped = false;
    void this.cycle();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private trackedAircraft(): AircraftRow[] {
    // Guests past their track-until date drop out automatically (but keep
    // their history; admins can re-enable).
    this.db
      .prepare(
        "UPDATE aircraft SET enabled = 0, updated_at = ? WHERE track_until IS NOT NULL AND track_until < date('now') AND enabled = 1"
      )
      .run(Date.now());
    return this.db
      .prepare('SELECT * FROM aircraft WHERE deleted_at IS NULL ORDER BY sort_order, id')
      .all() as AircraftRow[];
  }

  private logPoll(ok: boolean, status: number | null, error: string | null, count: number, durationMs: number): void {
    const now = Date.now();
    // Errors always logged; healthy polls at most once a minute to keep the
    // table small while still proving the poller was alive.
    if (ok && now - this.lastOkLogAt < 60_000) return;
    if (ok) this.lastOkLogAt = now;
    this.db
      .prepare(
        'INSERT INTO poll_log (ts, provider, ok, status, error, aircraft_returned, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(now, this.provider.name, ok ? 1 : 0, status, error, count, durationMs);
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

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    const started = Date.now();
    let anyActive = false;
    try {
      const aircraft = this.trackedAircraft();
      this.live.syncAircraftList(aircraft);
      const enabled = aircraft.filter((a) => a.enabled === 1);
      const byHex = new Map(enabled.map((a) => [a.hex.toLowerCase(), a]));

      if (enabled.length > 0) {
        const positions = await this.provider.fetchPositions([...byHex.keys()]);
        const apply = this.db.transaction(() => {
          for (const p of positions) {
            const ac = byHex.get(p.hex);
            if (!ac) continue;
            const lastTs = this.lastTsByAircraft.get(ac.id) ?? 0;
            if (p.ts <= lastTs) continue; // stale fix repeated by the aggregator
            const flightId = this.detector.onPosition(ac.id, p);
            this.insertPosition(ac.id, p, flightId);
            this.lastTsByAircraft.set(ac.id, p.ts);
            this.live.update(ac.id, p, flightId);
            if (flightId !== null && p.ts > Date.now() - 120_000) anyActive = true;
          }
          this.detector.tick(Date.now());
        });
        apply();
        this.lastPollOk = true;
        this.lastPollError = null;
        this.consecutiveErrors = 0;
        this.logPoll(true, 200, null, positions.length, Date.now() - started);
        this.deadmanPing();
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
      this.logPoll(false, status, this.lastPollError, 0, Date.now() - started);
    }
    this.lastPollAt = Date.now();

    this.live.setNotes(activeNotes(this.db));
    this.live.refreshStatuses();
    this.live.flush();

    const fast = this.settings.getNum('poll_fast_ms', 5000);
    const slow = this.settings.getNum('poll_slow_ms', 30000);
    let delay = anyActive ? fast : slow;
    if (this.consecutiveErrors > 0) {
      delay = Math.min(slow * 2 ** Math.min(this.consecutiveErrors, 5), MAX_BACKOFF_MS);
    }
    // Jitter ±10% keeps us from syncing up with other pollers on the API.
    delay = Math.round(delay * (0.9 + Math.random() * 0.2));
    this.timer = setTimeout(() => void this.cycle(), delay);
  }
}
