# Fleety

**Live ops boards for flying clubs** — [fleety.live](https://fleety.live)

Each club gets its own board at `<club>.fleety.live`: live ADS-B tracking of their fleet on a dark
radar-style map, flight history with replay, a departures ticker, per-flight passenger messages, and a
kiosk mode built for the clubhouse TV. Born as Invicta Aero Club's private tracker after their aircraft
were removed from FlightRadar24; productised so any club can have one.

## How it works

- **Multi-tenant** — clubs own their fleet, airfields, branding (name, subheading, logo, accent colour,
  one of four curated theme presets), callsign rules ("INV" → "INVICTA"), kiosk token and public/private
  toggle. Users are global (email sign-in) with per-club memberships; platform admins manage clubs and
  the global user list from `/platform`.
- **One shared poller** batches every tracked hex across every club into chunked calls to the free,
  unfiltered [adsb.lol](https://adsb.lol) API (ODbL) — upstream load stays near-constant as clubs join.
  The provider layer is pluggable (ADSBexchange / airplanes.live / local `tar1090` receiver).
- **Flight detection** is a per-aircraft state machine tolerant of the low-altitude coverage gaps GA
  aircraft suffer, with departure/arrival airfield attribution, provisional endings, and an admin
  merge/split escape hatch. Take-offs and landings feed each club's ticker and push live over SSE
  (the kiosk board snaps focus to the aircraft; optional ping sound).
- **History is recorded, not bought** — positions (with full raw ADS-B JSON for a retention window) are
  stored from the moment the poller starts; no free source sells the past.
- **Email** via [Resend](https://resend.com) for invites and password resets; without an API key,
  admins get shareable links instead.
- **Social share cards** — deep links (`/ac/<reg>`) render a branded Open Graph JPEG for WhatsApp/
  LinkedIn: an evergreen card for the plain URL, a live-snapshot card for the Share button.
- **Health monitoring** — Platform → Health shows single-box vitals (event-loop delay, disk, DB size,
  poll cycle…) with email/webhook alerts when one crosses a threshold. Liveness still belongs on an
  external pinger.
- Stack: Fastify + TypeScript + better-sqlite3 (`server/`), React + Vite + MapLibre GL (`web/`),
  single container. Tests: `cd server && npm test` (flight detection, annotations, sessions, metrics,
  security, and cross-tenant isolation via injected requests). Architecture + invariants for
  contributors/agents live in [CLAUDE.md](CLAUDE.md).

## Local development

Node 22 (`nvm use 22` — better-sqlite3 is a native module compiled against it).

```bash
cd server && npm install
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me npm run dev   # API on :8080

cd web && npm install && npm run dev                               # Vite on :5173, proxies /api
```

On localhost, requests fall back to the `DEFAULT_CLUB` (invicta). First run seeds the founding club,
its 11-aircraft INVICTA fleet, Kent airfields, and the platform-admin account (forced password change).

## Deploying on Coolify

The image is a single Dockerfile; Coolify's proxy (Traefik) terminates TLS — the bundled
`docker-compose.yml`/`Caddyfile` are only for non-Coolify hosts.

1. **New resource** → your GitHub repo (`riceo/fleety`), branch `main`, **Build pack: Dockerfile**.
2. **Port:** `8080`.
3. **Domains:** start explicit — `https://fleety.live,https://invicta.fleety.live` — each gets a
   Let's Encrypt cert via HTTP-01 automatically. Add each new club's subdomain here as you create it
   (or upgrade to a `*.fleety.live` wildcard later via Traefik's Cloudflare DNS-01 challenge).
4. **Persistent storage:** add a **volume mount** to `/data` (a named volume, not a host-directory
   bind — the container runs as a non-root user; a fresh host bind would be root-owned). Everything
   stateful lives there: SQLite db, uploads, nightly `VACUUM INTO` backups (14 kept).
5. **Environment variables:**
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — first-run platform admin (forced change on first sign-in)
   - `BASE_DOMAIN=fleety.live`
   - **`TRUST_PROXY=2`** — Cloudflare→Coolify is two proxy hops; without this, `req.ip` (and every
     rate limit) keys on a shared proxy address instead of the real client. For the rate limits to be
     truly unspoofable, also restrict the origin firewall to Cloudflare's IP ranges.
   - `RESEND_API_KEY`, `EMAIL_FROM="Fleety <ops@fleety.live>"` — optional (verify the domain in
     Resend and add its DKIM/SPF records first)
   - optional: `ADSBX_API_KEY` (paid rescue tier), `ALERT_EMAIL`/`ALERT_WEBHOOK` (health alerts),
     `DEFAULT_CLUB=invicta`, `TZ=UTC`. See [`.env.example`](.env.example) for the full list.
6. **Health check:** the image ships a `HEALTHCHECK` on `/healthz`; point Coolify's health check at
   `/healthz` port `8080` too if you enable it.
7. **DNS (Cloudflare):** `A fleety.live → <node IP>` and `A invicta.fleety.live → <node IP>`
   (DNS-only / grey cloud, at least until certs are issued). Add an `A *.fleety.live` record when you
   move to the wildcard cert.
8. Deploy, then open `https://invicta.fleety.live`, sign in with `ADMIN_EMAIL`, set your real password,
   and check Admin → Settings (kiosk link, branding) and `/platform`.

SSE needs no special proxy config on Traefik. The apex (`fleety.live`) serves the Fleety landing page.

### Kiosk TV

Admin → Settings → copy the kiosk link. Drive the TV with a Pi 5 / mini-PC running
`chromium --kiosk --autoplay-policy=no-user-gesture-required 'https://<club>.fleety.live/kiosk?token=…'`
— smart-TV browsers have broken WebGL. The page self-reloads nightly and whenever the feed stalls, and
falls back to a map-less departure board without WebGL. Members can also flip any screen into kiosk
mode with the ▣ Kiosk button (click the club logo to exit).

## Notes

- **Attribution:** map tiles by [OpenFreeMap](https://openfreemap.org) (© OpenMapTiles, data © OSM
  contributors); live data via adsb.lol; airfield database from [OurAirports](https://ourairports.com)
  (public domain). Keep the attribution visible.
- **Coverage upgrade:** a Raspberry Pi + RTL-SDR receiver at a club's home field feeding the
  aggregators fixes the low-altitude blind spot where club aircraft actually fly.
- **Privacy:** clubs decide their own public/private mode; anything naming people belongs in
  members-only visibility. Timestamps are stored UTC; the UI renders in each club's configured
  timezone (Admin → Settings, default Europe/London).
