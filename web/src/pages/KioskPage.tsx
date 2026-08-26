import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post, type LiveAircraft, type TickerItem } from '../api';
import { useAuth } from '../auth';
import { useLiveFleet } from '../live';
import { MapView, type MapViewHandle } from '../components/MapView';
import { StatusBadge } from '../components/FleetPanel';
import { fmtAgo, fmtAlt, fmtGs, fmtTime } from '../format';
import { BrandMark } from '../components/TopBar';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

// Plane-spotting card: the aircraft photo fills the card so people in the
// coffee shop can recognise what is overhead.
function KioskCard({ a, focused }: { a: LiveAircraft; focused: boolean }) {
  return (
    <div
      className={`kiosk-card${focused ? ' focused' : ''}${a.status === 'airborne' ? ' airborne' : ''}${a.photoUrl ? ' has-photo' : ''}`}
    >
      {a.photoUrl && <div className="kiosk-card-photo" style={{ backgroundImage: `url(${a.photoUrl})` }} />}
      <div className="kiosk-card-content">
        <div className="kiosk-card-head">
          <span className="kiosk-reg">
            {a.status === 'airborne' && a.liveCallsign ? a.liveCallsign : a.registration}
          </span>
          <StatusBadge status={a.status} />
        </div>
        <div className="kiosk-card-type">{a.nickname || a.typeName}</div>
        {a.status === 'airborne' && a.pos ? (
          <div className="kiosk-card-stats">
            <span>{fmtAlt(a.pos.altBaro)}</span>
            <span>{fmtGs(a.pos.gs)}</span>
          </div>
        ) : (
          <div className="kiosk-card-stats muted">{a.pos ? fmtAgo(a.pos.ts) : 'no recent data'}</div>
        )}
        {a.note && <div className="kiosk-card-note">{a.note}</div>}
      </div>
    </div>
  );
}

function Ticker({ enabled }: { enabled: boolean }) {
  const [items, setItems] = useState<TickerItem[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      api<{ items: TickerItem[] }>('/api/ticker')
        .then((r) => setItems(r.items))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [enabled]);

  const line = useMemo(
    () => items.map((i) => `${fmtTime(i.ts)}  ${i.text}`).join('   ✦   '),
    [items]
  );
  if (!line) return null;
  // Content is doubled for a seamless CSS marquee loop.
  const duration = Math.max(20, line.length * 0.28);
  return (
    <div className="kiosk-ticker">
      <div className="kiosk-ticker-inner" style={{ animationDuration: `${duration}s` }}>
        <span>{line}</span>
        <span aria-hidden>{line}</span>
      </div>
    </div>
  );
}

export function KioskPage() {
  const { config, refresh, loading } = useAuth();
  const [ready, setReady] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const webgl = useMemo(webglAvailable, []);
  const live = useLiveFleet(ready);
  const mapRef = useRef<MapViewHandle>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [focusIdx, setFocusIdx] = useState(0);

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

  // Cycle camera focus between airborne aircraft every 15s.
  useEffect(() => {
    if (airborne.length === 0) return;
    const t = setInterval(() => setFocusIdx((i) => i + 1), 15_000);
    return () => clearInterval(t);
  }, [airborne.length]);

  const focused = airborne.length > 0 ? airborne[focusIdx % airborne.length] : null;

  useEffect(() => {
    if (focused) {
      mapRef.current?.flyToAircraft(focused.id);
    } else {
      mapRef.current?.fitFleet();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.id, live.fleet.length === 0]);

  if (loading || !config) return <div className="kiosk-splash">Starting…</div>;
  if (authFailed)
    return <div className="kiosk-splash">Kiosk link is no longer valid — generate a new one in the admin panel.</div>;
  if (live.denied)
    return <div className="kiosk-splash">This screen needs a kiosk link. Open /kiosk?token=… from the admin panel.</div>;

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <div className="brand">
          {config.logoUrl ? <img src={config.logoUrl} alt="" className="brand-logo" /> : <BrandMark />}
          <span className="brand-name">{config.siteName}</span>
        </div>
        <div className="kiosk-status">
          {airborne.length > 0 ? `${airborne.length} aircraft airborne` : 'Fleet on the ground'}
          <span className={`conn-dot ${live.connected ? 'ok' : 'bad'}`} />
        </div>
        <div className="kiosk-clock">{fmtTime(clock)}</div>
      </header>
      <div className="kiosk-body">
        {webgl ? (
          <div className="kiosk-map">
            <MapView ref={mapRef} config={config} fleet={live.fleet} kiosk />
          </div>
        ) : (
          <div className="kiosk-board">
            {/* Departure-board fallback for screens without WebGL */}
            {live.fleet.map((a) => (
              <KioskCard key={a.id} a={a} focused={false} />
            ))}
          </div>
        )}
        {webgl && (
          <aside className="kiosk-rail">
            {airborne.map((a) => (
              <KioskCard key={a.id} a={a} focused={focused?.id === a.id} />
            ))}
            {others.map((a) => (
              <KioskCard key={a.id} a={a} focused={false} />
            ))}
          </aside>
        )}
      </div>
      <Ticker enabled={ready && !live.denied} />
    </div>
  );
}
