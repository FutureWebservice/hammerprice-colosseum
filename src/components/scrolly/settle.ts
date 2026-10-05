/**
 * Resting places of the hero room. The hero is scrubbed by scroll, so a visitor can stop anywhere, and between two beats that is a
 * half-faded line or a strike word in mid-fall: it reads as a bug. After the scroll stops, the page eases to the middle of the nearest
 * calm zone (a stretch of the scroll where one beat is fully opaque and nothing moves), never while the visitor is still scrolling or
 * touching, and never at the very ends: scrolling past the start or the end of the hero is always left alone.
 *
 * A plain module (no 'use client'): the pure parts are tested without a browser; `attachSettle` is the thin DOM wiring.
 */

/** Share of a beat's own range that fades in, and out (ScrollRoom.beatOpacity). */
export const FADE_FRACTION = 0.15;
/** Share of a strike's own slice in which it falls (ScrollRoom.strikeAt); it holds afterwards. */
export const STRIKE_FALL = 0.34;
/** How long the ease to a resting place takes. */
export const SETTLE_MS = 350;
/** Quiet time after the last scroll event before the page settles (the fallback where `scrollend` is missing, and for momentum). */
export const SETTLE_DEBOUNCE_MS = 120;

export interface CalmZone {
  /** The stretch of progress (0..1) in which everything on the stage is fully opaque and still. */
  lo: number;
  hi: number;
}

interface BeatLike {
  range: [number, number];
  strikes?: string[];
}

/** The calm zones of a room's beats, in progress order. A beat holds between its fades (a beat that starts at 0 or runs to 1 holds up to
 *  that edge, as beatOpacity does); a beat with strikes has one zone per strike, from the landing to just before the next word starts (both inside the beat's own hold). */
export function calmZones(beats: BeatLike[]): CalmZone[] {
  const zones: CalmZone[] = [];
  for (const { range: [start, end], strikes } of beats) {
    const span = end - start;
    if (span <= 0) continue;
    const hold = {
      lo: start > 0 ? start + span * FADE_FRACTION : 0,
      hi: end < 1 ? end - span * FADE_FRACTION : 1,
    };
    if (strikes && strikes.length > 0) {
      const slice = span / strikes.length;
      strikes.forEach((_, i) => {
        zones.push({ lo: Math.max(hold.lo, start + slice * (i + STRIKE_FALL)), hi: Math.min(hold.hi, start + slice * (i + 0.95)) });
      });
      continue;
    }
    zones.push(hold);
  }
  return zones.map((z) => ({ lo: Math.max(0, z.lo), hi: Math.min(1, z.hi) })).sort((a, b) => a.lo - b.lo);
}

/** The progress to settle on from `p`, or null when `p` is already inside a calm zone. Otherwise the middle of the nearest zone
 *  (nearest by its edge). Pure + testable. */
export function nearestRest(p: number, zones: CalmZone[]): number | null {
  let best: CalmZone | null = null;
  let bestD = Infinity;
  for (const z of zones) {
    if (p >= z.lo && p <= z.hi) return null;
    const d = p < z.lo ? z.lo - p : p - z.hi;
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  return best ? (best.lo + best.hi) / 2 : null;
}

/** Where to scroll (document y) to rest, or null to stay: the hero must be pinned right now (progress strictly inside 0..1, so the
 *  start and the end of the page are never pulled on), and a move under `minPx` is not worth making. `roomTop` and `roomHeight` are
 *  the room's bounding box, `vh` the viewport height. Pure + testable. */
export function settleScrollTarget(
  roomTop: number, roomHeight: number, vh: number, scrollY: number, zones: CalmZone[], minPx = 2,
): number | null {
  const total = roomHeight - vh;
  if (!(total > 0)) return null;
  const p = -roomTop / total;
  if (p <= 0 || p >= 1) return null;
  const rest = nearestRest(p, zones);
  if (rest === null) return null;
  const dy = (rest - p) * total;
  return Math.abs(dy) < minPx ? null : Math.round(scrollY + dy);
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Wires the settle to a window: after the scroll has been quiet for SETTLE_DEBOUNCE_MS (or on `scrollend`, or when the last finger
 *  lifts) ease to the nearest resting place. Any new wheel, touch, key or pointer input cancels the ease at once, so the visitor is never
 *  fought. Returns the cleanup. */
export function attachSettle(opts: {
  room: HTMLElement;
  zones: CalmZone[];
  reducedMotion: () => boolean;
  win?: Window;
}): () => void {
  const win = opts.win ?? window;
  let timer = 0;
  let raf = 0;
  let held = false; // a finger is down, or the mouse button is (a scrollbar drag): the visitor is still scrolling
  let animating = false;

  const cancelAnim = () => {
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    animating = false;
  };
  const attempt = () => {
    timer = 0;
    if (held || animating) return; // still in the visitor's hands
    const rect = opts.room.getBoundingClientRect();
    const from = win.scrollY;
    const to = settleScrollTarget(rect.top, rect.height, win.innerHeight, from, opts.zones);
    if (to === null) return;
    if (opts.reducedMotion()) {
      win.scrollTo({ top: to, behavior: 'instant' });
      return;
    }
    animating = true;
    const t0 = win.performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / SETTLE_MS);
      win.scrollTo({ top: from + (to - from) * easeInOutCubic(k), behavior: 'instant' });
      if (k < 1) raf = win.requestAnimationFrame(step);
      else cancelAnim();
    };
    raf = win.requestAnimationFrame(step);
  };
  const later = () => {
    win.clearTimeout(timer);
    timer = win.setTimeout(attempt, SETTLE_DEBOUNCE_MS);
  };
  const onScroll = () => {
    if (!animating) later(); // our own ease fires scroll events too
  };
  const onInput = () => {
    cancelAnim();
    later();
  };
  const onTouchStart = () => {
    held = true;
    onInput();
  };
  const onTouchEnd = (e: TouchEvent) => {
    held = e.touches.length > 0;
    later();
  };
  // touches are tracked by the touch events (a pointercancel fires when the browser takes over a swipe, while the finger is still down)
  const onMouseDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    held = true;
    onInput();
  };
  const onMouseUp = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    held = false;
    later();
  };
  const opt = { passive: true } as const;
  const inputs = ['wheel', 'keydown'] as const;
  win.addEventListener('scroll', onScroll, opt);
  win.addEventListener('scrollend', later, opt);
  win.addEventListener('touchstart', onTouchStart, opt);
  win.addEventListener('touchend', onTouchEnd, opt);
  win.addEventListener('touchcancel', onTouchEnd, opt);
  win.addEventListener('pointerdown', onMouseDown, opt);
  win.addEventListener('pointerup', onMouseUp, opt);
  win.addEventListener('pointercancel', onMouseUp, opt);
  inputs.forEach((e) => win.addEventListener(e, onInput, opt));
  return () => {
    win.clearTimeout(timer);
    cancelAnim();
    win.removeEventListener('scroll', onScroll);
    win.removeEventListener('scrollend', later);
    win.removeEventListener('touchstart', onTouchStart);
    win.removeEventListener('touchend', onTouchEnd);
    win.removeEventListener('touchcancel', onTouchEnd);
    win.removeEventListener('pointerdown', onMouseDown);
    win.removeEventListener('pointerup', onMouseUp);
    win.removeEventListener('pointercancel', onMouseUp);
    inputs.forEach((e) => win.removeEventListener(e, onInput));
  };
}
