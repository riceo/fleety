import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config, dbPath } from '../config.js';
import { migrate } from './migrations.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const file = dbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

// For tests: an isolated in-memory database with the full schema.
export function openTestDb(): Database.Database {
  const mem = new Database(':memory:');
  mem.pragma('foreign_keys = ON');
  migrate(mem);
  return mem;
}

export function closeDb(): void {
  if (db) {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
  }
}

export function dbFileSizeBytes(): number {
  try {
    return fs.statSync(dbPath()).size;
  } catch {
    return 0;
  }
}

export { config };
