import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, type LiveAircraft } from '../api';
import { useAuth } from '../auth';
import { useLiveFleet } from '../live';
import { MapView, type MapViewHandle } from '../components/MapView';
import { StatusBadge } from '../components/FleetPanel';
import { Ticker } from '../components/Ticker';
import { FleetyMark } from '../components/TopBar';
import { displayCallsign, fmtAgo, fmtAlt, fmtGs, fmtTime, fmtTimeUTC } from '../format';
import { useEventSound } from '../sound';
import { isSparkly } from '../sparkle';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// Big board card. The focused aircraft gets the hero treatment: full photo,
// huge callsign, live data readouts.
function BoardCard({ a, focused }: { a: LiveAircraft; focused: boolean }) {
  const airborne = a.status === 'airborne';
  return (
    <div
      className={`board-card${focused ? ' focused' : ''}${airborne ? ' airborne' : ''}${isSparkly(a) ? ' sparkle' : ''}`}
      style={{ ['--strip-color' as string]: a.color }}
    >
      {a.photoUrl && <div className="board-card-photo" style={{ backgroundImage: `url(${a.photoUrl})` }} />}
      <div className="board-card-content">
        <div className="board-card-head">
          <span className="board-callsign">{displayCallsign(a.callsign || (airborne ? a.liveCallsign : null)) || a.registration}</span>
          <StatusBadge status={a.status} />
        </div>
        <div className="mono-label">
          {a.registration} · {(a.nickname || a.typeName).toUpperCase()}
        </div>
        {focused && a.description && <div className="board-card-desc">{a.description}</div>}
        {airborne && a.pos ? (
          <>
            <div className="board-card-data">
              <span>
                <label>ALT</label>
                {fmtAlt(a.pos.altBaro)}
              </span>
              <span>
                <label>GS</label>
                {fmtGs(a.pos.gs)}
              </span>
            </div>
            {Date.now() - a.pos.ts > 90_000 && (
              <div className="board-card-last mono-label">SIGNAL LOST · LAST FIX {fmtAgo(a.pos.ts).toUpperCase()}</div>
            )}
          </>
        ) : a.status === 'awake' ? (
          <div className="board-card-last mono-label">
            TRANSPONDER LIVE{a.pos ? ` · LAST FIX ${fmtAgo(a.pos.ts).toUpperCase()}` : ' · AWAITING POSITION'}
          </div>
        ) : (
          <div className="board-card-last mono-label">{a.pos ? `LAST CONTACT ${fmtAgo(a.pos.ts).toUpperCase()}` : 'NO RECENT CONTACT'}</div>
        )}
        {(a.note || a.tagline) && <div className="board-card-note">{a.note ?? a.tagline}</div>}
      </div>
    </div>
  );
}

const CYCLE_MS = 12_000;
const EVENT_HOLD_MS = 25_000;

