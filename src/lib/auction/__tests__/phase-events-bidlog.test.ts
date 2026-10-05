import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { lotPhase, msToNextOpen } from '../phase';
import { resolveRules, RULE_DEFAULTS } from '../rules';
import { mergeEvents, mergeSnapshot, normalizeKind, publicPayload } from '../events';
import { bidLogHash, bidLogPreimage } from '../bidlog';
import type { LiveSnapshot } from '@/contracts/api';
import type { SnapshotEvent } from '@/contracts/events';

const R = RULE_DEFAULTS; // callOnce 10, callTwice 5, gap 6
const T = 1_000_000;
const open = (closesAt: number | null, now: number) => lotPhase({ state: 'open', closesAt, closedAt: null, now, rules: R });

describe('lotPhase', () => {
  it('queued, passed, withdrawn are as stored', () => {
    expect(lotPhase({ state: 'catalogued', closesAt: null, closedAt: null, now: T, rules: R })).toBe('queued');
    expect(lotPhase({ state: 'passed', closesAt: T, closedAt: T, now: T + 99_000, rules: R })).toBe('passed');
    expect(lotPhase({ state: 'withdrawn', closesAt: null, closedAt: T, now: T, rules: R })).toBe('withdrawn');
  });
  it('exact thresholds at 10.000 s, 5.000 s and 0', () => {
    expect(open(T, T - 10_001)).toBe('open');
    expect(open(T, T - 10_000)).toBe('going_once');
    expect(open(T, T - 5_001)).toBe('going_once');
    expect(open(T, T - 5_000)).toBe('going_twice');
    expect(open(T, T - 1)).toBe('going_twice');
    expect(open(T, T)).toBe('hammered');
    expect(open(T, T + 500)).toBe('hammered');
  });
  it('an open lot that is not timed stays open forever', () => {
    expect(open(null, T)).toBe('open');
    expect(open(null, T * 1000)).toBe('open');
  });
  it('sold shows the stamp for gapS, then the settlement overlay', () => {
    const sold = (now: number, status?: 'awaiting_payment' | 'awaiting_seller' | 'submitted' | 'settled' | 'expired' | 'failed') =>
      lotPhase({ state: 'sold', closesAt: T, closedAt: T, now, rules: R, settlement: status ? { status } : null });
    expect(sold(T + 5_999, 'awaiting_payment')).toBe('hammered');
    expect(sold(T + 6_000, 'awaiting_payment')).toBe('sold_awaiting_payment');
    expect(sold(T + 6_000, 'awaiting_seller')).toBe('sold_awaiting_payment');
    expect(sold(T + 9_000, 'submitted')).toBe('sold_paying');
    expect(sold(T + 9_000, 'settled')).toBe('settled');
    expect(sold(T + 9_000, 'expired')).toBe('lapsed');
    expect(sold(T + 9_000, 'failed')).toBe('lapsed');
    expect(sold(T + 9_000)).toBe('hammered'); // legacy row, nothing to settle
  });
  it('gapS = 0 has no stamp window', () => {
    const rules = resolveRules({ gapS: 0 });
    expect(lotPhase({ state: 'sold', closesAt: T, closedAt: T, now: T, rules, settlement: { status: 'settled' } })).toBe('settled');
  });
  it('the phase of an open lot only moves forward as time passes (property)', () => {
    const order = ['open', 'going_once', 'going_twice', 'hammered'];
    fc.assert(fc.property(fc.integer({ min: 10, max: 120 }), fc.integer({ min: 1, max: 60 }), fc.integer({ min: 1, max: 60 }), fc.array(fc.integer({ min: 0, max: 200_000 }), { minLength: 2, maxLength: 20 }), (dur, once, twice, offsets) => {
      const rules = resolveRules({ lotDurationS: dur, callOnceS: once, callTwiceS: twice });
      const closesAt = 1_000_000 + dur * 1000;
      const phases = offsets.sort((a, b) => a - b).map((o) => lotPhase({ state: 'open', closesAt, closedAt: null, now: 1_000_000 + o, rules }));
      const idx = phases.map((p) => order.indexOf(p));
      expect(idx.every((v, n) => n === 0 || v >= idx[n - 1])).toBe(true);
    }));
  });
});

describe('msToNextOpen', () => {
  it('counts down the gap and stops at 0', () => {
    expect(msToNextOpen({ lastClosedAt: T, now: T + 1_000, rules: R })).toBe(5_000);
    expect(msToNextOpen({ lastClosedAt: T, now: T + 6_000, rules: R })).toBe(0);
    expect(msToNextOpen({ lastClosedAt: T, now: T + 99_000, rules: R })).toBe(0);
    expect(msToNextOpen({ lastClosedAt: null, now: T, rules: R })).toBe(0);
  });
});

