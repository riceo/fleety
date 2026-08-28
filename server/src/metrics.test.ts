import { describe, expect, it } from 'vitest';
import { openTestDb } from './db/index.js';
import { LiveBus } from './live/liveBus.js';
import { collectMetrics, evaluateAndAlert, startEventLoopMonitor, type AlertSink } from './metrics.js';

describe('metrics', () => {
  it('collects the single-box vitals with a health per metric', () => {
    startEventLoopMonitor();
    const db = openTestDb();
    const report = collectMetrics(db, new LiveBus());
    const keys = report.metrics.map((m) => m.key).sort();
    expect(keys).toEqual(['db', 'disk', 'loop', 'poll', 'rss', 'sse']);
    for (const m of report.metrics) {
      expect(['ok', 'watch', 'alert']).toContain(m.health);
      expect(typeof m.display).toBe('string');
      expect(m.note.length).toBeGreaterThan(0);
    }
    expect(['ok', 'watch', 'alert']).toContain(report.worst);
    expect(report.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('evaluate persists alert state and only sends on a red metric, debounced', async () => {
    const db = openTestDb();
    const live = new LiveBus();
    // A poll cycle far over the 8 s alert threshold forces exactly one metric red.
    db.prepare('INSERT INTO poll_log (ts, provider, ok, duration_ms) VALUES (?, ?, 1, 99000)').run(Date.now(), 'p');

    const store = new Map<string, string>();
    const sent: string[] = [];
    const sink: AlertSink = {
      get: (k, fb) => store.get(k) ?? fb ?? '',
      set: (k, v) => void store.set(k, v),
      send: async (subject) => void sent.push(subject),
    };

    await evaluateAndAlert(db, live, sink);
    expect(sent).toHaveLength(1); // poll cycle red => one alert
    const state = JSON.parse(store.get('alert_state') ?? '{}');
    expect(state.poll).toBeGreaterThan(0); // debounce timestamp recorded

    // Immediately re-evaluating must NOT re-send (hourly debounce per metric).
    await evaluateAndAlert(db, live, sink);
    expect(sent).toHaveLength(1);
  });
});
