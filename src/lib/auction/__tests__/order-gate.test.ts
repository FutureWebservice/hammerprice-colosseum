/** The drawn-order gate in the pure engine: wait, default, none, and a catalogue show that never feels it. */
import { describe, expect, it } from 'vitest';
import { RULE_DEFAULTS } from '../rules';
import { decideTick, orderGateOf, type TickInput } from '../engine';

const NOW = 1_800_000_000_000;
const rules = { ...RULE_DEFAULTS, gapS: 6 };
const base = (over: Partial<Omit<TickInput, 'show'>> & { show?: Partial<TickInput['show']> } = {}): TickInput => ({
  now: NOW, openLot: null, openableLots: 3, lastClosedAt: null, ...over, show: { status: 'live', scheduledAt: null, rules, ...over.show },
});

describe('orderGateOf', () => {
  const g = (o: Partial<Parameters<typeof orderGateOf>[0]>) => orderGateOf({ orderMode: 'vrf', requestStatus: 'pending', revealByMs: NOW + 1000, nowMs: NOW, ...o });

  it('waits while the draw is pending or committed and its deadline is ahead', () => {
    expect(g({ requestStatus: 'pending' })).toBe('wait');
    expect(g({ requestStatus: 'committed' })).toBe('wait');
    expect(g({ requestStatus: 'committed', revealByMs: NOW + 1 })).toBe('wait');
  });

  it('defaults once the deadline has come (the boundary belongs to default), if the draw is still unrevealed', () => {
    expect(g({ revealByMs: NOW })).toBe('default');
    expect(g({ requestStatus: 'committed', revealByMs: NOW - 5000 })).toBe('default');
    expect(g({ requestStatus: 'pending', revealByMs: null })).toBe('default'); // no deadline on record is never a reason to wait forever
  });

  it('is none for a catalogue show, a revealed or defaulted draw, a missing request or an unknown status', () => {
    expect(g({ orderMode: 'catalogue' })).toBe('none');
    expect(g({ orderMode: 'catalogue', requestStatus: 'pending', revealByMs: NOW + 1000 })).toBe('none');
    expect(g({ requestStatus: 'revealed' })).toBe('none');
    expect(g({ requestStatus: 'defaulted' })).toBe('none');
    expect(g({ requestStatus: null })).toBe('none');
    expect(g({ requestStatus: 'archived' })).toBe('none');
  });
});

describe('decideTick with the gate', () => {
  it('wait: no lot opens and the show does not end, but a due show still goes live', () => {
    expect(decideTick(base({ orderGate: 'wait' }))).toEqual([]);
    expect(decideTick(base({ orderGate: 'wait', openableLots: 0 }))).toEqual([]); // not even end_show
    expect(decideTick(base({ orderGate: 'wait', show: { status: 'scheduled', scheduledAt: NOW - 1 } }))).toEqual([{ type: 'go_live' }]);
  });

  it('wait does not hold back a lot that is already running: it still closes on time', () => {
    const acts = decideTick(base({ orderGate: 'wait', openLot: { id: 'L', closesAt: NOW - 1 } }));
    expect(acts).toEqual([{ type: 'close_lot', lotId: 'L' }]);
  });

  it('default: records the missed deadline, then opens the first lot in the same tick', () => {
    expect(decideTick(base({ orderGate: 'default' }))).toEqual([{ type: 'default_order' }, { type: 'open_next' }]);
    expect(decideTick(base({ orderGate: 'default', show: { status: 'scheduled', scheduledAt: NOW - 1 } }))).toEqual([{ type: 'go_live' }, { type: 'default_order' }, { type: 'open_next' }]);
  });

  it('default on a show that is not due yet does nothing (the draw is recorded when the show starts)', () => {
    expect(decideTick(base({ orderGate: 'default', show: { status: 'scheduled', scheduledAt: NOW + 60_000 } }))).toEqual([]);
  });

  it('none, or no gate at all (a catalogue show), is exactly the old tick', () => {
    for (const orderGate of [undefined, 'none' as const]) {
      expect(decideTick(base({ orderGate }))).toEqual([{ type: 'open_next' }]);
      expect(decideTick(base({ orderGate, openableLots: 0 }))).toEqual([{ type: 'end_show' }]);
      expect(decideTick(base({ orderGate, openLot: { id: 'L', closesAt: NOW - 10_000 }, lastClosedAt: NOW - 100_000 }))).toEqual([{ type: 'close_lot', lotId: 'L' }, { type: 'open_next' }]);
    }
  });

  it('is idempotent: once the draw is defaulted the gate is none and the tick has nothing left to record', () => {
    const afterDefault = decideTick(base({ orderGate: 'none', openLot: { id: 'L', closesAt: NOW + 5_000 } }));
    expect(afterDefault).toEqual([]);
  });
});
