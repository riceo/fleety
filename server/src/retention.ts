import type { Database } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { backupsDir } from './config.js';
import type { Settings } from './settings.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { pruneTicker } from './annotations.js';

// Nightly housekeeping: prune raw JSON past retention, trim poll_log, expire
// sessions, and take a consistent SQLite backup via VACUUM INTO.
export function runNightly(db: Database, settings: Settings, log: (msg: string) => void): void {
  const rawDays = settings.getNum('raw_retention_days', 90);
  const cutoff = Date.now() - rawDays * 24 * 3600 * 1000;
  const pruned = db.prepare('UPDATE positions SET raw = NULL WHERE ts < ? AND raw IS NOT NULL').run(cutoff);
  if (pruned.changes > 0) log(`retention: cleared raw JSON on ${pruned.changes} positions older than ${rawDays}d`);

  const pollDays = settings.getNum('poll_log_retention_days', 365);
  db.prepare('DELETE FROM poll_log WHERE ts < ?').run(Date.now() - pollDays * 24 * 3600 * 1000);

  pruneExpiredSessions(db);
  pruneTicker(db);

  try {
    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const dest = path.join(dir, `fleetview-${stamp}.db`);
    if (!fs.existsSync(dest)) {
      db.prepare('VACUUM INTO ?').run(dest);
      log(`retention: backup written to ${dest}`);
    }
    // Keep the last 14 daily backups.
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('fleetview-') && f.endsWith('.db'))
      .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - 14))) {
      fs.unlinkSync(path.join(dir, old));
    }
  } catch (err) {
    log(`retention: backup failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Self-correcting schedule: aim a setTimeout at the next 02:00 UTC and
// re-arm after each run, so a delayed tick (a blocked loop, GC) can't cause a
// day to be silently skipped the way a fixed hourly interval could. Returns a
// stop function.
export function scheduleNightly(db: Database, settings: Settings, log: (msg: string) => void): () => void {
  let timer: NodeJS.Timeout;
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(2, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    timer = setTimeout(() => {
      try {
        runNightly(db, settings, log);
      } catch (err) {
        log(`retention: nightly job failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      scheduleNext();
    }, next.getTime() - now.getTime());
  };
  scheduleNext();
  return () => clearTimeout(timer);
}
