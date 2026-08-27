import { useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useLiveFleet } from '../live';
import { MapView, type MapViewHandle } from '../components/MapView';
import { FleetPanel, StatusBadge } from '../components/FleetPanel';
import { TopBar } from '../components/TopBar';
import { Ticker } from '../components/Ticker';
import { displayCallsign, fmtAgo, fmtAlt, fmtGs } from '../format';
import { useEventSound } from '../sound';
import { LandingPage } from './PlatformPage';

export function LivePage() {
  const { me, config, loading } = useAuth();
  const live = useLiveFleet(!loading && !!config);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [following, setFollowing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const mapRef = useRef<MapViewHandle>(null);

  const selected = useMemo(() => live.fleet.find((a) => a.id === selectedId) ?? null, [live.fleet, selectedId]);
  const airborneCount = live.fleet.filter((a) => a.status === 'airborne').length;
  const [soundOn, toggleSound] = useEventSound('fv_sound_live', false, live.tickerEvent);

  if (!loading && config?.platform) {
    return <LandingPage />;
  }
  if (!loading && me && !me.user?.role && !me.user?.platformAdmin && !me.kiosk && !me.publicMode) {
    return <Navigate to="/login" replace />;
  }
  if (loading || !config) {
    return <div className="page-loading mono-label">ACQUIRING…</div>;
  }

  const select = (id: number | null) => {
    setSelectedId(id);
    setFollowing(false);
    if (id !== null) mapRef.current?.flyToAircraft(id);
  };

  return (
    <div className="app-shell">
      <TopBar />
      <div className="live-layout">
        <aside className="live-sidebar">
          <div className="sidebar-head">
            <span className={`conn-dot ${live.connected ? 'ok' : 'bad'}`} />
            <span className="mono-label">{live.connected ? 'FEED ACTIVE' : 'RECONNECTING'}</span>
            <button
              className="btn btn-ghost small"
              onClick={toggleSound}
              title="Ping on departures and landings"
            >
              {soundOn ? '🔔 ON' : '🔕 OFF'}
            </button>
            <button className="btn btn-ghost small" onClick={() => mapRef.current?.fitFleet()}>
              FIT
            </button>
          </div>
          <FleetPanel fleet={live.fleet} selectedId={selectedId} onSelect={select} />
        </aside>

        <main className="live-map">
          <MapView
            ref={mapRef}
            config={config}
            fleet={live.fleet}
            selectedId={selectedId}
            onSelect={select}
            followId={following ? selectedId : null}
          />

          {/* Mobile bottom sheet toggle */}
          <button className="sheet-toggle" onClick={() => setSheetOpen((v) => !v)}>
            {sheetOpen ? 'CLOSE' : `FLEET ${airborneCount ? `· ${airborneCount} AIRBORNE` : ''}`}
          </button>
          <div className={`bottom-sheet${sheetOpen ? ' open' : ''}`}>
            <FleetPanel
              fleet={live.fleet}
              selectedId={selectedId}
              onSelect={(id) => {
                select(id);
                setSheetOpen(false);
              }}
            />
          </div>

          {selected && (
            <div className="target-panel">
              <div className="target-head">
                <span className="mono-label">TARGET DATA</span>
                <button className="target-close" onClick={() => select(null)} aria-label="Close">
                  ✕
                </button>
              </div>
              {selected.photoUrl && (
                <div className="target-photo" style={{ backgroundImage: `url(${selected.photoUrl})` }} />
              )}
              <div className="target-id">
                <span className="target-callsign">
                  {displayCallsign((selected.status === 'airborne' && selected.liveCallsign) || selected.callsign) ||
                    selected.registration}
                </span>
                <StatusBadge status={selected.status} />
              </div>
              <div className="target-sub mono-label">
                {selected.registration} · {(selected.nickname || selected.typeName).toUpperCase()}
              </div>
              {selected.description && <p className="target-desc">{selected.description}</p>}
              {selected.tagline && <p className="target-tagline">{selected.tagline}</p>}
              {selected.note && <p className="target-note">{selected.note}</p>}
              <div className="target-grid">
                <div>
                  <label>Altitude</label>
                  <strong>{fmtAlt(selected.pos?.altBaro ?? null)}</strong>
                </div>
                <div>
                  <label>Grnd speed</label>
                  <strong>{fmtGs(selected.pos?.gs ?? null)}</strong>
                </div>
                <div>
                  <label>Squawk</label>
                  <strong>{selected.pos?.squawk ?? '——'}</strong>
                </div>
                <div>
                  <label>Contact</label>
                  <strong>{selected.pos ? fmtAgo(selected.pos.ts) : '——'}</strong>
                </div>
              </div>
              <div className="target-actions">
                {selected.status === 'airborne' && (
                  <button
                    className={`btn small${following ? ' btn-primary' : ''}`}
                    onClick={() => setFollowing((v) => !v)}
                  >
                    {following ? 'FOLLOWING' : 'FOLLOW'}
                  </button>
                )}
                {selected.flightId && me?.user && (
                  <Link className="btn small" to={`/history/${selected.flightId}`}>
                    FLIGHT SO FAR
                  </Link>
                )}
              </div>
            </div>
          )}

          <Ticker size="bar" enabled={!loading} liveEvent={live.tickerEvent} />
        </main>
      </div>
    </div>
  );
}
