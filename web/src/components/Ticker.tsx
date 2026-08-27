import { useEffect, useMemo, useState } from 'react';
import { api, type TickerItem } from '../api';
import { useAuth } from '../auth';
import { fmtTime } from '../format';
import type { LiveTickerEvent } from '../live';

// The red band. `size` picks the compact site bar or the big board version;
// a live SSE ticker event triggers an immediate refetch so new departures
// hit the tape within a second of detection. The bar never disappears: a
// quiet tape shows a static ALL QUIET line instead (and only after a
// successful fetch — a failing /api/ticker keeps whatever was showing and
// logs, so an outage is never disguised as calm).
export function Ticker({
  size,
  enabled,
  liveEvent,
}: {
  size: 'bar' | 'board';
  enabled: boolean;
  liveEvent: LiveTickerEvent | null;
}) {
  const { config } = useAuth();
  const [items, setItems] = useState<TickerItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      api<{ items: TickerItem[] }>('/api/ticker')
        .then((r) => {
          setItems(r.items);
          setLoaded(true);
        })
        .catch((err) => console.warn('ticker fetch failed', err));
    load();
    const t = setInterval(load, 90_000);
    return () => clearInterval(t);
  }, [enabled, liveEvent?.seq]);

  const line = useMemo(
    () => items.map((i) => (i.ts > 0 ? `${fmtTime(i.ts)} — ${i.text}` : i.text)).join('   ▸▸▸   '),
    [items]
  );

  if (!enabled || !loaded) return null;

  if (!line) {
    // Quiet tape: static, centred, no marquee (short text would drift oddly).
    return (
      <div className={`ticker ticker-${size}`}>
        <span className="ticker-label">LIVE</span>
        <div className="ticker-window ticker-quiet">
          <span>ALL QUIET — {(config?.siteName ?? 'FLEETY').toUpperCase()} OPS MONITORING</span>
        </div>
      </div>
    );
  }

  const duration = Math.max(24, line.length * (size === 'board' ? 0.3 : 0.24));
  return (
    <div className={`ticker ticker-${size}`}>
      <span className="ticker-label">LIVE</span>
      <div className="ticker-window">
        <div className="ticker-inner" style={{ animationDuration: `${duration}s` }}>
          <span>{line}</span>
          <span aria-hidden>{line}</span>
        </div>
      </div>
    </div>
  );
}
