import type { Database } from 'better-sqlite3';

// Small write-through cache over the settings table; the poller and auth hooks
// read settings on hot paths.
export class Settings {
  private cache = new Map<string, string>();

  constructor(private db: Database) {
    for (const row of db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[]) {
      this.cache.set(row.key, row.value);
    }
  }

  get(key: string, fallback = ''): string {
    return this.cache.get(key) ?? fallback;
  }

  getNum(key: string, fallback: number): number {
    const n = Number(this.cache.get(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  getBool(key: string): boolean {
    return this.cache.get(key) === '1';
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
    this.cache.set(key, value);
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.cache);
  }
}
