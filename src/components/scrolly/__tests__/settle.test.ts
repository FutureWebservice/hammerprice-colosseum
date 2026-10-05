import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beatOpacity, strikeAt, localProgress } from '../ScrollRoom';
import { maxDpr } from '../CanvasSequence';
import { SETTLE_DEBOUNCE_MS, SETTLE_MS, attachSettle, calmZones, easeInOutCubic, nearestRest, settleScrollTarget } from '../settle';

// the landing's beats (HammerpriceLanding.tsx), ranges only
const beats = [
  { range: [0, 0.12] as [number, number] },
  { range: [0.12, 0.28] as [number, number] },
  { range: [0.28, 0.46] as [number, number] },
  { range: [0.46, 0.62] as [number, number], strikes: ['Zum Ersten', 'Zum Zweiten'] },
  { range: [0.62, 0.74] as [number, number] },
  { range: [0.74, 0.88] as [number, number] },
  { range: [0.88, 1.1] as [number, number] },
];
const zones = calmZones(beats);

describe('calmZones', () => {
  it('a beat holds between its fades; the first and the last hold up to the edge of the room', () => {
    expect(zones[0]!.lo).toBe(0);
    expect(zones[zones.length - 1]!.hi).toBe(1);
    expect(zones[1]!.lo).toBeCloseTo(0.12 + 0.16 * 0.15, 6);
    expect(zones[1]!.hi).toBeCloseTo(0.28 - 0.16 * 0.15, 6);
  });
  it('the strike beat has one zone per word, each after the word has landed', () => {
    const strike = zones.filter((z) => z.lo > 0.46 && z.hi < 0.62);
    expect(strike).toHaveLength(2);
  });
  it('every beat is fully opaque, the others invisible and the word still, at every point of every zone', () => {
    for (const z of zones) {
      for (let k = 0; k <= 10; k++) {
        const p = z.lo + ((z.hi - z.lo) * k) / 10;
        const lit = beats.map((b) => beatOpacity(p, b.range)).filter((o) => o > 0);
        expect(lit, `p=${p}`).toHaveLength(1);
        expect(lit[0], `p=${p}`).toBeCloseTo(1, 6);
      }
    }
    const sb = beats[3]!;
    for (const z of zones.filter((q) => q.lo > 0.46 && q.hi < 0.62)) {
      for (const p of [z.lo, (z.lo + z.hi) / 2, z.hi]) {
        const lp = localProgress(p, sb.range);
        const words = sb.strikes!.map((_, i) => strikeAt(lp, i, 2)).filter((w) => w.opacity > 0);
        expect(words, `p=${p}`).toEqual([{ drop: 0, opacity: 1 }]);
      }
    }
  });
});

