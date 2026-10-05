/**
 * Timed shows, the pure half: the clamp table per kind, the test-only minimum duration (both clusters), the anti-sniping clock over hours and
 * days (property tests), the tick for a one-lot timed show, and the phase display. The live clamp table itself is pinned by
 * live-clamp-regression.test.ts.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decideTick, extendedClosesAt, nextClosesAt, type TickInput } from '../engine';
import { lotPhase, timedDisplay, TIMED_CALL_THEATER_MS } from '../phase';
import { RULE_DEFAULTS, TIMED_MAX_DURATION_S, TIMED_MIN_DURATION_S, TIMED_RULE_DEFAULTS, maxSellerExtendS, resolveRules, timedMinDurationS, type AuctionRules } from '../rules';
import { DEVNET_ENV, MAINNET_ENV } from '@/lib/__tests__/fixtures/envs';

const T = 1_700_000_000_000;
const DAY = 86_400;
const NO_ENV = {};
const timed = (raw: unknown, env: Record<string, string | undefined> = NO_ENV) => resolveRules(raw, RULE_DEFAULTS, 'timed', env);

describe('the timed clamp table', () => {
  it('defaults: one day, a 5 minute call and soft close, no gap, three days to sign', () => {
    expect(timed({})).toEqual({ lotDurationS: 86_400, callOnceS: 300, callTwiceS: 60, snipeWindowS: 300, snipeExtendS: 300, maxExtensionS: 86_400, gapS: 0, settlementWindowS: 259_200 });
    expect(timed({})).toEqual(TIMED_RULE_DEFAULTS);
  });

  it('ignores the live defaults it is handed (a timed show never inherits the live 45 s)', () => {
    expect(resolveRules({}, { ...RULE_DEFAULTS, lotDurationS: 99, settlementWindowS: 61 }, 'timed', NO_ENV)).toEqual(TIMED_RULE_DEFAULTS);
  });

  it('upper clamps', () => {
    expect(timed({ lotDurationS: 1e12, snipeWindowS: 1e12, snipeExtendS: 1e12, maxExtensionS: 1e12, gapS: 1e12, settlementWindowS: 1e12, callOnceS: 1e12, callTwiceS: 1e12 }))
      .toEqual({ lotDurationS: 1_209_600, callOnceS: 1_209_600, callTwiceS: 1_209_600, snipeWindowS: 3600, snipeExtendS: 3600, maxExtensionS: 604_800, gapS: 600, settlementWindowS: 604_800 });
  });

  it('lower clamps: a lot runs at least 10 minutes', () => {
    expect(timed({ lotDurationS: 1, snipeExtendS: -5, maxExtensionS: -5, gapS: -5, settlementWindowS: 1, callOnceS: -5, callTwiceS: -5, snipeWindowS: -5 }))
      .toEqual({ lotDurationS: 600, callOnceS: 1, callTwiceS: 1, snipeWindowS: 0, snipeExtendS: 0, maxExtensionS: 0, gapS: 0, settlementWindowS: 60 });
  });

  it('the UI presets (1 h, 6 h, 24 h, 3 d, 7 d) pass through unchanged', () => {
    for (const s of [3600, 6 * 3600, DAY, 3 * DAY, 7 * DAY]) expect(timed({ lotDurationS: s }).lotDurationS).toBe(s);
  });

  it('the call windows never exceed the lot, the snipe window never exceeds an hour or the lot', () => {
    const r = timed({ lotDurationS: 600, callOnceS: 5000, callTwiceS: 4000, snipeWindowS: 5000 });
    expect(r).toMatchObject({ callOnceS: 600, callTwiceS: 600, snipeWindowS: 600 });
    expect(timed({ lotDurationS: 7 * DAY, snipeWindowS: 5000 }).snipeWindowS).toBe(3600);
  });

  it('non-numbers and non-objects fall back to the timed defaults; idempotent', () => {
    for (const raw of [null, undefined, 'x', 7, [], { lotDurationS: NaN, snipeExtendS: 'x', gapS: Infinity }]) expect(timed(raw).lotDurationS).toBe(86_400);
    fc.assert(fc.property(fc.record({ lotDurationS: fc.integer({ min: -10, max: 3e6 }), callOnceS: fc.integer({ min: -10, max: 3e6 }), snipeWindowS: fc.integer({ min: -10, max: 9000 }), snipeExtendS: fc.integer({ min: -10, max: 9000 }), maxExtensionS: fc.integer({ min: -10, max: 1e6 }) }), (raw) => {
      const once = timed(raw);
      expect(timed(once)).toEqual(once);
      expect(once.lotDurationS).toBeGreaterThanOrEqual(600);
      expect(once.lotDurationS).toBeLessThanOrEqual(TIMED_MAX_DURATION_S);
      expect(once.callTwiceS).toBeLessThanOrEqual(once.callOnceS);
      expect(once.callOnceS).toBeLessThanOrEqual(once.lotDurationS);
    }));
  });

  it('a live show clamps as before while a timed show with the same raw rules does not', () => {
    const raw = { lotDurationS: DAY, maxExtensionS: DAY, snipeExtendS: 900 };
    expect(resolveRules(raw, RULE_DEFAULTS, 'live')).toMatchObject({ lotDurationS: 3600, maxExtensionS: 600, snipeExtendS: 600 });
    expect(timed(raw)).toMatchObject({ lotDurationS: DAY, maxExtensionS: DAY, snipeExtendS: 900 });
  });

  it('a seller may extend by at most 10 minutes live and 1 hour timed', () => {
    expect(maxSellerExtendS('live')).toBe(600);
    expect(maxSellerExtendS('timed')).toBe(3600);
  });
});

describe('TIMED_MIN_DURATION_S (test environments only)', () => {
  const dev = (v: string | undefined) => ({ ...DEVNET_ENV, ...(v === undefined ? {} : { TIMED_MIN_DURATION_S: v }) });
  const main = (v: string | undefined) => ({ ...MAINNET_ENV, ...(v === undefined ? {} : { TIMED_MIN_DURATION_S: v }) });

  it('lowers the minimum on devnet', () => {
    expect(timedMinDurationS(dev('20'))).toBe(20);
    expect(timed({ lotDurationS: 20 }, dev('20')).lotDurationS).toBe(20);
    expect(timed({ lotDurationS: 5 }, dev('20')).lotDurationS).toBe(20);
    expect(timedMinDurationS({})).toBe(600); // default cluster is devnet, variable unset
  });

  it('never has an effect on mainnet', () => {
    expect(timedMinDurationS(main('20'))).toBe(TIMED_MIN_DURATION_S);
    expect(timed({ lotDurationS: 20 }, main('20')).lotDurationS).toBe(600);
    expect(timedMinDurationS({ SOLANA_CLUSTER: 'mainnet-beta', TIMED_MIN_DURATION_S: '30' })).toBe(600);
  });

  it('an unresolvable cluster setting counts as mainnet', () => {
    expect(timedMinDurationS({ SOLANA_CLUSTER: 'devnet', NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta', TIMED_MIN_DURATION_S: '20' })).toBe(600);
    expect(timedMinDurationS({ SOLANA_CLUSTER: 'nonsense', TIMED_MIN_DURATION_S: '20' })).toBe(600);
  });

  it('ignores junk, values below 10 and values that are not a decrease', () => {
    for (const v of ['', ' ', 'x', '9', '0', '-5', '600', '601', '1e3', '20 # test', '12.5', '0020x']) expect(timedMinDurationS(dev(v)), v).toBe(600);
    expect(timedMinDurationS(dev(undefined))).toBe(600);
  });

  it('is irrelevant to a live show', () => {
    expect(resolveRules({ lotDurationS: 15 }, RULE_DEFAULTS, 'live', dev('20')).lotDurationS).toBe(15);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------

const rulesArb = fc.record({
  lotDurationS: fc.integer({ min: 600, max: TIMED_MAX_DURATION_S }),
  snipeWindowS: fc.integer({ min: 0, max: 3600 }),
  snipeExtendS: fc.integer({ min: 0, max: 3600 }),
  maxExtensionS: fc.integer({ min: 0, max: 604_800 }),
}).map((r) => timed(r));

describe('anti-sniping over long lots (property)', () => {
  it('never moves the close backwards and never past openedAt + duration + maxExtension', () => {
    fc.assert(fc.property(rulesArb, fc.integer({ min: 0, max: 1_000_000_000 }), fc.integer({ min: 1, max: 5_000_000 }), (rules: AuctionRules, openedAtOffset: number, sinceOpenS: number) => {
      const openedAt = T + openedAtOffset;
      const closesAt = openedAt + rules.lotDurationS * 1000;
      const now = Math.min(closesAt - 1, openedAt + sinceOpenS * 1000);
      const r = nextClosesAt({ closesAt, openedAt, now, rules });
      expect(r.closesAt).toBeGreaterThanOrEqual(closesAt);
      expect(r.closesAt).toBeLessThanOrEqual(Math.max(closesAt, openedAt + (rules.lotDurationS + rules.maxExtensionS) * 1000));
      expect(r.extended).toBe(r.closesAt > closesAt);
    }));
  });

  it('a long chain of bids in the last window stays under the cap and ends', () => {
    fc.assert(fc.property(rulesArb, fc.array(fc.integer({ min: 1, max: 600 }), { minLength: 1, maxLength: 400 }), (rules: AuctionRules, gaps: number[]) => {
      const openedAt = T;
      let closesAt = openedAt + rules.lotDurationS * 1000;
      const cap = openedAt + (rules.lotDurationS + rules.maxExtensionS) * 1000;
      let now = closesAt - rules.snipeWindowS * 1000;
      for (const g of gaps) {
        now += g * 1000;
        if (now >= closesAt) break;
        const r = nextClosesAt({ closesAt, openedAt, now, rules });
        expect(r.closesAt).toBeGreaterThanOrEqual(closesAt);
        closesAt = r.closesAt;
        expect(closesAt).toBeLessThanOrEqual(Math.max(cap, openedAt + rules.lotDurationS * 1000));
      }
    }));
  });

  it('default timed rules: a bid 4 minutes before the end moves the close to 5 minutes from now; a bid 6 minutes before does nothing', () => {
    const rules = timed({});
    const closesAt = T + DAY * 1000;
    expect(nextClosesAt({ closesAt, openedAt: T, now: closesAt - 240_000, rules })).toEqual({ closesAt: closesAt - 240_000 + 300_000, extended: true });
    expect(nextClosesAt({ closesAt, openedAt: T, now: closesAt - 360_000, rules })).toEqual({ closesAt, extended: false });
  });

  it('the extension total stops at the cap: after 24 h of extensions a late bid changes nothing', () => {
    const rules = timed({ lotDurationS: 3600, maxExtensionS: 3600, snipeExtendS: 1800 });
    const cap = T + 7200_000;
    expect(nextClosesAt({ closesAt: cap - 10_000, openedAt: T, now: cap - 20_000, rules })).toEqual({ closesAt: cap, extended: true });
    expect(nextClosesAt({ closesAt: cap, openedAt: T, now: cap - 20_000, rules })).toEqual({ closesAt: cap, extended: false });
  });

  it('a seller extend of up to an hour is bounded by the same cap and never backwards', () => {
    const rules = timed({ lotDurationS: 3600, maxExtensionS: 1800 });
    const closesAt = T + 3600_000;
    expect(extendedClosesAt({ closesAt, openedAt: T, seconds: 3600, rules })).toBe(T + 3600_000 + 1800_000);
    expect(extendedClosesAt({ closesAt, openedAt: T, seconds: 600, rules })).toBe(closesAt + 600_000);
    expect(extendedClosesAt({ closesAt: closesAt + 1800_000, openedAt: T, seconds: 600, rules })).toBe(closesAt + 1800_000);
  });
});

describe('decideTick for a one-lot timed show', () => {
  const rules = timed({});
  const show = (over: Partial<TickInput['show']> = {}): TickInput['show'] => ({ status: 'live', scheduledAt: null, rules, ...over });

  it('scheduled: nothing before the start, go_live then open_next at the start', () => {
    expect(decideTick({ now: T, show: show({ status: 'scheduled', scheduledAt: T + 1000 }), openLot: null, openableLots: 1, lastClosedAt: null })).toEqual([]);
    expect(decideTick({ now: T, show: show({ status: 'scheduled', scheduledAt: T }), openLot: null, openableLots: 1, lastClosedAt: null })).toEqual([{ type: 'go_live' }, { type: 'open_next' }]);
  });

  it('live with the lot open and the deadline ahead: nothing to do for a day', () => {
    expect(decideTick({ now: T + 1000, show: show(), openLot: { id: 'l1', closesAt: T + DAY * 1000 }, openableLots: 0, lastClosedAt: null })).toEqual([]);
  });

  it('at the deadline: close the lot, and with no gap end the show in the same tick', () => {
    expect(decideTick({ now: T + DAY * 1000, show: show(), openLot: { id: 'l1', closesAt: T + DAY * 1000 }, openableLots: 0, lastClosedAt: null })).toEqual([{ type: 'close_lot', lotId: 'l1' }, { type: 'end_show' }]);
  });

  it('a late reader (hours after the deadline) closes with the same actions; the close time stays the deadline', () => {
    const closesAt = T + DAY * 1000;
    expect(decideTick({ now: closesAt + 9 * 3600_000, show: show(), openLot: { id: 'l1', closesAt }, openableLots: 0, lastClosedAt: null })).toEqual([{ type: 'close_lot', lotId: 'l1' }, { type: 'end_show' }]);
  });

  it('after the end, the next tick is empty (idempotent)', () => {
    expect(decideTick({ now: T + 2 * DAY * 1000, show: show({ status: 'ended' }), openLot: null, openableLots: 0, lastClosedAt: T + DAY * 1000 })).toEqual([]);
  });
});

describe('phase on a timed lot', () => {
  const rules = timed({});
  const phaseAt = (leftS: number) => lotPhase({ state: 'open', closesAt: T + leftS * 1000, closedAt: null, now: T, rules });

  it('the server phase flips to going_once inside 5 minutes and going_twice inside 1 minute', () => {
    expect(phaseAt(3600)).toBe('open');
    expect(phaseAt(301)).toBe('open');
    expect(phaseAt(300)).toBe('going_once');
    expect(phaseAt(61)).toBe('going_once');
    expect(phaseAt(60)).toBe('going_twice');
    expect(phaseAt(0)).toBe('hammered');
  });

  it('timedDisplay: a timed show chants only in the last 10 seconds, a live show always shows its phase', () => {
    expect(timedDisplay('timed', 'going_once', 200_000)).toEqual({ phase: 'open', soon: true });
    expect(timedDisplay('timed', 'going-twice', TIMED_CALL_THEATER_MS + 1)).toEqual({ phase: 'open', soon: true });
    expect(timedDisplay('timed', 'going-twice', TIMED_CALL_THEATER_MS)).toEqual({ phase: 'going-twice', soon: false });
    expect(timedDisplay('timed', 'going_once', null)).toEqual({ phase: 'open', soon: true });
    expect(timedDisplay('timed', 'open', 200_000)).toEqual({ phase: 'open', soon: false });
    expect(timedDisplay('timed', 'hammered', 0)).toEqual({ phase: 'hammered', soon: false });
    expect(timedDisplay('live', 'going_once', 200_000)).toEqual({ phase: 'going_once', soon: false });
    expect(timedDisplay(undefined, 'going-once', 200_000)).toEqual({ phase: 'going-once', soon: false });
  });
});