describe('normalizeKind', () => {
  it.each([
    ['lot_opened', 'lot.opened'], ['lot_sold', 'lot.sold'], ['lot_passed', 'lot.passed'], ['lot_withdrawn', 'lot.withdrawn'],
    ['demo_reset', 'demo.reset'], ['show_live', 'show.live'], ['bid_placed', 'bid.placed'], ['settlement_settled', 'settlement.settled'],
    ['bid.placed', 'bid.placed'], ['lot.extended', 'lot.extended'], ['mystery_thing', 'mystery_thing'], ['', ''], ['_x', '_x'],
  ])('%s -> %s', (a, b) => expect(normalizeKind(a)).toBe(b));
  it('is idempotent (property)', () => { fc.assert(fc.property(fc.string(), (k) => { expect(normalizeKind(normalizeKind(k))).toBe(normalizeKind(k)); })); });
});

describe('publicPayload', () => {
  it('drops wallet and bidder keys that legacy bid events carried', () => {
    expect(publicPayload({ lotId: 'a', amount: '5', walletAddress: 'W', bidderId: 'B', paddle: 3 })).toEqual({ lotId: 'a', amount: '5', paddle: 3 });
    expect(publicPayload(null)).toEqual({});
    expect(publicPayload([1, 2])).toEqual({});
  });
});

const snap = (lastEventId: number, serverNow: number): LiveSnapshot => ({
  v: 1, serverNow, lastEventId, events: [], lots: [], current: null,
  show: { id: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10', title: 't', status: 'live', mode: 'auto', scheduledAt: null, settlementMode: 'onchain', cluster: 'devnet', isHouse: false, kind: 'live', order: { mode: 'catalogue' }, video: { enabled: false }, pause: { paused: false, pausedAt: null, resumesBy: null, used: 0, max: 2 } },
});
describe('mergeSnapshot', () => {
  it('takes the first snapshot and ignores older ones', () => {
    const a = snap(5, 1000);
    expect(mergeSnapshot(null, a)).toBe(a);
    expect(mergeSnapshot(a, snap(4, 1100))).toBe(a);
    expect(mergeSnapshot(a, snap(6, 900))).toBe(a);
  });
  it('accepts equal and newer, and out-of-order arrival settles on the newest', () => {
    const a = snap(5, 1000); const b = snap(5, 1000); const c = snap(7, 2000);
    expect(mergeSnapshot(a, b)).toBe(b);
    let cur: LiveSnapshot | null = null;
    for (const s of [c, a, snap(6, 1500), b]) cur = mergeSnapshot(cur, s);
    expect(cur).toBe(c);
  });
});

describe('mergeEvents', () => {
  const ev = (id: number): SnapshotEvent => ({ id, kind: 'bid.placed', at: '2026-10-05T18:00:00.000Z', payload: {} });
  it('dedupes by id, not by array length, with 450 events (C5 regression)', () => {
    const all = Array.from({ length: 450 }, (_, i) => ev(i + 1));
    let feed: SnapshotEvent[] = [];
    for (let i = 0; i < 450; i += 40) feed = mergeEvents(feed, all.slice(Math.max(0, i - 10), i + 40), 1000);
    expect(feed).toHaveLength(450);
    expect(feed.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(mergeEvents(feed, [ev(450), ev(3)], 1000)).toHaveLength(450);
  });
  it('keeps the newest cap events, ascending', () => {
    const r = mergeEvents([ev(1), ev(2)], [ev(5), ev(3), ev(4)], 3);
    expect(r.map((e) => e.id)).toEqual([3, 4, 5]);
  });
});

describe('bidLogHash', () => {
  const bid = (id: string, placedAt: number, m = 'msg-' + id, s = 'sig-' + id) => ({ id, message: m, signature: s, placedAt });
  it('is sha-256 over "<message>|<signature>" lines joined by newline', () => {
    const bids = [bid('a', 1), bid('b', 2)];
    expect(bidLogPreimage(bids)).toBe('msg-a|sig-a\nmsg-b|sig-b');
    expect(bidLogHash(bids)).toBe(createHash('sha256').update('msg-a|sig-a\nmsg-b|sig-b').digest('hex'));
  });
  it('orders by (placed_at, id), whatever the input order, and accepts Date, ISO and ms', () => {
    const a = bid('a', 10); const b = bid('b', 10); const c = { ...bid('c', 5), placedAt: new Date(5) };
    const expected = bidLogHash([c, a, b]);
    expect(bidLogHash([b, a, c])).toBe(expected);
    expect(bidLogHash([{ ...c, placedAt: new Date(5).toISOString() }, a, b])).toBe(expected);
    expect(bidLogPreimage([b, a, c])).toBe('msg-c|sig-c\nmsg-a|sig-a\nmsg-b|sig-b');
  });
  it('an empty log hashes the empty string and any change changes the hash', () => {
    expect(bidLogHash([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bidLogHash([bid('a', 1, 'm', 's')])).not.toBe(bidLogHash([bid('a', 1, 'm', 's2')]));
  });
});
