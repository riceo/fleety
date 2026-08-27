import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveTickerEvent } from './live';

// Two-tone "ding" synthesized with WebAudio — no asset, no network.
let ctx: AudioContext | null = null;

export function playPing(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const tone = (freq: number, at: number) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.16, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.7);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.75);
    };
    tone(880, 0); // A5
    tone(1318.5, 0.13); // E6
  } catch {
    /* audio unavailable (or blocked until a user gesture) */
  }
}

// Sound preference per surface (site defaults quiet, kiosk defaults on),
// remembered in localStorage; plays the ping on every live ticker event.
export function useEventSound(
  storageKey: string,
  defaultOn: boolean,
  liveEvent: LiveTickerEvent | null
): [boolean, () => void] {
  const [enabled, setEnabled] = useState(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? defaultOn : stored === '1';
    } catch {
      return defaultOn;
    }
  });
  const lastSeq = useRef(0);

  useEffect(() => {
    if (!liveEvent || liveEvent.seq === lastSeq.current) return;
    lastSeq.current = liveEvent.seq;
    if (enabled) playPing();
  }, [liveEvent, enabled]);

  const toggle = useCallback(() => {
    setEnabled((v) => {
      try {
        localStorage.setItem(storageKey, v ? '0' : '1');
      } catch {
        /* private mode */
      }
      if (!v) playPing(); // audible confirmation, also unlocks the AudioContext
      return !v;
    });
  }, [storageKey]);

  return [enabled, toggle];
}
