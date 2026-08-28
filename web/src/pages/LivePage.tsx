import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { useLiveFleet } from '../live';
import { MapView, type MapViewHandle } from '../components/MapView';
import { FleetPanel, StatusBadge } from '../components/FleetPanel';
import { TopBar } from '../components/TopBar';
import { Ticker } from '../components/Ticker';
import { displayCallsign, fmtAgo, fmtAlt, fmtGs } from '../format';
import { useEventSound } from '../sound';
import { isSparkly } from '../sparkle';
import { useSwipeDismiss } from '../useSwipeDismiss';
import { LandingPage } from './PlatformPage';

export function LivePage() {
  const { me, config, loading } = useAuth();
  const { reg: deepLinkReg } = useParams();
  const live = useLiveFleet(!loading && !!config);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [following, setFollowing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shared, setShared] = useState(false);
  const deepLinkDone = useRef(false);
  const mapRef = useRef<MapViewHandle>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // Hooks stay above the early returns; `select` is only called long after
  // the render in which these closures were created.
  const targetSwipe = useSwipeDismiss(targetRef, () => select(null));
  const sheetSwipe = useSwipeDismiss(sheetRef, () => setSheetOpen(false));

  // Deep link (/ac/G-PSZB or /ac/INV09): select and follow the aircraft once
  // the fleet arrives.
  useEffect(() => {
    if (!deepLinkReg || deepLinkDone.current || live.fleet.length === 0) return;
    const want = deepLinkReg.trim().toUpperCase();
    const target = live.fleet.find(
      (a) =>
        a.registration.toUpperCase() === want ||
        a.callsign.toUpperCase() === want ||
        (a.liveCallsign ?? '').toUpperCase() === want
    );
    deepLinkDone.current = true;
    if (target) {
      setSelectedId(target.id);
      mapRef.current?.flyToAircraft(target.id);
      if (target.status === 'airborne') setFollowing(true);
    }
  }, [deepLinkReg, live.fleet]);

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
    setShared(false);
    // The address bar is the share link.
    if (id !== null) {
      const a = live.fleet.find((x) => x.id === id);
      if (a) window.history.replaceState(null, '', `/ac/${encodeURIComponent(a.registration)}`);
      mapRef.current?.flyToAircraft(id);
    } else {
      window.history.replaceState(null, '', '/');
    }
  };

  const share = async (registration: string, label: string) => {
    // ?s = current minute bucket. A deliberate share captures the aircraft's
    // live state at share time, while staying identical (so Cloudflare-cached)
    // for everyone sharing within the same minute. The address bar keeps the
    // clean evergreen URL — only this explicit share carries the bucket.
    const bucket = Math.floor(Date.now() / 60_000);
    const url = `${window.location.origin}/ac/${encodeURIComponent(registration)}?s=${bucket}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: `${label} — ${config?.siteName ?? 'Fleety'}`, url });
        return;
      }
    } catch (err) {
      // Cancelling the OS share sheet throws AbortError — that's a deliberate
      // "no", so stop here rather than silently copying and flashing success.
      if (err instanceof Error && err.name === 'AbortError') return;
      // Any other failure (share unsupported at runtime): fall through to copy.
    }
    try {
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 2000);
    } catch {
      window.prompt('Copy link:', url);
    }
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

          {/* Mobile bottom sheet toggle (yields to the target card) */}
          {!selected && (
            <button className="sheet-toggle" onClick={() => setSheetOpen((v) => !v)}>
              {sheetOpen ? 'CLOSE' : `FLEET ${airborneCount ? `· ${airborneCount} AIRBORNE` : ''}`}
            </button>
          )}
          <div ref={sheetRef} className={`bottom-sheet${sheetOpen ? ' open' : ''}`}>
            <div className="sheet-grab" {...sheetSwipe}>
              <span />
            </div>
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
            <div ref={targetRef} className={`target-panel${isSparkly(selected) ? ' sparkle' : ''}`}>
              <div className="sheet-grab target-grab" {...targetSwipe}>
                <span />
              </div>
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
                  {displayCallsign(selected.callsign || (selected.status === 'airborne' ? selected.liveCallsign : null)) ||
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
                  <strong>
                    {selected.pos || selected.awakeTs
                      ? fmtAgo(Math.max(selected.pos?.ts ?? 0, selected.awakeTs ?? 0))
                      : '——'}
                  </strong>
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
                    FLIGHT TRACK
                  </Link>
                )}
                <button
                  className="btn small"
                  onClick={() =>
                    void share(
                      selected.registration,
                      displayCallsign(selected.callsign) || selected.registration
                    )
                  }
                >
                  {shared ? 'LINK COPIED ✓' : 'SHARE'}
                </button>
              </div>
            </div>
          )}

          <Ticker size="bar" enabled={!loading} liveEvent={live.tickerEvent} />
        </main>
      </div>
    </div>
  );
}
