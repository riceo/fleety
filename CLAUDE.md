# CLAUDE.md — working notes for agents

Fleety is a **multi-tenant SaaS** (many flying clubs, one per subdomain) that tracks club aircraft
live from ADS-B, records flight history, and drives a clubhouse-TV kiosk. Fastify + TypeScript +
better-sqlite3 server (`server/`), React + Vite + MapLibre GL web (`web/`), one Docker container,
SQLite on a `/data` volume, deployed on Coolify behind Cloudflare. User-facing/deploy docs are in
[README.md](README.md); this file is the map + the rules that aren't obvious from the code.

## Commands (Node 22)

```bash
# server (cwd: server/)
npm run build      # tsc -> dist/            (run before committing; catches type errors)
npm test           # vitest run             (~61 tests, 9 files; MUST pass before commit)
npm run dev        # tsx watch src/index.ts  -> API on :8080

# web (cwd: web/)
npm run build      # tsc --noEmit + vite build -> web/dist/
npm run dev        # vite on :5173, proxies /api -> :8080
```

Always build **both** packages and run the server tests before committing. On localhost any Host
resolves to `DEFAULT_CLUB` (invicta); first run seeds the invicta club + its 11 INVICTA aircraft +
Kent airfields + the platform-admin from `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

Note: `npm test` can show broad, spurious failures if a preview/dev server is running at the same time
(resource contention between vitest workers). Stop it and re-run — an isolated run is authoritative.

## Where things live

```
server/src/
  server.ts            ALL HTTP routes + guards (large; the authz matrix lives here)
  index.ts             boot/wiring: seed, poller.start, intervals (heartbeat, metrics, nightly), shutdown
  config.ts            env -> config object (single source for env vars)
  clubs.ts             tenant resolution from Host header; callsign-rule parsing; ClubRow
  escape.ts            escapeHtml / escapeXml — the ONLY escapers (don't re-implement)
  live/liveBus.ts      SSE fan-out: per-club channels, snapshot/delta, ring+resume, audience filtering
  tracking/
    poller.ts          the one shared poll loop (all clubs) + the ADSBx rescue tier + other-traffic pass
    flightDetector.ts  per-aircraft GROUND/AIRBORNE/LOST state machine, airfield geofences
    otherTraffic.ts    policy filter for the ambient non-fleet traffic layer (own-hex/ceiling/cap)
    flightStats.ts, geo.ts
  providers/           adsbLol (primary), adsbFi (failover), adsbx (paid rescue), readsb (shared normalise)
  db/                  index.ts (open + WAL + FK), migrations.ts (additive-only), seed.ts
  auth/                sessions.ts (session + login tokens), passwords.ts (argon2id)
  og.ts                sharp-rendered social share card (1200x630 JPEG)
  metrics.ts           single-box health metrics + threshold alerting
  retention.ts         nightly prune + VACUUM backup
  annotations.ts       ticker events / per-flight notes
web/src/
  pages/               LivePage, KioskPage, HistoryPage, ReplayPage, AdminPage, PlatformPage, LoginPage, ...
  components/          MapView, FleetPanel, Ticker, TopBar, ImageCropper, ErrorBoundary
  live.ts              EventSource client (mirror of the SSE protocol)
  api.ts               fetch helpers + the client-side types of every server payload
  auth.tsx             AuthProvider; loads /api/config + /api/me; setCallsignRules/setTimezone
  chartStyle.ts        "Chart" basemap: liberty recoloured in place (green land / blue water) when
                       tile_style_url carries #fleety=chart; old bundles ignore the fragment
```

Request flow: Cloudflare → Coolify (Traefik) → Fastify. `onRequest` resolves `req.club` from the Host
header and `req.auth` from the session cookie, sets security headers (incl. CSP), and enforces the CSRF
header. Then the route runs.

## Load-bearing invariants — DO NOT BREAK THESE

- **Migrations are additive-only and idempotent** (`db/migrations.ts`, numbered `id`s, currently 12).
  During a rolling deploy the old and new containers run against the same DB, so a migration must
  never drop/rename/narrow a column the old code reads. Add columns/tables; backfill in code. Same
  rule for the SSE delta shape and any stored JSON blob.
- **Tenant scoping is by Host header.** Every `/api/admin/*` route must call `requireClubAdmin` AND
  scope its DB access to `req.club.id` (use the `clubAircraft` / `clubFlight` ownership helpers — never
  a bare id). `/api/platform/*` uses `requirePlatform`. The apex/unknown base host = the platform
  landing (`req.club === null`); only non-base hosts fall back to `DEFAULT_CLUB`. The live pentest and
  `isolation.test.ts` verify there is no cross-tenant leak — keep it that way.
- **Positions are never pruned.** The product records full history deliberately; retention only nulls
  the raw-JSON blob after `raw_retention_days`. Do not add row deletion.
- **`poller.applyBatch` advances the in-memory dedupe watermark (`lastTsByAircraft`) and `live.update`
  only AFTER the DB transaction commits.** Moving them back inside the `db.transaction()` re-introduces
  permanent fix-loss on a rollback (disk-full).
- **All user/admin text rendered into HTML/XML goes through `escape.ts`.** The OG meta shell in
  `server.ts` (`renderShell`) uses **function** `String.replace(re, () => …)` — a string replacement is
  unsafe because `$` is not escaped. React escapes text by default; the only raw HTML sink is the
  bundled-icon SVG (constant, colour-substituted — never user input).
- **SSE (`liveBus.ts`):** event ids are `bootId.seq`; a `Last-Event-ID` from a previous process can't
  resume (falls back to a fresh snapshot). Trail appends accumulate per flush window and are cleared on
  a flight change. Every write goes through `safeWrite` — a broken socket must never throw up into the
  poll loop. Members-only aircraft are filtered out of the `restricted` audience (kiosk/public).
- **better-sqlite3 is synchronous** — every query blocks the one event loop. Keep hot-path queries
  cheap and indexed: the poll cycle, `liveBus.flush`, and `/api/*/status` (polled every 10s). Never
  `await` inside a `db.transaction()` closure.
- **The poll loop must always reschedule.** `runCycle` catches poll errors AND the live-fan-out tail,
  and schedules the next tick in a `finally`; `index.ts` also has process-level
  unhandledRejection/uncaughtException handlers. Don't remove these — a single unguarded throw here
  stops polling platform-wide.
- **CSRF:** every non-GET `/api/*` requires the header `x-fleetview: 1` (the client `api.ts` sends it).
- **Timezone is per-club** (`clubs.timezone` → `/api/config` → `format.ts setTimezone`). Storage is
  always UTC. Don't hardcode a zone in shared code (an early bug baked in Europe/London).

## Conventions & gotchas

- **Auth:** argon2id; sessions are random tokens stored SHA-256-hashed; login/invite/reset tokens are
  single-use + 48h. Login spends equal argon2 time for missing/passwordless accounts (no enumeration)
  and has a **per-account lockout** (8 fails/15min, IP-independent). Rate limits key on
  `CF-Connecting-IP` when present. Behind Cloudflare set `TRUST_PROXY=2` (and ideally lock the origin
  to Cloudflare IPs) or IP limits key on a shared proxy address.
- **Other traffic (`clubs.other_traffic` JSON, off by default):** the poller runs a per-club area query
  (`fetchArea`, adsb.lol then adsb.fi) around the club's map centre — throttled to 10s/club, skipped with
  zero SSE clients, capped at 80 nearest, own hexes and above-ceiling traffic filtered
  (`tracking/otherTraffic.ts`). Live-only: fans out as the SSE `traffic` event (whole-list replace, re-sent
  on connect, no ring/resume) and is never stored. The map draws it under the fleet: one shared tinted icon,
  faded + small. A traffic failure must never mark the fleet poll unhealthy or throw into the cycle.
- **Map staleness:** airborne aircraft stay on the map through coverage gaps (24h cap); non-airborne
  drop off 10 min after the transponder goes quiet (`GHOST_MAX_AGE_MS` — board feedback: landed aircraft
  used to sit there all day). The strip bay/kiosk rail still lists them (dimmed hard when offline).
- **Providers:** `providers[0]` = primary (adsb.lol), `providers[1]` = failover (adsb.fi, queried only
  for hexes the primary didn't freshly hear). The **ADSBx rescue tier** is opt-in (`ADSBX_API_KEY`),
  metered (per-UTC-month budget persisted in settings), and fires only for an OPEN flight that vanished
  from both free networks — plus a manual probe on Platform → ADSBx rescue. It is billed per request:
  the poller's budget guard is the only thing between `adsbx.ts` and an invoice.
- **OG share cards (`og.ts` + the `/ac/:reg` and `/ac/:reg/og.jpg` routes):** the bare URL is the
  *evergreen* card (durable text, no volatile numbers, ~10min edge TTL — safe because scrapers cache
  for days). The Share button appends `?s=<minute bucket>` for a *live snapshot* card (~2min TTL),
  bucketed so all shares within a minute share one render and Cloudflare still caches. Only rendered for
  a public club + public-visibility aircraft. sharp runs off the event loop; the Docker image installs
  `fonts-dejavu-core` so the SVG text renders (no font ⇒ blank text).
- **MapLibre:** spreading an explicit `undefined` option overrides the MapLibre default (e.g.
  `fadeDuration: undefined` ⇒ NaN symbol opacity ⇒ every icon/label invisible) — only set kiosk
  overrides when `kiosk`. Dead-reckoning between pings runs a 1s tick that calls
  `syncDataRef.current()`, which MUST be reassigned every render (a missed assignment froze aircraft).
  Re-add sources/layers after a style reload.
- **Kiosk** auto-reloads on a new deploy (compares the hashed entry-script), nightly at ~03:00, and on a
  dead feed; overview mode centres on the cycled aircraft. Members flip any screen to kiosk with the ▣
  button. Long-running TV, so watch for leaks and effects that re-create intervals.
- **Metrics/alerting (`metrics.ts`, Platform → Health):** event-loop delay is the key single-box
  scaling canary. Alerts (email via Resend + optional `ALERT_WEBHOOK`) fire when a vital crosses a
  threshold, debounced hourly per metric. Thresholds are env-tunable (`ALERT_*`). Poll-cycle health is
  judged on the *average*, not a one-off max (a provider timeout is not a scaling signal).

## Deploy

Single Dockerfile (runs as non-root, needs `curl` for healthchecks + `fonts-dejavu-core` for cards).
Coolify: Build pack **Dockerfile**, port **8080**, a **named** `/data` volume, env `ADMIN_EMAIL`
`ADMIN_PASSWORD` `BASE_DOMAIN=fleety.live` `TRUST_PROXY=2` (+ optional `RESEND_API_KEY`/`EMAIL_FROM`,
`ADSBX_API_KEY`, `ALERT_EMAIL`/`ALERT_WEBHOOK`, `DEFAULT_CLUB`, `TZ=UTC`). See `.env.example` for the
full list and README.md for the step-by-step. Additive migrations mean deploys are safe rolling; the
user's workflow is "just yeet to main" then redeploy manually in Coolify (no staging).
