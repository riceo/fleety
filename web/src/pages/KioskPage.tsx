import { useEffect, useMemo, useRef, useState } from 'react';
import { post, type LiveAircraft } from '../api';
import { useAuth } from '../auth';
import { useLiveFleet } from '../live';
import { MapView, type MapViewHandle } from '../components/MapView';
import { StatusBadge } from '../components/FleetPanel';
import { Ticker } from '../components/Ticker';
import { DEFAULT_LOGO } from '../components/TopBar';
import { displayCallsign, fmtAgo, fmtAlt, fmtGs, fmtTime, fmtTimeUTC } from '../format';
import { useEventSound } from '../sound';

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
      className={`board-card${focused ? ' focused' : ''}${airborne ? ' airborne' : ''}`}
      style={{ ['--strip-color' as string]: a.color }}
    >
      {a.photoUrl && <div className="board-card-photo" style={{ backgroundImage: `url(${a.photoUrl})` }} />}
      <div className="board-card-content">
        <div className="board-card-head">
          <span className="board-callsign">{displayCallsign((airborne && a.liveCallsign) || a.callsign) || a.registration}</span>
          <StatusBadge status={a.status} />
        </div>
        <div className="mono-label">
          {a.registration} · {(a.nickname || a.typeName).toUpperCase()}
        </div>
        {airborne && a.pos ? (
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
  // for 5+ minutes — cheap insurance against browser leaks on a TV.
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 3 && now.getMinutes() < 2 && Date.now() - started > 10 * 60_000) {
        window.location.reload();
      }
      if (ready && Date.now() - live.lastEventAt > 5 * 60_000) {
        window.location.reload();
      }
    }, 60_000);
    return () => clearInterval(t);
  }, [ready, live.lastEventAt]);

  const airborne = live.fleet.filter((a) => a.status === 'airborne');
  const others = live.fleet.filter((a) => a.status !== 'airborne');

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

  useEffect(() => {
    if (focused) {
      mapRef.current?.flyToAircraft(focused.id);
    } else {
      mapRef.current?.fitFleet();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.id, live.fleet.length === 0]);

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
        <div className="brand">
          <img src={config.logoUrl || DEFAULT_LOGO} alt="" className="brand-logo" />
          <span className="brand-name">
            {config.siteName.toUpperCase()}
            <span className="brand-sub">OPERATIONS BOARD</span>
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
            <MapView ref={mapRef} config={config} fleet={live.fleet} kiosk />
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