describe('beat transitions', () => {
  it('two beats are never on screen at once (one fades out completely before the next fades in)', () => {
    for (let k = 0; k <= 2000; k++) {
      const p = k / 2000;
      expect(beats.filter((b) => beatOpacity(p, b.range) > 0).length, `p=${p}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('nearestRest', () => {
  it('is null inside a zone (already resting, no move)', () => {
    expect(nearestRest(0, zones)).toBeNull();
    expect(nearestRest(0.2, zones)).toBeNull();
    expect(nearestRest(1, zones)).toBeNull();
  });
  it('between two beats it is the middle of the nearest zone', () => {
    const z = zones[1]!; // second beat
    const mid = (z.lo + z.hi) / 2;
    expect(nearestRest(0.121, zones)).toBeCloseTo((zones[0]!.lo + zones[0]!.hi) / 2, 6); // nearer to the first beat's zone
    expect(nearestRest(0.14, zones)).toBeCloseTo(mid, 6);
  });
  it('mid-fall of a strike word settles on a landed word', () => {
    const p = 0.46 + 0.16 * 0.1; // the first word is still falling
    const rest = nearestRest(p, zones)!;
    expect(rest).not.toBeNull();
    expect(nearestRest(rest, zones)).toBeNull();
  });
  it('the result is always a place that needs no further move', () => {
    for (let k = 0; k <= 1000; k++) {
      const r = nearestRest(k / 1000, zones);
      if (r !== null) expect(nearestRest(r, zones)).toBeNull();
    }
  });
});

describe('settleScrollTarget', () => {
  // a 1000 px high viewport, a room of 7 viewports: 6000 px of pinned scroll
  const vh = 1000;
  const h = 7000;
  const at = (p: number) => -p * (h - vh); // the room's top for progress p
  it('never pulls at the start or at the end of the hero (scrolling past either always works)', () => {
    expect(settleScrollTarget(100, h, vh, 0, zones)).toBeNull(); // the room is still below the top of the screen
    expect(settleScrollTarget(0, h, vh, 0, zones)).toBeNull(); // p = 0
    expect(settleScrollTarget(at(1), h, vh, 6000, zones)).toBeNull(); // p = 1
    expect(settleScrollTarget(at(1) - 400, h, vh, 6400, zones)).toBeNull(); // scrolled past
  });
  it('stays put inside a calm zone, and for a move under 2 px', () => {
    expect(settleScrollTarget(at(0.2), h, vh, 1200 + 500, zones)).toBeNull();
    const tiny = [{ lo: 0.5, hi: 0.5005 }];
    expect(settleScrollTarget(at(0.49999), h, vh, 3000, tiny)).toBeNull(); // under 2 px to go
  });
  it('between beats it returns the scroll position of the rest, from any current scroll position', () => {
    const p = 0.13; // between the first and the second beat
    const rest = nearestRest(p, zones)!;
    const y = 700; // some scrollY (the room starts 500 px down the page)
    const to = settleScrollTarget(at(p), h, vh, y, zones)!;
    expect(to).toBe(Math.round(y + (rest - p) * (h - vh)));
  });
});

describe('easeInOutCubic', () => {
  it('runs 0 to 1, monotonic', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    let prev = 0;
    for (let k = 1; k <= 20; k++) {
      const v = easeInOutCubic(k / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('attachSettle', () => {
  const vh = 1000;
  const h = 7000;
  let scrollY = 0;
  let top = 0; // the room's top, driven by scrollY: the room starts at the top of the page
  let now = 0;
  let off: () => void;
  const scrollTo = vi.fn((o: ScrollToOptions) => {
    scrollY = o.top as number;
    top = -scrollY;
  });
  const setP = (p: number) => {
    scrollY = p * (h - vh);
    top = -scrollY;
  };
  // a window with just what attachSettle uses (the suite runs without a DOM)
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  const fakeWin = {
    addEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, [...(listeners.get(t) ?? []), f]),
    removeEventListener: (t: string, f: (e: unknown) => void) => listeners.set(t, (listeners.get(t) ?? []).filter((g) => g !== f)),
    get scrollY() { return scrollY; },
    innerHeight: vh,
    scrollTo,
    performance: { now: () => now },
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id),
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(now), 16) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  };
  const room = { getBoundingClientRect: () => ({ top, height: h }) } as unknown as HTMLElement;
  const attach = (reduced: boolean) => attachSettle({ room, zones, reducedMotion: () => reduced, win: fakeWin as unknown as Window });
  const user = (ev: string, extra: object = {}) => (listeners.get(ev) ?? []).forEach((f) => f({ type: ev, ...extra }));

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    scrollTo.mockClear();
    listeners.clear();
    off = attach(false);
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      now += 16;
      vi.advanceTimersByTime(16);
    }
  };

  it('eases to the nearest rest once the scroll has been quiet, and ends exactly there', () => {
    setP(0.13);
    const rest = nearestRest(0.13, zones)!;
    user('scroll');
    advance(SETTLE_DEBOUNCE_MS - 20);
    expect(scrollTo).not.toHaveBeenCalled(); // still inside the quiet period
    advance(40 + SETTLE_MS + 60);
    expect(scrollTo).toHaveBeenCalled();
    expect(scrollY).toBe(Math.round(rest * (h - vh)));
  });
  it('a scroll event inside the quiet period restarts the wait (never fights an active scroll)', () => {
    setP(0.13);
    user('scroll');
    advance(100);
    user('scroll');
    advance(100);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it('waits while a finger is down and settles after it lifts', () => {
    setP(0.13);
    user('touchstart');
    user('scroll');
    advance(1000);
    expect(scrollTo).not.toHaveBeenCalled();
    user('touchend', { touches: [] });
    advance(SETTLE_DEBOUNCE_MS + SETTLE_MS + 60);
    expect(scrollTo).toHaveBeenCalled();
  });
  it('input during the ease stops it', () => {
    setP(0.13);
    user('scroll');
    advance(SETTLE_DEBOUNCE_MS + 100);
    expect(scrollTo).toHaveBeenCalled();
    scrollTo.mockClear();
    user('wheel');
    advance(60);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it('does nothing when already resting, at the top, or past the end', () => {
    for (const p of [0, 0.2, 0.95, 1]) {
      setP(p);
      user('scroll');
      advance(SETTLE_DEBOUNCE_MS + SETTLE_MS + 60);
    }
    expect(scrollTo).not.toHaveBeenCalled();
    scrollY = 6400; // past the end of the hero
    top = -6400;
    user('scroll');
    advance(SETTLE_DEBOUNCE_MS + SETTLE_MS + 60);
    expect(scrollTo).not.toHaveBeenCalled();
  });
  it('with reduced motion it jumps in one step', () => {
    off();
    off = attach(true);
    setP(0.13);
    user('scroll');
    advance(SETTLE_DEBOUNCE_MS + 20);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0]![0]).toMatchObject({ behavior: 'instant' });
  });
  it('scrollend settles too', () => {
    setP(0.13);
    user('scrollend');
    advance(SETTLE_DEBOUNCE_MS + SETTLE_MS + 60);
    expect(scrollTo).toHaveBeenCalled();
  });
});

describe('maxDpr', () => {
  it('caps a weak device (4 cores or fewer, or 4 GB or less) at 1.5, any other at 2', () => {
    expect(maxDpr({ hardwareConcurrency: 4 })).toBe(1.5);
    expect(maxDpr({ hardwareConcurrency: 8, deviceMemory: 4 })).toBe(1.5);
    expect(maxDpr({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(2);
    expect(maxDpr({})).toBe(2);
  });
});