export function KioskPage() {
  const navigate = useNavigate();
  const { config, refresh, loading } = useAuth();
  const [ready, setReady] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const webgl = useMemo(webglAvailable, []);
  const live = useLiveFleet(ready);
  const mapRef = useRef<MapViewHandle>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [focusIdx, setFocusIdx] = useState(0);
  const [eventFocusId, setEventFocusId] = useState<number | null>(null);
  const eventFocusUntil = useRef(0);
  // TV pings on departures/landings by default; run Chromium with
  // --autoplay-policy=no-user-gesture-required so it works without a click.
  const [soundOn, toggleSound] = useEventSound('fv_sound_kiosk', true, live.tickerEvent);

  // Exchange the ?token= for a kiosk session cookie, then strip it from the
  // URL so it never shows on screen or in referrers.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const boot = async () => {
      if (token) {
        try {
          await post('/api/kiosk/exchange', { token });
          window.history.replaceState(null, '', '/kiosk');
          await refresh();
        } catch {
          setAuthFailed(true);
          return;
        }
      }
      setReady(true);
    };
    void boot();
  }, [refresh]);

  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Watchdog: reload nightly at ~03:00 and whenever the feed has been dead
  // for 5+ minutes — cheap insurance against browser leaks on a TV. lastEventAt
  // is read through a ref so the interval isn't torn down on every delta/ping
  // (which previously meant the nightly branch never survived long enough to fire).
  const lastEventAtRef = useRef(live.lastEventAt);
  lastEventAtRef.current = live.lastEventAt;
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 3 && now.getMinutes() < 2 && Date.now() - started > 10 * 60_000) {
        window.location.reload();
      }
      if (ready && Date.now() - lastEventAtRef.current > 5 * 60_000) {
        window.location.reload();
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [ready]);

  // Auto-refresh after a deploy: the built entry script is content-hashed, so
  // when the server starts serving a different filename than the one this kiosk
  // is running, a new version has shipped — reload to pick it up. No manual
  // trip to the TV required.
  useEffect(() => {
    const currentSrc = document.querySelector('script[type="module"][src]')?.getAttribute('src') ?? null;
    if (!currentSrc) return; // dev server (unhashed entry) — nothing to compare
    const check = async () => {
      try {
        const html = await (await fetch('/', { cache: 'no-store' })).text();
        const latest = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/i)?.[1];
        // Only reload on a confident, different match (ignore fetch errors and
        // the brief window mid-deploy where the server may be unreachable).
        if (latest && latest !== currentSrc) window.location.reload();
      } catch {
        /* deploy in progress or offline — retry on the next tick */
      }
    };
    const t = setInterval(() => void check(), 90_000);
    return () => clearInterval(t);
  }, []);

  const airborne = live.fleet.filter((a) => a.status === 'airborne');
  const rank = { awake: 0, ground: 1, offline: 2 } as Record<string, number>;
  const others = [...live.fleet.filter((a) => a.status !== 'airborne')].sort(
    (x, y) => (rank[x.status] ?? 3) - (rank[y.status] ?? 3)
  );

  // A departure/landing steals focus immediately and holds it a while.
  useEffect(() => {
    if (live.tickerEvent?.aircraftId) {
      setEventFocusId(live.tickerEvent.aircraftId);
      eventFocusUntil.current = Date.now() + EVENT_HOLD_MS;
    }
  }, [live.tickerEvent?.seq]);

  // Otherwise cycle focus through whatever is in the air.
  useEffect(() => {
    if (airborne.length === 0) return;
    const t = setInterval(() => {
      if (Date.now() > eventFocusUntil.current) {
        setEventFocusId(null);
        setFocusIdx((i) => i + 1);
      }
    }, CYCLE_MS);
    return () => clearInterval(t);
  }, [airborne.length]);

  const eventFocused =
    eventFocusId !== null && Date.now() < eventFocusUntil.current
      ? (live.fleet.find((a) => a.id === eventFocusId) ?? null)
      : null;
  const focused = eventFocused ?? (airborne.length > 0 ? airborne[focusIdx % airborne.length] : null);

  // Admin-chosen camera behaviour: chase the focused target, or hold an
  // overview that keeps every aircraft and the home bases in frame.
  const viewMode = config?.kioskViewMode ?? 'target';
  useEffect(() => {
    if (viewMode === 'overview') {
      // Centre on the cycled aircraft but stay zoomed out to hold the context.
      if (focused) mapRef.current?.fitOverviewOn(focused.id);
      else mapRef.current?.fitOverview();
      return;
    }
    if (focused) {
      mapRef.current?.flyToAircraft(focused.id);
    } else {
      mapRef.current?.fitFleet();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.id, viewMode, live.fleet.length === 0]);

  // Overview refit: aircraft drift out of frame between focus changes. Read the
  // current focus through a ref so the interval isn't torn down and recreated
  // on every ~12s focus cycle (which meant it rarely reached its 20s period).
  const focusedIdRef = useRef<number | null>(null);
  focusedIdRef.current = focused?.id ?? null;
  useEffect(() => {
    if (viewMode !== 'overview') return;
    const t = setInterval(() => {
      const id = focusedIdRef.current;
      if (id != null) mapRef.current?.fitOverviewOn(id);
      else mapRef.current?.fitOverview();
    }, 20_000);
    return () => clearInterval(t);
  }, [viewMode]);

  // TVs run for weeks — pick up settings changes without a manual reload.
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => void refresh(), 5 * 60_000);
    return () => clearInterval(t);
  }, [ready, refresh]);

  if (loading || !config) return <div className="kiosk-splash mono-label">ACQUIRING…</div>;
  if (authFailed)
    return <div className="kiosk-splash">Kiosk link is no longer valid — generate a new one in the admin panel.</div>;
  if (live.denied)
    return <div className="kiosk-splash">This screen needs a kiosk link. Open /kiosk?token=… from the admin panel.</div>;

  const railList = [
    ...(focused ? [focused] : []),
    ...airborne.filter((a) => a.id !== focused?.id),
    ...others.filter((a) => a.id !== focused?.id),
  ];

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        {/* Clicking the brand quietly exits kiosk mode (handy after the
            topbar Kiosk button; a TV never clicks it). */}
        <div
          className="brand"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
            navigate('/');
          }}
        >
          {config.logoUrl ? <img src={config.logoUrl} alt="" className="brand-logo" /> : <FleetyMark />}
          <span className="brand-name">
            {config.siteName.toUpperCase()}
            {config.subheading && <span className="brand-sub">{config.subheading.toUpperCase()}</span>}
          </span>
        </div>
        <div className="kiosk-status">
          <span className={`conn-dot ${live.connected ? 'ok' : 'bad'}`} />
          {airborne.length > 0 ? (
            <span>
              <strong className="kiosk-count">{airborne.length.toString().padStart(2, '0')}</strong> IN THE AIR
            </span>
          ) : (
            <span>ALL QUIET — FLEET ON THE GROUND</span>
          )}
        </div>
        <div className="kiosk-clocks">
          <button className="btn btn-ghost small kiosk-sound" onClick={toggleSound} title="Event sounds">
            {soundOn ? '🔔' : '🔕'}
          </button>
          <div>
            <label>UTC</label>
            <span>{fmtTimeUTC(clock)}</span>
          </div>
          <div>
            <label>LOCAL</label>
            <span>{fmtTime(clock)}</span>
          </div>
        </div>
      </header>
      <div className="kiosk-body">
        {webgl ? (
          <div className="kiosk-map">
            {/* followId keeps the camera glued to the focused aircraft (with
                dead-reckoned easing), not just a one-shot fly-to. */}
            <MapView ref={mapRef} config={config} fleet={live.fleet} followId={viewMode === 'target' ? (focused?.id ?? null) : null} kiosk />
            <div className="radar-sweep" aria-hidden />
          </div>
        ) : (
          <div className="kiosk-board">
            {live.fleet.map((a) => (
              <BoardCard key={a.id} a={a} focused={false} />
            ))}
          </div>
        )}
        {webgl && (
          <aside className="kiosk-rail">
            {railList.map((a) => (
              <BoardCard key={a.id} a={a} focused={focused?.id === a.id} />
            ))}
          </aside>
        )}
      </div>
      <Ticker size="board" enabled={ready && !live.denied} liveEvent={live.tickerEvent} />
    </div>
  );
}
