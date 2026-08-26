import { useMemo, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useLiveFleet } from '../live';
import { MapView, type MapViewHandle } from '../components/MapView';
import { AircraftCard, FleetPanel, StatusBadge } from '../components/FleetPanel';
import { TopBar } from '../components/TopBar';
import { fmtAgo, fmtAlt, fmtGs } from '../format';

export function LivePage() {
  const { me, config, loading } = useAuth();
  const live = useLiveFleet(!loading && !!config);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [following, setFollowing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const mapRef = useRef<MapViewHandle>(null);

  const selected = useMemo(() => live.fleet.find((a) => a.id === selectedId) ?? null, [live.fleet, selectedId]);
  const airborneCount = live.fleet.filter((a) => a.status === 'airborne').length;

  if (!loading && me && !me.user && !me.kiosk && !me.publicMode) {
    return <Navigate to="/login" replace />;
  }
  if (loading || !config) {
    return <div className="page-loading">Loading…</div>;
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
            <span className="muted small">
              {airborneCount > 0 ? `${airborneCount} airborne` : 'All quiet'}
            </span>
            <button className="btn btn-ghost small" onClick={() => mapRef.current?.fitFleet()}>
              Fit fleet
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
            {sheetOpen ? 'Hide fleet' : `Fleet${airborneCount ? ` · ${airborneCount} airborne` : ''}`}
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
            <div className="detail-card">
              <AircraftCard a={selected} />
              {selected.note && <p className="detail-note">{selected.note}</p>}
              <div className="detail-grid">
                <div>
                  <label>Altitude</label>
                  <strong>{fmtAlt(selected.pos?.altBaro ?? null)}</strong>
                </div>
                <div>
                  <label>Ground speed</label>
                  <strong>{fmtGs(selected.pos?.gs ?? null)}</strong>
                </div>
                <div>
                  <label>Squawk</label>
                  <strong>{selected.pos?.squawk ?? '—'}</strong>
                </div>
                <div>
                  <label>Last seen</label>
                  <strong>{selected.pos ? fmtAgo(selected.pos.ts) : '—'}</strong>
                </div>
              </div>
              <div className="detail-actions">
                <StatusBadge status={selected.status} />
                {selected.status === 'airborne' && (
                  <button
                    className={`btn small${following ? ' btn-primary' : ''}`}
                    onClick={() => setFollowing((v) => !v)}
                  >
                    {following ? 'Following' : 'Follow'}
                  </button>
                )}
                {selected.flightId && me?.user && (
                  <Link className="btn small" to={`/history/${selected.flightId}`}>
                    Flight so far
                  </Link>
                )}
                <button className="btn btn-ghost small" onClick={() => select(null)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
