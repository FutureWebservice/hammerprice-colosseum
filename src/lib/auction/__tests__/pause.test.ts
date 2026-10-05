/** The seller's pause, pure: the clock math, the limits, the frozen tick, bid refusal and the anti-sniping cap. */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decideBid, decidePause, decideTick, extendedClosesAt, nextClosesAt, pauseExpired, pauseExpiresAt, resumeShift, type DecideBidInput } from '../engine';
import { PAUSE_MAX_COUNT, PAUSE_MAX_MS, PAUSE_MIN_LEFT_MS, RULE_DEFAULTS } from '../rules';
import { lotPhase } from '../phase';
import { NO_PAUSE } from '@/contracts/api';

const R = RULE_DEFAULTS; // 45 s lots, snipe window 15 s, extend 15 s, max extension 120 s
const T = 1_700_000_000_000;

describe('limits', () => {
  it('are the documented ones', () => {
    expect(PAUSE_MAX_COUNT).toBe(2);
    expect(PAUSE_MAX_MS).toBe(300_000);
    expect(PAUSE_MIN_LEFT_MS).toBe(10_000);
  });
});

describe('the contract default agrees with the rules', () => {
  it('a snapshot without a pause says "not paused, none used, the maximum of the rules"', () => {
    expect(NO_PAUSE).toEqual({ paused: false, pausedAt: null, resumesBy: null, used: 0, max: PAUSE_MAX_COUNT });
  });
});

describe('resumeShift', () => {
  it('a resume now shifts by the paused time', () => {
    expect(resumeShift({ pausedAt: T, now: T + 90_000 })).toEqual({ resumedAt: T + 90_000, shiftMs: 90_000 });
    expect(resumeShift({ pausedAt: T, now: T })).toEqual({ resumedAt: T, shiftMs: 0 });
  });
  it('counts a pause as at most its limit long, however late the resume is noticed', () => {
    expect(resumeShift({ pausedAt: T, now: T + PAUSE_MAX_MS })).toEqual({ resumedAt: T + PAUSE_MAX_MS, shiftMs: PAUSE_MAX_MS });
    expect(resumeShift({ pausedAt: T, now: T + 3_600_000 })).toEqual({ resumedAt: T + PAUSE_MAX_MS, shiftMs: PAUSE_MAX_MS });
  });
  it('never shifts backwards (a clock that reads earlier than the pause shifts nothing)', () => {
    expect(resumeShift({ pausedAt: T, now: T - 5_000 })).toEqual({ resumedAt: T, shiftMs: 0 });
  });
  it('property: shift is within [0, limit], resumedAt = pausedAt + shift, and the lot always gets back exactly the time it had', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 3_600_000 }), fc.integer({ min: 0, max: 7_200_000 }), fc.integer({ min: 10_000, max: 3_600_000 }), (pausedFor, extra, left) => {
      const pausedAt = T;
      const closesAt = pausedAt + left;
      const { resumedAt, shiftMs } = resumeShift({ pausedAt, now: pausedAt + pausedFor + extra });
      expect(shiftMs).toBeGreaterThanOrEqual(0);
      expect(shiftMs).toBeLessThanOrEqual(PAUSE_MAX_MS);
      expect(resumedAt).toBe(pausedAt + shiftMs);
      expect(closesAt + shiftMs - resumedAt).toBe(left); // time left at resume == time left at pause
    }));
  });
  it('expiry is exactly pausedAt + 5 minutes', () => {
    expect(pauseExpiresAt(T)).toBe(T + 300_000);
    expect(pauseExpired(T, T + 299_999)).toBe(false);
    expect(pauseExpired(T, T + 300_000)).toBe(true);
  });
});

