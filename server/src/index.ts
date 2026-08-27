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
import { AdsbFiProvider } from './providers/adsbFi.js';
import { lookupRouteForFlight } from './enrichment/lookup.js';
import { onLanding, onTakeoff, type TickerEmit } from './annotations.js';
import { Clubs } from './clubs.js';
import { buildServer } from './server.js';
import { scheduleNightly } from './retention.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = getDb();
  await seed(db);
  const settings = new Settings(db);
  const clubs = new Clubs(db);
  const live = new LiveBus();

  const emitTicker: TickerEmit = (ev) => live.broadcastTicker(ev.clubId, ev);
  const detector = new FlightDetector(db, {}, {
    onFlightStarted: (flightId, aircraft, callsign) => {
      onTakeoff(db, flightId, aircraft.id, emitTicker);
      void lookupRouteForFlight(db, flightId, callsign);
    },
    onFlightEnded: (flightId, aircraft) => {
      onLanding(db, flightId, aircraft.id, emitTicker);
      live.flightEnded(aircraft.club_id, aircraft.id, flightId);
    },
  });

  const poller = new Poller(db, [new AdsbLolProvider(), new AdsbFiProvider()], settings, detector, live);

  // Rehydrate live trails for flights that were open when we last stopped.
  const openFlights = db
    .prepare(
      'SELECT f.id, f.aircraft_id, a.club_id FROM flights f JOIN aircraft a ON a.id = f.aircraft_id WHERE f.ended_at IS NULL'
    )
    .all() as { id: number; aircraft_id: number; club_id: number }[];
  for (const f of openFlights) {
    const pts = db
      .prepare('SELECT lon, lat FROM positions WHERE flight_id = ? ORDER BY ts DESC LIMIT 1500')
      .all(f.id) as { lon: number; lat: number }[];
    live.seedTrail(f.club_id, f.aircraft_id, f.id, pts.reverse().map((p) => [p.lon, p.lat]));
  }

  const webDistCandidates = [
    process.env.WEB_DIST,
    path.resolve(here, '../../web/dist'),
    path.resolve(here, '../web/dist'),
  ].filter((p): p is string => !!p);
  const webDist = webDistCandidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? webDistCandidates[1];

  // Founding-club nicety: Invicta's logo ships with the app — install it into
  // the club record on first boot if no logo has been uploaded yet.
  const invicta = clubs.slug('invicta');
  if (invicta && !invicta.logo_path) {
    const bundled = path.join(webDist, 'invicta-logo.png');
    if (fs.existsSync(bundled)) {
      const uploads = path.join(config.dataDir, 'uploads');
      fs.mkdirSync(uploads, { recursive: true });
      const name = `club-${invicta.id}-logo-bundled.png`;
      fs.copyFileSync(bundled, path.join(uploads, name));
      db.prepare('UPDATE clubs SET logo_path = ? WHERE id = ?').run(name, invicta.id);
      clubs.reload();
    }
  }

  const app = await buildServer({ db, settings, live, poller, detector, clubs, webDist });

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
  app.log.info(`Fleety listening on :${config.port}, serving web from ${webDist}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
