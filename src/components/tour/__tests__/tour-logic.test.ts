import { beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '@/lib/client/safe-storage';
import { TOUR_KEY, markTourSeen, resetTourSession, stepIndex, wantsAutoTour } from '../tour-logic';
import { TOUR_STEPS, stepsOf } from '../steps';

const memory = (): Store & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
};
const blocked: Store = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };

beforeEach(resetTourSession);

describe('tour start rules', () => {
  it('starts on a first visit', () => expect(wantsAutoTour('', memory())).toBe(true));
  it('does not start again once it was seen (key hp.tour.v1)', () => {
    const s = memory();
    markTourSeen(s);
    expect(s.m.get(TOUR_KEY)).toBe('1');
    resetTourSession();
    expect(wantsAutoTour('', s)).toBe(false);
  });
  it('?tour=0 switches the automatic start off', () => {
    expect(wantsAutoTour('?tour=0', memory())).toBe(false);
    expect(wantsAutoTour('?foo=1&tour=0', memory())).toBe(false);
    expect(wantsAutoTour('?tour=1', memory())).toBe(true);
  });
  it('with storage blocked it does not crash and runs at most once per page session', () => {
    expect(wantsAutoTour('', blocked)).toBe(true);
    expect(() => markTourSeen(blocked)).not.toThrow();
    expect(wantsAutoTour('', blocked)).toBe(false);
    expect(wantsAutoTour('', null)).toBe(false);
  });
});

describe('stepping skips steps whose anchor is not on the page', () => {
  const ids = TOUR_STEPS.map((s) => s.id as string);
  it('has the five steps in the planned order', () => expect(ids).toEqual(['stage', 'clock', 'bid', 'rail', 'help']));
  it('walks forward and back over what exists', () => {
    const exists = (id: string) => id !== 'clock' && id !== 'rail';
    expect(stepIndex(ids, -1, 1, exists)).toBe(0);
    expect(stepIndex(ids, 0, 1, exists)).toBe(2);
    expect(stepIndex(ids, 2, 1, exists)).toBe(4);
    expect(stepIndex(ids, 4, 1, exists)).toBe(-1);
    expect(stepIndex(ids, 4, -1, exists)).toBe(2);
    expect(stepIndex(ids, 0, -1, exists)).toBe(-1);
  });
  it('finds nothing when no anchor exists', () => expect(stepIndex(ids, -1, 1, () => false)).toBe(-1));
});

describe('tour flows', () => {
  it('each flow ends with the shared help step and has its own anchors', () => {
    for (const flow of ['room', 'sell'] as const) {
      const ids = stepsOf(flow).map((s) => s.id);
      expect(ids[ids.length - 1]).toBe('help');
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(stepsOf('room').map((s) => s.anchor)).toEqual(['stage', 'clock', 'bid', 'rail', 'help']);
    expect(stepsOf('sell').map((s) => s.anchor)).toEqual(['sell-steps', 'sell-step', 'sell-nav', 'help']);
  });
  it('one key, one value: whichever flow starts first marks the tour as seen, and Help replays it on any page', () => {
    const s = memory();
    markTourSeen(s);
    expect(s.m.get(TOUR_KEY)).toBe('1');
    resetTourSession();
    expect(wantsAutoTour('', s)).toBe(false);
  });
});
