# Invicta FleetView

A private, branded live flight tracker for [Invicta Aero Club](https://www.invictaaero.club/). Tracks the club fleet
(and temporary guest aircraft) via ADS-B, records full position history with flight replay, and drives a
plane-spotting kiosk screen for the clubhouse coffee shop.

## Features

- **Live map** — the whole fleet on a MapLibre map of Kent (and wherever they roam), with custom per-aircraft
  icons, live trails, callsigns (INVxx), and a mobile-friendly layout.
- **Private or public** — runtime toggle in the admin panel. Private mode requires member sign-in; flipping to
  private also severs any anonymous live streams. Per-aircraft visibility can hide guests from public view.
- **History & replay** — every flight is recorded and replayable with a time slider. Flight detection is a
  state machine tolerant of the low-altitude coverage gaps GA aircraft suffer, with an admin merge/split tool
  for the rare misfire.
- **Admin panel** — add aircraft by registration (hex/type auto-lookup), upload icons and photos, manage
  members, airfields, kiosk messages, settings, and watch poller health.
- **Kiosk mode** (`/kiosk?token=…`) — dark 10-foot UI for a TV: auto-cycling camera, aircraft photo cards,
  a scrolling ticker ("INV08 HAS TAKEN OFF FROM ROCHESTER — PAX: BOB AND JESS EXPERIENCE"), nightly
  self-reload and a stale-feed watchdog. Messages can run until a set time or "for the next flight"
  (armed at take-off, cleared at landing).
- **Airfields on the map** — ~7,400 European airfields (OurAirports data) fade in with zoom; club bases
  Rochester (EGTO) and Lydd (EGMD) get prominent red markers.

## Data source

Live positions come from the free, unfiltered **[adsb.lol](https://adsb.lol)** API (ODbL) — one batched
request per poll cycle for the whole fleet, adaptive 5s/30s cadence with backoff. The provider layer is
pluggable (ADSBexchange / airplanes.live / a local receiver's `tar1090` JSON can be swapped in).

History starts when the poller starts — no external source provides free historical GA data, which is why
FleetView records everything itself (full raw JSON kept for a configurable window, parsed fields forever).

**Best £80 upgrade**: a Raspberry Pi + RTL-SDR + antenna at Rochester feeding adsb.lol/ADSBexchange gives
rock-solid low-altitude coverage right where the fleet flies (aggregators are weakest below ~1,500 ft),
plus feeder API perks — and FleetView can then consume the receiver's JSON directly.

## Running it

### Local development

```bash
# server (Fastify + SQLite; Node 22)
cd server && npm install
ADMIN_USER=admin ADMIN_PASSWORD=change-me npm run dev

# frontend (Vite dev server proxies /api to :8080)
cd web && npm install && npm run dev
```

Tests: `cd server && npm test` (flight detector, annotations lifecycle, sessions).

### VPS deployment (Docker Compose + Caddy)

```bash
cp .env.example .env       # set ADMIN_PASSWORD and SITE_DOMAIN
docker compose up -d --build
```

- Caddy terminates HTTPS for `SITE_DOMAIN` automatically (ports 80/443 must reach the box).
- Everything stateful lives in `./data` (SQLite db, uploads, nightly `VACUUM INTO` backups, 14 kept).
  Back that directory up off-box — the nightly backup file is safe to copy while running; the live db is not.
  [Litestream](https://litestream.io) as a sidecar is the zero-effort offsite upgrade.
- First run seeds the 11-aircraft fleet, club airfields, and the admin account from `.env`
  (forced password change on first sign-in).
- Optional: set a healthchecks.io URL in Admin → Settings so a silently-dead poller alerts someone.

### Kiosk (coffee-shop TV)

1. Admin → Settings → copy the kiosk link (`/kiosk?token=…`); Rotate invalidates old screens.
2. Drive the TV with a **Raspberry Pi 5 / mini-PC running Chromium in kiosk mode** — smart-TV browsers
   have broken WebGL and aggressive tab-killing. `chromium --kiosk 'https://your-domain/kiosk?token=…'`
3. The page reloads itself nightly at 03:00 and whenever the live feed stalls; if WebGL is unavailable it
   falls back to a map-less departure board.

## Notes

- **Attribution**: map tiles by [OpenFreeMap](https://openfreemap.org) (© OpenMapTiles, data © OpenStreetMap
  contributors); live ADS-B data via adsb.lol; airfield database from [OurAirports](https://ourairports.com)
  (public domain). Keep the attribution visible.
- **Privacy**: before enabling public mode, get club sign-off — and keep anything pilot-identifying
  (kiosk messages included) behind login/members-only visibility if it names people.
- Timestamps are stored in UTC; the UI renders Europe/London.
