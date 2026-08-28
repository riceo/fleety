import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { config } from './config.js';
import { dbFileSizeBytes } from './db/index.js';
import type { LiveBus } from './live/liveBus.js';

// Threshold override from env, falling back to the sensible default.
const numEnv = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// Single-box + SQLite means the whole app rides one Node event loop and one
// disk. These are the signals that actually precede "we need to scale": the
// event loop lagging (the CPU/sync-DB canary), the disk filling (positions are
// never pruned), the DB growing past comfortable SQLite territory, the poll
// cycle no longer keeping up, and memory/connection pressure.

export type Health = 'ok' | 'watch' | 'alert';

export interface Metric {
  key: string;
  label: string;
  value: number | null; // raw number in the unit below
  unit: string;
  display: string; // human string for the UI
  health: Health;
  note: string; // what it means / when to act
}

const startedAt = Date.now();
let loopHist: IntervalHistogram | null = null;

// Cheap, always-on event-loop delay histogram (native, negligible overhead).
export function startEventLoopMonitor(): void {
  if (loopHist) return;
  loopHist = monitorEventLoopDelay({ resolution: 20 });
  loopHist.enable();
}

// Reset the rolling window (called by the periodic evaluator) so the numbers
// reflect roughly the last interval rather than all of uptime.
export function resetLoopWindow(): void {
  loopHist?.reset();
}

const MB = 1024 * 1024;

// The all-flights position sum scans an ever-growing table; cache it (the
// bytes-per-row ratio it feeds is effectively constant between polls).
let totalRowsCache = { at: 0, rows: 1 };
function cachedTotalRows(db: Database): number {
  const now = Date.now();
  if (now - totalRowsCache.at > 10 * 60_000) {
    const rows = (db.prepare('SELECT COALESCE(SUM(position_count),0) c FROM flights').get() as { c: number }).c || 1;
    totalRowsCache = { at: now, rows };
  }
  return totalRowsCache.rows;
}

const T = {
  loopP99Ms: { watch: numEnv('ALERT_LOOP_P99_WATCH_MS', 50), alert: numEnv('ALERT_LOOP_P99_MS', 150) },
  rssMb: { watch: numEnv('ALERT_RSS_WATCH_MB', 500), alert: numEnv('ALERT_RSS_MB', 800) },
  diskFreePct: { watch: numEnv('ALERT_DISK_WATCH_PCT', 20), alert: numEnv('ALERT_DISK_PCT', 10) },
  dbSizeMb: { watch: numEnv('ALERT_DB_WATCH_MB', 2000), alert: numEnv('ALERT_DB_MB', 5000) },
  pollMs: { watch: numEnv('ALERT_POLL_WATCH_MS', 4000), alert: numEnv('ALERT_POLL_MS', 8000) },
  sseClients: { watch: numEnv('ALERT_SSE_WATCH', 300), alert: numEnv('ALERT_SSE', 800) },
};

const hi = (v: number, t: { watch: number; alert: number }): Health =>
  v >= t.alert ? 'alert' : v >= t.watch ? 'watch' : 'ok';
const lo = (v: number, t: { watch: number; alert: number }): Health =>
  v <= t.alert ? 'alert' : v <= t.watch ? 'watch' : 'ok';