describe('decidePause', () => {
  const base = { status: 'live' as const, kind: 'live' as const, pausedAt: null, pauseCount: 0, openLot: { closesAt: T + 60_000 }, now: T };
  it('accepts a live room with a lot that has time left, and reports what the event needs', () => {
    expect(decidePause(base)).toEqual({ ok: true, msLeft: 60_000, resumesBy: T + PAUSE_MAX_MS, count: 1 });
    expect(decidePause({ ...base, pauseCount: 1 })).toMatchObject({ ok: true, count: 2 });
  });
  it('refuses a third pause, and a pause inside the last 10 seconds (exactly 10 s is allowed)', () => {
    expect(decidePause({ ...base, pauseCount: 2 })).toMatchObject({ ok: false, code: 'pause_limit' });
    expect(decidePause({ ...base, openLot: { closesAt: T + 9_999 } })).toMatchObject({ ok: false, code: 'pause_too_late' });
    expect(decidePause({ ...base, openLot: { closesAt: T + 10_000 } })).toMatchObject({ ok: true });
    expect(decidePause({ ...base, openLot: { closesAt: T - 1 } })).toMatchObject({ ok: false, code: 'pause_too_late' });
  });
  it('refuses when already paused, with no lot on the block, for a timed show and outside a live show', () => {
    expect(decidePause({ ...base, pausedAt: T - 1000 })).toMatchObject({ ok: false, code: 'show_paused' });
    expect(decidePause({ ...base, openLot: null })).toMatchObject({ ok: false, code: 'lot_not_open' });
    expect(decidePause({ ...base, openLot: { closesAt: null } })).toMatchObject({ ok: false, code: 'lot_not_open' });
    expect(decidePause({ ...base, kind: 'timed' })).toMatchObject({ ok: false, code: 'wrong_state' });
    expect(decidePause({ ...base, status: 'scheduled' })).toMatchObject({ ok: false, code: 'wrong_state' });
    expect(decidePause({ ...base, status: 'ended' })).toMatchObject({ ok: false, code: 'wrong_state' });
  });
  it('a stall cannot add up beyond 2 x 5 minutes: the limits bound the total', () => {
    expect(PAUSE_MAX_COUNT * PAUSE_MAX_MS).toBe(600_000);
  });
});

describe('decideTick on a paused show', () => {
  const show = { status: 'live' as const, scheduledAt: null, rules: R };
  const input = (over: Record<string, unknown>) => ({ now: T, show, openLot: { id: 'lot', closesAt: T - 120_000 }, openableLots: 1, lastClosedAt: null, ...over }) as Parameters<typeof decideTick>[0];

  it('does nothing while the pause holds, even with the deadline long past and the next lot ready', () => {
    expect(decideTick(input({ show: { ...show, pausedAt: T - 60_000 } }))).toEqual([]);
    expect(decideTick(input({ show: { ...show, pausedAt: T - PAUSE_MAX_MS + 1 } }))).toEqual([]);
  });
  it('resumes first when the limit has passed, then judges the lot on its shifted deadline', () => {
    // paused 6 min ago; the stored deadline is pausedAt + (time left at the pause). Shifted by the 5 minute limit it is judged against now.
    const pausedAt = T - 6 * 60_000;
    const stillRunning = decideTick(input({ show: { ...show, pausedAt }, openLot: { id: 'lot', closesAt: pausedAt + 90_000 } })); // 90 s left at the pause: 30 s left now
    expect(stillRunning.map((a) => a.type)).toEqual(['resume']);
    const over = decideTick(input({ show: { ...show, pausedAt }, openLot: { id: 'lot', closesAt: pausedAt + 30_000 } }));
    expect(over.map((a) => a.type)).toEqual(['resume', 'close_lot', 'open_next']); // pausedAt + 30 s + 5 min is before now: it closed on its shifted deadline
  });
  it('a show that is not paused ticks exactly as before', () => {
    expect(decideTick(input({ show: { ...show, pausedAt: null } })).map((a) => a.type)).toEqual(['close_lot', 'open_next']);
    expect(decideTick(input({})).map((a) => a.type)).toEqual(['close_lot', 'open_next']);
  });
  it('is idempotent: after the resume is applied the same input without pausedAt has nothing more to say about the pause', () => {
    const pausedAt = T - 6 * 60_000;
    const acts = decideTick(input({ show: { ...show, pausedAt }, openLot: { id: 'lot', closesAt: pausedAt + 30_000 } }));
    expect(acts.filter((a) => a.type === 'resume')).toHaveLength(1);
    expect(decideTick(input({ show: { ...show, pausedAt: null }, openLot: null, openableLots: 0, lastClosedAt: T - 100_000 })).map((a) => a.type)).toEqual(['end_show']);
  });
});

