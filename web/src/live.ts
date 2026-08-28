import { useEffect, useRef, useState } from 'react';
import type { LiveAircraft, LiveDelta } from './api';

export interface LiveTickerEvent {
  ts: number;
  text: string;
  aircraftId: number | null;
  seq: number; // bumps on every event so consumers can react
}

export interface LiveState {
  fleet: LiveAircraft[];
  connected: boolean;
  lastEventAt: number;
  denied: boolean; // stream rejected (needs login)
  tickerEvent: LiveTickerEvent | null; // most recent departure/landing push
}

// Subscribes to the server-sent event stream. Snapshot on connect, deltas
// after; EventSource handles reconnection itself.
export function useLiveFleet(enabled: boolean): LiveState {
  const [fleet, setFleet] = useState<LiveAircraft[]>([]);
  const [connected, setConnected] = useState(false);
  const [denied, setDenied] = useState(false);
  const [tickerEvent, setTickerEvent] = useState<LiveTickerEvent | null>(null);
  const [, setBeat] = useState(0); // re-render on keepalive so lastEventAt propagates to watchdogs
  const tickerSeq = useRef(0);
  const lastEventAt = useRef(Date.now());
  const byId = useRef(new Map<number, LiveAircraft>());

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    const es = new EventSource('/api/events');

    const push = () => {
      const list = [...byId.current.values()];
      setFleet(list);
    };

    // Any (re)connection means the stream is live — a Last-Event-ID resume
    // replays deltas with no snapshot, so don't wait for one to clear the flag.
    es.onopen = () => {
      setConnected(true);
      lastEventAt.current = Date.now();
    };

    // Named keepalive (not a bare SSE comment): proves a quiet feed is alive so
    // the kiosk watchdog doesn't reload every few minutes overnight.
    es.addEventListener('ping', () => {
      lastEventAt.current = Date.now();
      setBeat((b) => b + 1);
    });

    es.addEventListener('snapshot', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { aircraft: LiveAircraft[] };
      byId.current = new Map(data.aircraft.map((a) => [a.id, a]));
      lastEventAt.current = Date.now();
      setConnected(true);
      setDenied(false);
      push();
    });

    es.addEventListener('delta', (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { aircraft: LiveDelta[]; removed?: number[] };
      let needResync = false;
      for (const id of data.removed ?? []) byId.current.delete(id);
      for (const d of data.aircraft) {
        const existing = byId.current.get(d.id);
        if (!existing) {
          needResync = true;
          continue;
        }
        const { trailAppend, trailReset, ...rest } = d;
        const trail = trailReset ? [] : existing.trail;
        if (trailAppend) {
          // Array of points (current server) or a single pair (older server).
          if (Array.isArray(trailAppend[0])) for (const pt of trailAppend as [number, number][]) trail.push(pt);
          else trail.push(trailAppend as [number, number]);
        }
        byId.current.set(d.id, { ...existing, ...rest, trail });
      }
      lastEventAt.current = Date.now();
      setConnected(true);
      push();
      if (needResync) {
        // An aircraft we have never seen appeared mid-stream (admin added it):
        // pull a full snapshot.
        fetch('/api/state', { headers: { 'x-fleetview': '1' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((snap: { aircraft: LiveAircraft[] } | null) => {
            if (snap && !closed) {
              byId.current = new Map(snap.aircraft.map((a) => [a.id, a]));
              push();
            }
          })
          .catch(() => {});
      }
    });

    es.addEventListener('ticker', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as { ts: number; text: string; aircraftId: number | null };
        tickerSeq.current += 1;
        setTickerEvent({ ...data, seq: tickerSeq.current });
      } catch {
        /* malformed event */
      }
    });

    es.onerror = () => {
      setConnected(false);
      // If we are unauthenticated the stream will 401 forever; check once and
      // stop hammering.
      fetch('/api/me', { headers: { 'x-fleetview': '1' } })
        .then((r) => (r.ok ? r.json() : null))
        .then((me: { user: unknown; kiosk: boolean; publicMode: boolean } | null) => {
          if (me && !me.user && !me.kiosk && !me.publicMode) {
            setDenied(true);
            es.close();
          }
        })
        .catch(() => {});
    };

    return () => {
      closed = true;
      es.close();
    };
  }, [enabled]);

  return { fleet, connected, lastEventAt: lastEventAt.current, denied, tickerEvent };
}
