import { useRef } from 'react';
import type React from 'react';

// Drag-down-to-dismiss for mobile cards and sheets. Spread the returned
// handlers onto a grab handle (not the scrollable body, so scrolling never
// fights the gesture); the panel tracks the finger, then springs back or
// slides out. A real flick dismisses even from a short drag.
export function useSwipeDismiss(
  panelRef: React.RefObject<HTMLElement | null>,
  onDismiss: () => void
) {
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);

  const settle = (el: HTMLElement, dismiss: boolean) => {
    el.style.transition = 'transform 0.18s ease-out';
    if (dismiss) {
      el.style.transform = 'translateY(110%)';
      window.setTimeout(() => {
        onDismiss();
        el.style.transform = '';
        el.style.transition = '';
      }, 170);
    } else {
      el.style.transform = '';
      window.setTimeout(() => {
        el.style.transition = '';
      }, 200);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone — tracking still works via bubbled moves */
    }
    drag.current = { y: e.clientY, t: performance.now(), dy: 0 };
    const el = panelRef.current;
    if (el) el.style.transition = 'none';
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dy = Math.max(0, e.clientY - drag.current.y);
    drag.current.dy = dy;
    const el = panelRef.current;
    if (el) el.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    const el = panelRef.current;
    if (!el || !d) return;
    const flick = d.dy / Math.max(performance.now() - d.t, 1) > 0.45;
    settle(el, d.dy > 90 || (flick && d.dy > 24));
  };

  return { onPointerDown, onPointerMove, onPointerUp: end, onPointerCancel: end };
}
