/**
 * House bidders on a timed lot (hours to days): the pacing follows the time left, the last bid is kept for the final 10 minutes, at most 4 bids,
 * a person is never outbid, the cap stays at 60 percent. Seeded random numbers, no clock, no database.
 */
import { describe, expect, it } from 'vitest';
import { nextClosesAt } from '@/lib/auction/engine';
import { resolveRules } from '@/lib/auction/rules';
import { botCap, decideBotBid, MAX_BOT_BIDS_PER_LOT, seededRng, TIMED_FINAL_WINDOW_MS, type BotInput, type BotLot } from '../bots';

const USDC = 1_000_000n;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const S = 1000;
const MIN = 60 * S;
const H = 3600 * S;

const lot = (over: Partial<BotLot> = {}): BotLot => ({
  state: 'open', closesAt: T0 + H, openedAt: T0, highBid: null, highBidderPaddle: null, bidCount: 0,
  openingPrice: 60n * USDC, increment: 6n * USDC, value: 1000n * USDC, ...over,
});
const input = (over: Partial<BotInput> = {}): BotInput => ({
  enabled: true, isHouseShow: true, timed: true, showLive: true, now: T0 + MIN, lot: lot(), lastBidAt: null, rng: seededRng('seed'), ...over,
});
const skipped = (i: BotInput) => { const d = decideBotBid(i); return 'skip' in d ? d.skip : null; };
const bids = (i: BotInput) => 'bid' in decideBotBid(i);

describe('timed pacing: 5 to 20 percent of the time left', () => {
  it('the first bid on a 1 hour lot comes 3 to 12 minutes after it opened, never earlier, always by 12 minutes', () => {
    for (let n = 0; n < 300; n++) {
      const rng = () => seededRng(`first-${n}`)();
      expect(skipped(input({ now: T0 + 170 * S, rng })), `seed ${n}`).toBe('waiting'); // 5 percent of 3600 s is 180 s
      expect(bids(input({ now: T0 + 12 * MIN, rng })), `seed ${n}`).toBe(true); // 20 percent is 720 s
    }
  });

  it('on a 24 hour lot the first bid comes 1.2 to 4.8 hours after it opened', () => {
    const closesAt = T0 + 24 * H;
    for (let n = 0; n < 100; n++) {
      const rng = () => seededRng(`day-${n}`)();
      expect(skipped(input({ now: T0 + 1.1 * H, rng, lot: lot({ closesAt }) }))).toBe('waiting');
      expect(bids(input({ now: T0 + 4.9 * H, rng, lot: lot({ closesAt }) }))).toBe(true);
    }
  });

  it('the wait is measured from the last bid, again 5 to 20 percent of what is left then', () => {
    const lastBidAt = T0 + 20 * MIN; // 40 minutes left, so 2 to 8 minutes
    const l = lot({ bidCount: 1, highBid: 60n * USDC, highBidderPaddle: 1 });
    for (let n = 0; n < 200; n++) {
      const rng = () => seededRng(`next-${n}`)();
      expect(skipped(input({ now: lastBidAt + 110 * S, lastBidAt, lot: l, rng }))).toBe('waiting');
      expect(bids(input({ now: lastBidAt + 8 * MIN, lastBidAt, lot: l, rng }))).toBe(true);
    }
  });

  it('never waits less than 2.5 seconds', () => {
    const l = lot({ closesAt: T0 + 30 * S });
    for (let n = 0; n < 100; n++) expect(skipped(input({ now: T0 + 2_400, lot: l, rng: () => seededRng(`min-${n}`)() }))).toBe('waiting');
  });

  it('still never bids in the last 20 seconds', () => {
    expect(skipped(input({ now: T0 + H - 19 * S }))).toBe('too late in the lot');
  });
});

