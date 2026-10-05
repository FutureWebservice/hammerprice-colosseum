import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveSnapshot, ShowDetail } from '@/contracts';
import type { RoomLot } from '../types';
import {
  applyOptimistic, bidGate, buildRoomLots, countdownFraction, currentLotOf, feedFromEvents, nextBidOf, optimisticResolved, quickBidsOf, roomPhaseOf, visitorOf,
} from '../model';

const fx = <T,>(n: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../../../contracts/fixtures', `${n}.json`), 'utf8')) as T;
const catalogue = fx<ShowDetail>('show-detail');
const open = fx<LiveSnapshot>('live-snapshot.open');
const settled = fx<LiveSnapshot>('live-snapshot.settled');
const label = (n: number) => `Paddle ${n}`;
const t = (key: string, v: Record<string, string | number> = {}) => `${key}${Object.keys(v).length ? ':' + Object.values(v).join('|') : ''}`;

describe('buildRoomLots', () => {
  it('merges live state over catalogue terms and marks the viewer\'s own lead', () => {
    const lots = buildRoomLots(catalogue, open, label, 7);
    expect(lots[0]).toMatchObject({ id: catalogue.lots[0]!.id, state: 'open', highBid: '75000000', highBidder: 'Paddle 7', highBidderIsMe: true, bidCount: 2, reserve: '100000000' });
    expect(lots[1]).toMatchObject({ state: 'catalogued', highBid: null, highBidder: null, highBidderIsMe: false });
    expect(buildRoomLots(catalogue, open, label, 3)[0]!.highBidderIsMe).toBe(false);
    expect(buildRoomLots(catalogue, null, label, null).every((l) => l.state === 'catalogued')).toBe(true);
  });
  it('marks a sold lot a house bot holds, so the catalogue shows no payment due', () => {
    const sold = { ...open, lots: open.lots.map((l, i) => (i === 0 ? { ...l, state: 'sold' as const } : l)) };
    expect(buildRoomLots(catalogue, sold, label, null, (n) => n === 7)[0]!.houseWon).toBe(true);
    expect(buildRoomLots(catalogue, sold, label, null, (n) => n === 3)[0]!.houseWon).toBe(false);
    expect(buildRoomLots(catalogue, open, label, null, (n) => n === 7)[0]!.houseWon).toBe(false); // still open: not a win yet
  });
  it('never exposes a wallet: the only bidder field is the paddle label', () => {
    expect(Object.keys(buildRoomLots(catalogue, open, label, null)[0]!)).not.toContain('highBidderWallet');
  });
});

describe('phases and the lot on stage', () => {
  it('maps the server phase onto the room beat', () => {
    expect(roomPhaseOf('open')).toBe('open');
    expect(roomPhaseOf('going_once')).toBe('going-once');
    expect(roomPhaseOf('going_twice')).toBe('going-twice');
    expect(roomPhaseOf('hammered')).toBe('hammered');
    expect(roomPhaseOf('queued')).toBe('gap');
    expect(roomPhaseOf('settled')).toBe('hammered');
    expect(roomPhaseOf(undefined)).toBe('gap');
  });
  it('shows the current lot, else the next waiting one, else the last closed', () => {
    const lots = buildRoomLots(catalogue, open, label, null);
    expect(currentLotOf(lots, open, 'live')?.lotNumber).toBe(1);
    const between = { ...open, current: null };
    expect(currentLotOf(lots.map((l) => ({ ...l, state: l.lotNumber === 1 ? ('sold' as const) : l.state })), between, 'live')?.lotNumber).toBe(2);
    const ended = buildRoomLots(catalogue, settled, label, null);
    expect(currentLotOf(ended, settled, 'ended')?.lotNumber).toBe(1);
  });
});

describe('the viewer\'s standing', () => {
  const lots = buildRoomLots(catalogue, open, label, 7);
  it('leading, outbid, won, lost', () => {
    expect(visitorOf(lots[0]!, new Set())).toMatchObject({ status: 'leading', lastAmount: 75_000_000n });
    const other = buildRoomLots(catalogue, open, label, 3)[0]!;
    expect(visitorOf(other, new Set([other.id]))).toMatchObject({ status: 'outbid', outbidBy: { paddle: 'Paddle 7', amount: 75_000_000n } });
    expect(visitorOf(other, new Set()).status).toBe('idle'); // never bid on it
    const sold = { ...lots[0]!, state: 'sold' as const };
    expect(visitorOf(sold, new Set())).toMatchObject({ status: 'won', hammer: { toVisitor: true, amount: 75_000_000n } });
    expect(visitorOf({ ...other, state: 'sold' }, new Set([other.id])).status).toBe('lost');
    expect(visitorOf(null, new Set()).status).toBe('idle');
  });
  it('computes the next legal bid', () => {
    expect(nextBidOf(lots[0]!)).toBe(80_000_000n);
    expect(nextBidOf({ ...lots[0]!, highBid: null })).toBe(50_000_000n);
    expect(nextBidOf(lots[1]!)).toBeNull();
    expect(nextBidOf(null)).toBeNull();
  });
});

describe('optimistic bid', () => {
  const lots = buildRoomLots(catalogue, open, label, 3);
  it('shows the new high bid at once, then yields to the server', () => {
    const o = { lotId: lots[0]!.id, amount: 80_000_000n };
    const shown = applyOptimistic(lots, o, 'Paddle 3');
    expect(shown[0]).toMatchObject({ highBid: '80000000', highBidder: 'Paddle 3', highBidderIsMe: true });
    expect(optimisticResolved(lots, o)).toBe(false);
    // the server caught up with a higher bid by someone else
    const overtaken = lots.map((l, i) => (i === 0 ? { ...l, highBid: '85000000' } : l));
    expect(applyOptimistic(overtaken, o, 'Paddle 3')[0]!.highBid).toBe('85000000');
    expect(optimisticResolved(overtaken, o)).toBe(true);
    expect(optimisticResolved(lots.map((l, i) => (i === 0 ? { ...l, state: 'sold' as const } : l)), o)).toBe(true);
    expect(applyOptimistic(lots, null, 'x')).toBe(lots);
  });
});

describe('bidGate', () => {
  const base = { lotOpen: true, connected: true, signedIn: true, hasPaddle: true, leading: false };
  it('gives one path in: connect, sign in, register, bid', () => {
    expect(bidGate({ ...base, lotOpen: false })).toBe('no_lot');
    expect(bidGate({ ...base, connected: false, signedIn: false, hasPaddle: false })).toBe('connect');
    expect(bidGate({ ...base, signedIn: false, hasPaddle: false })).toBe('sign_in');
    expect(bidGate({ ...base, hasPaddle: false })).toBe('register');
    expect(bidGate(base)).toBe('ready');
    expect(bidGate({ ...base, leading: true })).toBe('leading');
  });
});

describe('feedFromEvents', () => {
  it('draws paddle numbers only, newest first, and skips unknown kinds', () => {
    const feed = feedFromEvents([...open.events, { id: 200, kind: 'lot_opened', at: '2026-10-05T18:00:00.000Z', payload: { junk: true } }], { label, myPaddle: 7, t });
    expect(feed.map((f) => f.key)).toEqual(['ev-103', 'ev-102', 'ev-101']);
    expect(feed[0]).toMatchObject({ kind: 'bid', who: 'Paddle 7', mine: true, amount: '75000000', lotNumber: 1 });
    expect(feed[1]).toMatchObject({ who: 'Paddle 3', mine: false });
    expect(feed[2]).toMatchObject({ kind: 'opened' });
    expect(JSON.stringify(feed)).not.toMatch(/wallet/i);
  });
  it('narrates the hammer, the settlement and the end of the show', () => {
    const feed = feedFromEvents(
      [
        { id: 1, kind: 'lot.sold', at: '2026-10-05T18:00:56.000Z', payload: { lotId: catalogue.lots[0]!.id, lotNumber: 1, highBid: '120000000', paddle: 7 } },
        { id: 2, kind: 'settlement.settled', at: '2026-10-05T18:01:20.000Z', payload: settled.events[0]!.payload },
        { id: 3, kind: 'show.ended', at: '2026-10-05T18:01:21.000Z', payload: {} },
        { id: 4, kind: 'lot.extended', at: '2026-10-05T18:01:22.000Z', payload: { lotId: catalogue.lots[0]!.id, lotNumber: 1, closesAt: '2026-10-05T18:02:00.000Z' } },
      ],
      { label, myPaddle: null, t },
    );
    expect(feed.map((f) => f.kind)).toEqual(['note', 'note', 'note', 'sold']);
    expect(feed[3]!.text).toContain('Paddle 7');
    expect(feedFromEvents([{ id: 1, kind: 'lot.sold', at: '2026-10-05T18:00:56.000Z', payload: { lotId: catalogue.lots[0]!.id, lotNumber: 1, highBid: '1', paddle: 7 } }], { label, myPaddle: 7, t })[0]!.text).toContain('feed.buyerYou');
  });
});

describe('feedFromEvents: expired settlements', () => {
  const lotId = catalogue.lots[0]!.id;
  const sold = (paddle: number) => ({ id: 1, kind: 'lot.sold' as const, at: '2026-10-05T18:00:56.000Z', payload: { lotId, lotNumber: 1, highBid: '1', paddle } });
  const expired = { id: 2, kind: 'settlement.expired' as const, at: '2026-10-05T18:00:57.000Z', payload: { lotId, lotNumber: 1, settlementId: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' } };
  const house = (n: number) => n <= 3;

  it('says a house bot won, not "payment did not go through", when a house bidder holds the hammer', () => {
    const feed = feedFromEvents([sold(2), expired], { label, myPaddle: null, t, isHouseBidder: house });
    expect(feed[0]!.text).toContain('feed.houseWon');
    expect(feed.some((f) => f.text?.includes('feed.notCompleted'))).toBe(false);
    expect(feed.some((f) => f.text?.includes('feed.hammered'))).toBe(false); // no "sold to House bot" next to "no sale"
    expect(feed).toHaveLength(1);
  });
  it('keeps the real "not completed" wording for a person who did not pay', () => {
    expect(feedFromEvents([sold(5), expired], { label, myPaddle: null, t, isHouseBidder: house })[0]!.text).toContain('feed.notCompleted');
    expect(feedFromEvents([sold(2), expired], { label, myPaddle: null, t })[0]!.text).toContain('feed.notCompleted');
  });
});

describe('countdownFraction', () => {
  it('fills by remaining time against the largest window seen', () => {
    expect(countdownFraction(10_000, 40_000)).toBe(0.25);
    expect(countdownFraction(50_000, 40_000)).toBe(1);
    expect(countdownFraction(-1, 40_000)).toBe(0);
    expect(countdownFraction(null, 40_000)).toBe(0);
    expect(countdownFraction(5, 0)).toBe(0);
  });
});

describe('the seller\'s pause in the room model', () => {
  const base = { lotOpen: true, connected: true, signedIn: true, hasPaddle: true, leading: false };
  it('a paused room has its own gate, but a room with no lot on the block stays "no lot"', () => {
    expect(bidGate({ ...base, paused: true })).toBe('paused');
    expect(bidGate({ ...base, paused: false })).toBe('ready');
    expect(bidGate({ ...base, lotOpen: false, paused: true })).toBe('no_lot');
  });
  it('narrates the pause and the resume in the feed, public and in the same words for everyone', () => {
    const lotId = catalogue.lots[0]!.id;
    const feed = feedFromEvents(
      [
        { id: 1, kind: 'show.paused', at: '2026-10-05T18:00:30.000Z', payload: { lotId, lotNumber: 1, resumesBy: '2026-10-05T18:05:30.000Z', msLeft: 15000, count: 1, max: 2 } },
        { id: 2, kind: 'show.resumed', at: '2026-10-05T18:01:00.000Z', payload: { lotId, lotNumber: 1, closesAt: '2026-10-05T18:01:15.000Z', shiftedMs: 30000, auto: false } },
        { id: 3, kind: 'show.resumed', at: '2026-10-05T18:07:00.000Z', payload: { lotId: null, lotNumber: null, closesAt: null, shiftedMs: 300000, auto: true } },
        { id: 4, kind: 'show.paused', at: '2026-10-05T18:08:00.000Z', payload: { junk: true } }, // a row that does not match the contract is not drawn
      ],
      { label, myPaddle: null, t },
    );
    expect(feed.map((f) => f.text)).toEqual(['feed.resumedAuto', 'feed.resumed', 'feed.paused:1|2']);
    expect(feed.every((f) => f.kind === 'note')).toBe(true);
    expect(feed[2]).toMatchObject({ lotNumber: 1 });
    expect(feed[0]).not.toHaveProperty('lotNumber');
  });
});

describe('quick raises', () => {
  it('are the next bid plus 1, 2 and 5 raise steps, all legal bids', () => {
    const lot = { increment: '10000000' } as unknown as RoomLot;
    expect(quickBidsOf(lot, 230_000_000n)).toEqual([240_000_000n, 250_000_000n, 280_000_000n]);
  });
});
