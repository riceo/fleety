import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestDb } from './db/index.js';
import { buildServer } from './server.js';
import { Settings } from './settings.js';
import { LiveBus } from './live/liveBus.js';
import { FlightDetector } from './tracking/flightDetector.js';
import { Poller } from './tracking/poller.js';
import { Clubs } from './clubs.js';

const APEX = { host: 'fleety.live', 'x-fleetview': '1', 'content-type': 'application/json' };

async function build(): Promise<{ db: Database; app: FastifyInstance }> {
  const db = openTestDb();
  const settings = new Settings(db);
  const live = new LiveBus();
  const clubs = new Clubs(db);
  const detector = new FlightDetector(db);
  const poller = new Poller(
    db,
    [{ name: 'test', fetchStates: async () => ({ positions: [], presences: [] }) }],
    settings,
    detector,
    live
  );
  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'fleety-test-'));
  fs.writeFileSync(
    path.join(webDist, 'index.html'),
    '<html><head><title>Fleety</title>\n<!--fleety:meta--><!--/fleety:meta-->\n</head><body></body></html>'
  );
  const app = await buildServer({ db, settings, live, poller, detector, clubs, webDist });
  return { db, app };
}

describe('waitlist', () => {
  let w: { db: Database; app: FastifyInstance };
  beforeEach(async () => {
    w = await build();
  });
  afterEach(async () => {
    await w.app.close();
  });

  it('stores a signup with its marketing consent', async () => {
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/waitlist',
      headers: APEX,
      payload: { email: ' Chair@SomeClub.co.uk ', marketing: true },
    });
    expect(res.statusCode).toBe(200);
    const row = w.db.prepare('SELECT * FROM waitlist').get() as {
      email: string;
      marketing_opt_in: number;
      source: string;
    };
    expect(row.email).toBe('chair@someclub.co.uk'); // trimmed + lowercased
    expect(row.marketing_opt_in).toBe(1);
    expect(row.source).toBe('fleety.live');
  });

  it('is idempotent and only ever upgrades marketing consent', async () => {
    const signup = (marketing: boolean) =>
      w.app.inject({
        method: 'POST',
        url: '/api/waitlist',
        headers: APEX,
        payload: { email: 'chair@someclub.co.uk', marketing },
      });
    await signup(false);
    await signup(true); // ticking the box later upgrades…
    await signup(false); // …and an unticked re-signup never downgrades
    const rows = w.db.prepare('SELECT marketing_opt_in FROM waitlist').all() as { marketing_opt_in: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].marketing_opt_in).toBe(1);
  });

  it('rejects junk emails', async () => {
    for (const email of ['', 'not-an-email', 'a@b', 'has spaces@x.com']) {
      const res = await w.app.inject({ method: 'POST', url: '/api/waitlist', headers: APEX, payload: { email } });
      expect(res.statusCode).toBe(400);
    }
    expect(w.db.prepare('SELECT COUNT(*) c FROM waitlist').get()).toEqual({ c: 0 });
  });

  it('the signup list is platform-admin only', async () => {
    const res = await w.app.inject({ method: 'GET', url: '/api/platform/waitlist', headers: APEX });
    expect(res.statusCode).toBe(403);
  });
});
