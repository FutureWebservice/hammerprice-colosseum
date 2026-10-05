import { describe, expect, it } from 'vitest';
import { botCap, decideBotBid, HOUSE_BOT_COUNT, isHousePaddle, MAX_BOT_BIDS_PER_LOT, seededRng, type BotInput, type BotLot } from '../bots';

const USDC = 1_000_000n;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

const lot = (over: Partial<BotLot> = {}): BotLot => ({
  state: 'open', closesAt: T0 + 40_000, openedAt: T0, highBid: null, highBidderPaddle: null, bidCount: 0,
  openingPrice: 60n * USDC, increment: 6n * USDC, value: 120n * USDC, ...over,
});
const input = (over: Partial<BotInput> = {}): BotInput => ({
  enabled: true, isHouseShow: true, showLive: true, now: T0 + 9_000, lot: lot(), lastBidAt: null, rng: seededRng('seed'), ...over,
});
const bid = (i: BotInput) => { const d = decideBotBid(i); if (!('bid' in d)) throw new Error(`expected a bid, got skip: ${d.skip}`); return d.bid; };
const skipped = (i: BotInput) => { const d = decideBotBid(i); return 'skip' in d ? d.skip : null; };

describe('decideBotBid: where it may bid at all', () => {
  it('never when switched off', () => expect(skipped(input({ enabled: false }))).toBe('disabled'));
  it('never on a show that is not the house show (shill-bidding guard)', () => expect(skipped(input({ isHouseShow: false }))).toBe('not the house show'));
  it('never without a live show and an open timed lot', () => {
    expect(skipped(input({ showLive: false }))).toBe('no open lot');
    expect(skipped(input({ lot: null }))).toBe('no open lot');
    expect(skipped(input({ lot: lot({ state: 'sold' }) }))).toBe('no open lot');
    expect(skipped(input({ lot: lot({ closesAt: null }) }))).toBe('no open lot');
  });
  it('never when the card has no known value', () => {
    expect(skipped(input({ lot: lot({ value: null }) }))).toBe('no value known');
    expect(skipped(input({ lot: lot({ value: 0n }) }))).toBe('no value known');
  });
  it('never in the last 20 seconds of a lot, so a house bid cannot be the late bid that extends it', () => {
    expect(skipped(input({ now: T0 + 20_001 }))).toBe('too late in the lot');
    expect(skipped(input({ now: T0 + 45_000 }))).toBe('too late in the lot');
  });
});

describe('decideBotBid: the 60% cap', () => {
  it('bids the opening price first, and one increment more each time, never above 60% of the value', () => {
    // value 120 USDC: cap 72. Opening 60, then 66, 72, and 78 is refused.
    expect(botCap(120n * USDC)).toBe(72n * USDC);
    expect(bid(input()).amount).toBe(60n * USDC);
    expect(bid(input({ lot: lot({ highBid: 60n * USDC, highBidderPaddle: 1, bidCount: 1 }), lastBidAt: T0 + 3000, now: T0 + 12_000 })).amount).toBe(66n * USDC);
    expect(bid(input({ lot: lot({ highBid: 66n * USDC, highBidderPaddle: 2, bidCount: 2 }), lastBidAt: T0 + 3000, now: T0 + 12_000 })).amount).toBe(72n * USDC);
    expect(skipped(input({ lot: lot({ highBid: 72n * USDC, highBidderPaddle: 3, bidCount: 3 }), lastBidAt: T0 + 3000, now: T0 + 12_000 }))).toBe('at the cap');
  });

  it('property: over many seeds and values the amount never exceeds 60% of the value', () => {
    for (let n = 0; n < 500; n++) {
      const rng = seededRng(`p${n}`);
      const value = BigInt(Math.floor(rng() * 5000) + 1) * USDC;
      const opening = (value * BigInt(Math.floor(rng() * 90) + 5)) / 100n + 1n;
      const increment = BigInt(Math.floor(rng() * 20) + 1) * USDC;
      const d = decideBotBid(input({ now: T0 + 15_000, lastBidAt: T0, rng: seededRng(`q${n}`), lot: lot({ value, openingPrice: opening, increment, highBid: rng() < 0.5 ? null : opening, highBidderPaddle: 1, bidCount: 1 }) }));
      if ('bid' in d) expect(d.bid.amount).toBeLessThanOrEqual(botCap(value));
    }
  });
});

describe('decideBotBid: people come first', () => {
  it('stops the moment a person holds the high bid and never outbids them', () => {
    for (const p of [HOUSE_BOT_COUNT + 1, 4, 17, 250]) {
      expect(skipped(input({ lot: lot({ highBid: 60n * USDC, highBidderPaddle: p, bidCount: 1 }), now: T0 + 15_000, lastBidAt: T0 + 3000 }))).toBe('a person is leading');
    }
  });
  it('a house paddle is exactly 1 to 3', () => {
    expect([0, 1, 2, 3, 4, null, undefined].map(isHousePaddle)).toEqual([false, true, true, true, false, false, false]);
  });
  it('never the same bot twice in a row: the leading house paddle is excluded', () => {
    for (let n = 0; n < 200; n++) {
      const b = bid(input({ now: T0 + 15_000, lastBidAt: T0, rng: seededRng(`r${n}`), lot: lot({ highBid: 60n * USDC, highBidderPaddle: 2, bidCount: 1 }) }));
      expect([1, 3]).toContain(b.paddle);
    }
  });
  it('at most four house bids on one lot', () => {
    expect(skipped(input({ now: T0 + 15_000, lastBidAt: T0, lot: lot({ bidCount: MAX_BOT_BIDS_PER_LOT, highBid: 60n * USDC, highBidderPaddle: 1 }) }))).toBe('enough house bids');
  });
});

describe('decideBotBid: human-like pacing', () => {
  it('waits 3 to 8 s before the first bid and 2.5 to 8 s between bids, measured from the lot opening or the last bid', () => {
    expect(skipped(input({ now: T0 + 2_900 }))).toBe('waiting'); // under the 3 s floor, for every seed
    expect(skipped(input({ now: T0 + 8_000 }))).toBeNull(); // past the 8 s ceiling, for every seed
    const between = (since: number, now: number) => skipped(input({ now, lastBidAt: since, lot: lot({ highBid: 60n * USDC, highBidderPaddle: 1, bidCount: 1 }) }));
    expect(between(T0 + 5_000, T0 + 7_400)).toBe('waiting');
    expect(between(T0 + 5_000, T0 + 13_000)).toBeNull();
  });
  it('the wait is fixed by the seed: every poll in the same state gets the same answer', () => {
    const at = (now: number, seed: string) => skipped(input({ now: T0 + now, rng: seededRng(seed) }));
    for (const seed of ['a:0', 'b:0', 'c:0']) {
      const first = [3000, 4000, 5000, 6000, 7000, 8000].find((ms) => at(ms, seed) === null);
      expect(first).toBeDefined();
      for (const ms of [3000, 4000, 5000, 6000, 7000, 8000]) expect(at(ms, seed) === null).toBe(ms >= first!);
    }
  });
  it('seededRng is deterministic and uniform enough', () => {
    const a = seededRng('x'); const b = seededRng('x');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seededRng('y')()).not.toBe(seededRng('x')());
    const r = seededRng('u'); const xs = Array.from({ length: 2000 }, () => r());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, v) => s + v, 0) / xs.length).toBeGreaterThan(0.45);
  });
});