describe('decideBid in a paused room', () => {
  const bid = (over: Partial<DecideBidInput['show']> & { closesAt?: number } = {}): DecideBidInput => ({
    lot: { state: 'open', highBid: null, highBidderId: null, openingPrice: 50n, increment: 5n, reserve: null, closesAt: over.closesAt ?? T + 30_000, openedAt: T - 15_000, sellerProfileId: 's', sellerWallet: 'sw' },
    show: { status: 'live', rules: R, isHouse: false, sellerProfileId: 's', sellerWallet: 'sw', pausedAt: over.pausedAt ?? null },
    bidder: { profileId: 'b', wallet: 'bw', isBanned: false, isBot: false },
    paddle: { number: 1, validUntil: T + 3_600_000, revoked: false, maxBid: null },
    via: 'wallet', amount: 50n, nowMs: T, available: 1000n,
  });
  it('refuses with show_paused, and a deadline that has passed on the frozen clock is not "closed"', () => {
    expect(decideBid(bid({ pausedAt: T - 1000 }))).toMatchObject({ ok: false, code: 'show_paused' });
    expect(decideBid(bid({ pausedAt: T - 1000, closesAt: T - 50_000 }))).toMatchObject({ ok: false, code: 'show_paused' });
    expect(decideBid(bid({ closesAt: T - 50_000 }))).toMatchObject({ ok: false, code: 'lot_closed' });
  });
  it('accepts exactly as before when the room runs (pausedAt null or absent)', () => {
    expect(decideBid(bid({ pausedAt: null }))).toMatchObject({ ok: true });
    expect(decideBid(bid())).toMatchObject({ ok: true });
  });
  it('a paused room refuses house bidders and the seller\'s friends alike: the code does not depend on who bids', () => {
    const b = bid({ pausedAt: T - 1 });
    expect(decideBid({ ...b, bidder: { ...b.bidder, isBot: true } })).toMatchObject({ ok: false });
    expect(decideBid({ ...b, via: 'session' })).toMatchObject({ ok: false, code: 'show_paused' });
  });
});

describe('anti-sniping around a pause', () => {
  it('the cap counts from the lot\'s effective opening (opened + paused time): the same cap as without a pause, just later', () => {
    const openedAt = T;
    const pausedMs = 240_000;
    const closes = openedAt + pausedMs + 45_000;
    // 5 s before the shifted close, a bid lands: extends to now + 15 s, well inside the shifted cap
    const now = closes - 5_000;
    const withPause = nextClosesAt({ closesAt: closes, openedAt: openedAt + pausedMs, now, rules: R });
    const noPause = nextClosesAt({ closesAt: closes - pausedMs, openedAt, now: now - pausedMs, rules: R });
    expect(withPause.closesAt - pausedMs).toBe(noPause.closesAt); // identical behaviour, shifted by the paused time
    expect(withPause.extended).toBe(true);
  });
  it('without the paused time in openedAt the cap would sit in the past and silently switch anti-sniping off (the bug this guards against)', () => {
    const openedAt = T;
    const pausedMs = 240_000;
    const closes = openedAt + pausedMs + 45_000;
    const broken = nextClosesAt({ closesAt: closes, openedAt, now: closes - 5_000, rules: R });
    expect(broken.extended).toBe(false);
  });
  it('a seller extend after a pause is capped the same way', () => {
    const openedAt = T + 200_000;
    expect(extendedClosesAt({ closesAt: openedAt + 160_000, openedAt, seconds: 30, rules: R })).toBe(openedAt + 165_000);
  });
  it('a paused lot keeps its call: the phase is drawn at the moment of the pause', () => {
    const closesAt = T + 8_000;
    expect(lotPhase({ state: 'open', closesAt, closedAt: null, now: T, rules: R })).toBe('going_once');
    // 2 minutes later the stored deadline is in the past; drawn at the pause moment it is still "going once", never "hammered"
    expect(lotPhase({ state: 'open', closesAt, closedAt: null, now: T + 120_000, rules: R })).toBe('hammered');
    expect(lotPhase({ state: 'open', closesAt, closedAt: null, now: T, rules: R })).toBe('going_once');
  });
});