function diskFree(): { freeBytes: number; totalBytes: number } | null {
  try {
    const s = fs.statfsSync(config.dataDir);
    return { freeBytes: s.bfree * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

export interface MetricsReport {
  uptimeSec: number;
  metrics: Metric[];
  worst: Health;
  projectionNote: string;
}

export function collectMetrics(db: Database, live: LiveBus): MetricsReport {
  const now = Date.now();
  const metrics: Metric[] = [];

  // --- event loop delay ---
  const loopMeanMs = loopHist ? loopHist.mean / 1e6 : 0;
  const loopP99Ms = loopHist ? loopHist.percentile(99) / 1e6 : 0;
  metrics.push({
    key: 'loop',
    label: 'Event-loop delay',
    value: loopP99Ms,
    unit: 'ms',
    display: `${loopMeanMs.toFixed(1)} ms mean · ${loopP99Ms.toFixed(0)} ms p99`,
    health: hi(loopP99Ms, T.loopP99Ms),
    note: 'The single-process canary. Sustained high p99 means SQLite queries or SSE fan-out are saturating the one CPU — the first sign to scale.',
  });

  // --- memory ---
  const rssMb = process.memoryUsage().rss / MB;
  metrics.push({
    key: 'rss',
    label: 'Memory (RSS)',
    value: rssMb,
    unit: 'MB',
    display: `${rssMb.toFixed(0)} MB`,
    health: hi(rssMb, T.rssMb),
    note: 'Set the alert threshold below your container memory limit. Steady growth with flat traffic suggests a leak.',
  });

  // --- disk ---
  const disk = diskFree();
  const freePct = disk && disk.totalBytes > 0 ? (disk.freeBytes / disk.totalBytes) * 100 : null;
  metrics.push({
    key: 'disk',
    label: 'Disk free',
    value: freePct,
    unit: '%',
    display: freePct !== null && disk ? `${freePct.toFixed(0)}% free · ${(disk.freeBytes / 1024 / MB).toFixed(1)} GB` : 'unknown',
    health: freePct === null ? 'watch' : lo(freePct, T.diskFreePct),
    note: 'Position history grows forever by design. When this trends down, thin old rows or move to a bigger volume.',
  });

  // --- DB size ---
  const dbMb = dbFileSizeBytes() / MB;
  metrics.push({
    key: 'db',
    label: 'Database size',
    value: dbMb,
    unit: 'MB',
    display: dbMb >= 1024 ? `${(dbMb / 1024).toFixed(2)} GB` : `${dbMb.toFixed(0)} MB`,
    health: hi(dbMb, T.dbSizeMb),
    note: 'SQLite is happy into the low GBs. Past the alert size, the nightly VACUUM backup gets slow — plan a move to Postgres or a receiver.',
  });

  // --- poll cycle duration (recent) ---
  const poll = db
    .prepare('SELECT AVG(duration_ms) a, MAX(duration_ms) m FROM (SELECT duration_ms FROM poll_log ORDER BY id DESC LIMIT 20)')
    .get() as { a: number | null; m: number | null };
  const pollMax = poll.m ?? 0;
  metrics.push({
    key: 'poll',
    label: 'Poll cycle',
    value: pollMax,
    unit: 'ms',
    display: `${Math.round(poll.a ?? 0)} ms avg · ${Math.round(pollMax)} ms max (last 20)`,
    health: hi(pollMax, T.pollMs),
    note: 'If a cycle regularly exceeds the 5 s active interval, the poller can no longer keep up with the fleet — DB writes are the usual cause.',
  });

  // --- SSE clients ---
  const sse = live.clientCount();
  metrics.push({
    key: 'sse',
    label: 'Live viewers (SSE)',
    value: sse,
    unit: 'clients',
    display: `${sse}`,
    health: hi(sse, T.sseClients),
    note: 'Each connection is written to on every flush. Many hundreds concurrently is when fan-out cost starts to matter on one process.',
  });

  // --- growth projection (cheap: sum indexed per-flight counters over 24h) ---
  const dayRows =
    (db.prepare("SELECT COALESCE(SUM(position_count),0) c FROM flights WHERE started_at > ?").get(now - 86_400_000) as { c: number }).c;
  let projectionNote = '';
  if (disk && dayRows > 0 && dbMb > 0) {
    // Rough bytes/row from the live DB. The all-flights sum scans the whole
    // (ever-growing) table, so cache it for 10 min — it barely moves between
    // polls, and this path runs every 10 s while a health tab is open.
    const bytesPerRow = (dbMb * MB) / cachedTotalRows(db);
    const daysLeft = disk.freeBytes / Math.max(dayRows * bytesPerRow, 1);
    projectionNote =
      daysLeft < 3650
        ? `At ~${dayRows.toLocaleString()} positions/day, current free disk lasts roughly ${Math.round(daysLeft).toLocaleString()} days.`
        : `At ~${dayRows.toLocaleString()} positions/day, disk is not a near-term concern.`;
  }

  const order: Record<Health, number> = { ok: 0, watch: 1, alert: 2 };
  const worst = metrics.reduce<Health>((w, m) => (order[m.health] > order[w] ? m.health : w), 'ok');

  return { uptimeSec: Math.round((now - startedAt) / 1000), metrics, worst, projectionNote };
}

// Alert state (last time we alerted per metric) is persisted so a restart
// doesn't re-spam, and we re-alert at most hourly while a metric stays red.
const ALERT_KEY = 'alert_state';
const REALERT_MS = 60 * 60_000;

export interface AlertSink {
  get(key: string, fallback?: string): string;
  set(key: string, value: string): void;
  send(subject: string, lines: string[]): Promise<void>;
}

export async function evaluateAndAlert(db: Database, live: LiveBus, sink: AlertSink): Promise<void> {
  const report = collectMetrics(db, live);
  let state: Record<string, number> = {};
  try {
    state = JSON.parse(sink.get(ALERT_KEY, '{}'));
  } catch {
    /* reset */
  }
  const now = Date.now();
  const firing: Metric[] = [];
  for (const m of report.metrics) {
    if (m.health !== 'alert') continue;
    // Re-alert at most hourly per metric. We do NOT clear the timestamp the
    // moment it dips to ok/watch — otherwise a metric flapping around its
    // threshold would re-alert on every re-entry. The hourly window is the
    // only gate, and old entries are pruned below.
    if (!state[m.key] || now - state[m.key] > REALERT_MS) {
      firing.push(m);
      state[m.key] = now;
    }
  }
  // Forget entries older than 2× the window so state can't grow without bound
  // and a long-recovered metric re-alerts promptly on a genuinely new breach.
  for (const k of Object.keys(state)) if (now - state[k] > 2 * REALERT_MS) delete state[k];
  sink.set(ALERT_KEY, JSON.stringify(state));

  if (firing.length > 0) {
    await sink.send(
      `Fleety: ${firing.length} metric${firing.length > 1 ? 's' : ''} need attention`,
      firing.map((m) => `${m.label}: ${m.display} — ${m.note}`)
    );
  }
}