describe('timed: at most 4 bids, the last kept for the final 10 minutes', () => {
  const afterThree = lot({ bidCount: 3, highBid: 78n * USDC, highBidderPaddle: 3 });
  it('four house bids are the limit', () => expect(skipped(input({ lot: lot({ bidCount: MAX_BOT_BIDS_PER_LOT, highBidderPaddle: 1 }), lastBidAt: T0 + 5 * MIN }))).toBe('enough house bids'));
  it('with three placed, the fourth waits for the last 10 minutes', () => {
    expect(skipped(input({ lot: afterThree, lastBidAt: T0 + 5 * MIN, now: T0 + H - 11 * MIN }))).toBe('keeping the last bid for the final minutes');
    expect(skipped(input({ lot: afterThree, lastBidAt: T0 + 5 * MIN, now: T0 + H - TIMED_FINAL_WINDOW_MS - 1 }))).toBe('keeping the last bid for the final minutes');
    expect(bids(input({ lot: afterThree, lastBidAt: T0 + 5 * MIN, now: T0 + H - 5 * MIN, rng: () => 0.99 }))).toBe(true);
  });
  it('inside the window the wait starts at the window, not at an older bid', () => {
    // last bid 50 minutes ago; the window opened 10 minutes before the end: the next house bid is 30 to 120 seconds after that point.
    const l = lot({ bidCount: 2, highBid: 66n * USDC, highBidderPaddle: 2 });
    const windowStart = T0 + H - TIMED_FINAL_WINDOW_MS;
    expect(skipped(input({ lot: l, lastBidAt: T0 + 5 * MIN, now: windowStart + 20 * S }))).toBe('waiting');
    expect(bids(input({ lot: l, lastBidAt: T0 + 5 * MIN, now: windowStart + 121 * S }))).toBe(true);
  });
  it('a lot that has bids but no known last bid time is left alone (no guessing)', () => {
    expect(skipped(input({ lot: lot({ bidCount: 1, highBid: 60n * USDC, highBidderPaddle: 1 }), lastBidAt: null, now: T0 + 40 * MIN }))).toBe('last bid time unknown');
  });
});

describe('timed: the same guard rails as live', () => {
  it('a person leading is never outbid, whatever the time', () => {
    for (const now of [T0 + 10 * MIN, T0 + H - 15 * MIN, T0 + H - 5 * MIN]) for (const paddle of [4, 9, 250]) {
      expect(skipped(input({ now, lastBidAt: T0, lot: lot({ bidCount: 1, highBid: 60n * USDC, highBidderPaddle: paddle }) }))).toBe('a person is leading');
    }
  });
  it('the 60 percent cap holds', () => {
    const l = lot({ value: 100n * USDC, openingPrice: 61n * USDC });
    expect(skipped(input({ lot: l, now: T0 + 40 * MIN }))).toBe('at the cap');
    expect(botCap(100n * USDC)).toBe(60n * USDC);
  });
  it('only on the house show', () => expect(skipped(input({ isHouseShow: false }))).toBe('not the house show'));
  it('a live lot (timed absent or false) keeps the live pacing of seconds', () => {
    const live = (over: Partial<BotInput> = {}) => input({ timed: false, lot: lot({ closesAt: T0 + 40 * S }), now: T0 + 9 * S, ...over });
    expect(bids(live())).toBe(true); // 3 to 8 s after the open
    expect(bids(live({ timed: undefined }))).toBe(true);
    expect(skipped(live({ now: T0 + 2 * S }))).toBe('waiting');
  });
});

describe('timed: a whole lot, simulated second by second with the real anti-sniping clock', () => {
  const rules = resolveRules({ lotDurationS: 3600 }, undefined, 'timed', {});
  it('over many seeds: 1 to 4 house bids, one of them in the final 10 minutes, never in the last 20 seconds, never the same bot twice in a row', () => {
    for (let n = 0; n < 60; n++) {
      let l = lot({ closesAt: T0 + H });
      let closesAt = l.closesAt!;
      let lastBidAt: number | null = null;
      const placed: { at: number; paddle: number }[] = [];
      for (let now = T0; now < closesAt; now += S) {
        const d = decideBotBid(input({ now, lot: { ...l, closesAt }, lastBidAt, rng: seededRng(`sim${n}:${l.bidCount}`) }));
        if (!('bid' in d)) continue;
        expect(closesAt - now).toBeGreaterThanOrEqual(20 * S);
        placed.push({ at: now, paddle: d.bid.paddle });
        l = { ...l, bidCount: l.bidCount + 1, highBid: d.bid.amount, highBidderPaddle: d.bid.paddle };
        lastBidAt = now;
        closesAt = nextClosesAt({ closesAt, openedAt: T0, now, rules }).closesAt;
      }
      expect(placed.length, `seed ${n}`).toBeGreaterThanOrEqual(1);
      expect(placed.length, `seed ${n}`).toBeLessThanOrEqual(MAX_BOT_BIDS_PER_LOT);
      expect(placed.some((b) => b.at >= T0 + H - TIMED_FINAL_WINDOW_MS), `seed ${n}: one bid in the final 10 minutes`).toBe(true);
      placed.slice(1).forEach((b, k) => expect(b.paddle).not.toBe(placed[k].paddle));
      expect(l.highBid === null || l.highBid <= botCap(l.value!)).toBe(true);
    }
  });
});
