import { useEffect, useMemo, useState } from 'react';
import { api, type TickerItem } from '../api';
import { fmtTime } from '../format';
import type { LiveTickerEvent } from '../live';

// The red band. `size` picks the compact site bar or the big board version;
// a live SSE ticker event triggers an immediate refetch so new departures
// hit the tape within a second of detection.
export function Ticker({
  size,
  enabled,
  liveEvent,
}: {
  size: 'bar' | 'board';
  enabled: boolean;
  liveEvent: LiveTickerEvent | null;
}) {
  const [items, setItems] = useState<TickerItem[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      api<{ items: TickerItem[] }>('/api/ticker')
        .then((r) => setItems(r.items))
        .catch(() => {});
    load();
    const t = setInterval(load, 90_000);
    return () => clearInterval(t);
  }, [enabled, liveEvent?.seq]);

  const line = useMemo(
    () => items.map((i) => (i.ts > 0 ? `${fmtTime(i.ts)} — ${i.text}` : i.text)).join('   ▸▸▸   '),
    [items]
  );
  if (!line) return null;
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
