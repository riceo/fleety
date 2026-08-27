import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { config } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { seed } from './db/seed.js';
import { Settings } from './settings.js';
import { LiveBus } from './live/liveBus.js';
import { FlightDetector } from './tracking/flightDetector.js';
import { Poller } from './tracking/poller.js';
import { AdsbLolProvider } from './providers/adsbLol.js';
import { lookupRouteForFlight } from './enrichment/lookup.js';
import { onLanding, onTakeoff } from './annotations.js';
import { buildServer } from './server.js';
import { scheduleNightly } from './retention.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = getDb();
  await seed(db);
  const settings = new Settings(db);
  const live = new LiveBus();

  const emitTicker = (ev: Parameters<typeof live.broadcastTicker>[0]) => live.broadcastTicker(ev);
  const detector = new FlightDetector(db, {}, {
    onFlightStarted: (flightId, aircraftId, callsign) => {
      onTakeoff(db, flightId, aircraftId, emitTicker);
      void lookupRouteForFlight(db, flightId, callsign);
    },
    onFlightEnded: (flightId, aircraftId) => {
      onLanding(db, flightId, aircraftId, emitTicker);
    },
  });

  const poller = new Poller(db, new AdsbLolProvider(), settings, detector, live);

  // Rehydrate live trails for flights that were open when we last stopped.
  const openFlights = db
    .prepare('SELECT id, aircraft_id FROM flights WHERE ended_at IS NULL')
    .all() as { id: number; aircraft_id: number }[];
  for (const f of openFlights) {
    const pts = db
      .prepare('SELECT lon, lat FROM positions WHERE flight_id = ? ORDER BY ts DESC LIMIT 1500')
      .all(f.id) as { lon: number; lat: number }[];
    live.seedTrail(f.aircraft_id, f.id, pts.reverse().map((p) => [p.lon, p.lat]));
  }

  const webDistCandidates = [
    process.env.WEB_DIST,
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../web/dist'),
  ].filter((p): p is string => !!p);
  const webDist = webDistCandidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? webDistCandidates[1];

  const app = await buildServer({ db, settings, live, poller, detector, webDist });

  poller.start();
  const heartbeat = setInterval(() => live.heartbeat(), 25_000);
  const nightly = scheduleNightly(db, settings, (msg) => app.log.info(msg));

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    clearInterval(heartbeat);
    clearInterval(nightly);
    poller.stop();
    await app.close().catch(() => {});
    closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`FleetView listening on :${config.port}, serving web from ${webDist}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
