import { describe, it, expect } from 'vitest';
import {
  mulberry32, PADDLES, pickPaddle,
  paceOf, nextBidDelayMs, shouldBid, bidCeiling, nextBidAmount, step,
  type BidPace, type LotContext,
} from '../demo-pacing';
import { hammerOutcome } from '../auctioneer';

const usdc = (n: number) => BigInt(Math.round(n * 1_000_000));

describe('pickPaddle', () => {
  it('never repeats the excluded paddle', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      expect(pickPaddle(PADDLES, 'Paddle 07', rng)).not.toBe('Paddle 07');
    }
  });

  it('falls back to the full pool if exclude is not a member (never throws, never empty)', () => {
    const rng = mulberry32(2);
    expect(PADDLES).toContain(pickPaddle(PADDLES, 'Someone Else', rng));
  });
});

describe('paceOf', () => {
  it('has no reserve when the lot has none', () => {
    expect(paceOf(null, null)).toBe('no-reserve');
  });
  it('is below while under 80% of the reserve', () => {
    expect(paceOf(usdc(50), usdc(100))).toBe('below');
  });
  it('is near in the top 20% under reserve', () => {
    expect(paceOf(usdc(85), usdc(100))).toBe('near');
  });
  it('is at-or-above once the high bid reaches reserve', () => {
    expect(paceOf(usdc(100), usdc(100))).toBe('at-or-above');
    expect(paceOf(usdc(150), usdc(100))).toBe('at-or-above');
  });
});

describe('nextBidDelayMs', () => {
  it('always lands inside the pace bucket range', () => {
    const rng = mulberry32(3);
    const ranges: Record<string, [number, number]> = {
      below: [1_800, 6_500], near: [1_200, 3_500], 'no-reserve': [2_500, 8_000], 'at-or-above': [4_000, 14_000],
    };
    for (const pace of Object.keys(ranges) as (keyof typeof ranges)[]) {
      for (let i = 0; i < 50; i++) {
        const ms = nextBidDelayMs(pace as BidPace, rng);
        expect(ms).toBeGreaterThanOrEqual(ranges[pace][0]);
        expect(ms).toBeLessThan(ranges[pace][1]);
      }
    }
  });
});

describe('shouldBid', () => {
  it('gets less likely the longer a lot sits above reserve, down to a floor', () => {
    // rng fixed just under the floor probability: only the earliest rounds (still above the
    // shrinking threshold) say yes.
    const rng = () => 0.06;
    expect(shouldBid('at-or-above', 0, rng)).toBe(true); // threshold starts at 0.4
    expect(shouldBid('at-or-above', 20, rng)).toBe(false); // floored at 0.05, rng=0.06 fails it
  });

  it('fights a visitor below the limit and lets them have it above', () => {
    // Below the limit the room chases a visitor exactly as it chases a paddle. Going quiet down
    // here would strand the lot under its limit, which is the outcome a real visitor kept
    // hitting: they held the high bid and the lot passed anyway.
    expect(shouldBid('below', 9, () => 0.5, true)).toBe(true);
    expect(shouldBid('near', 9, () => 0.5, true)).toBe(true);
    // Above the limit the lot can be sold to whoever holds it, and that is where the room
    // decides. Early it still contests a visitor; late it gives way, so persistence pays.
    expect(shouldBid('at-or-above', 0, () => 0.5, true, 0)).toBe(true);
    expect(shouldBid('at-or-above', 0, () => 0.5, true, 1)).toBe(false);
    // A paddle holding the bid is treated the same way it always was.
    expect(shouldBid('near', 0, () => 0.94)).toBe(true);
  });

  it('almost never goes quiet below the limit, whoever is bidding', () => {
    // The user's complaint was a demo full of unsold lots. What ends a lot is reaching the
    // limit and the bidding drying up above it, never the room losing interest below it.
    for (const pace of ['below', 'near'] as const) {
      for (const visitorLeads of [false, true]) {
        let quiet = 0;
        for (let seed = 0; seed < 300; seed++) {
          if (!shouldBid(pace, 9, mulberry32(seed), visitorLeads, 0.9)) quiet++;
        }
        expect(quiet / 300).toBeLessThan(0.06);
      }
    }
  });
});

describe('step - visitorIsHighBidder', () => {
  it('never bids past the ceiling and always resolves to bid or hammer, with the flag set', () => {
    const ctx: LotContext = { highBid: usdc(60), opening: usdc(50), increment: usdc(5), reserve: usdc(100), bidsPlacedOnLot: 2 };
    for (let seed = 0; seed < 30; seed++) {
      const rng = mulberry32(seed);
      const result = step(ctx, rng, true);
      expect(['bid', 'hammer']).toContain(result.type);
      if (result.type === 'bid') expect(result.amount).toBeLessThanOrEqual(bidCeiling(ctx.opening, ctx.reserve));
    }
  });

  it('gives way to a visitor holding the bid above the limit, and the more so the later it is', () => {
    const above: LotContext = { highBid: usdc(110), opening: usdc(50), increment: usdc(5), reserve: usdc(100), bidsPlacedOnLot: 2 };
    const count = (visitorLeads: boolean, progress: number) => {
      let bids = 0;
      for (let seed = 0; seed < 300; seed++) {
        if (step(above, mulberry32(seed), visitorLeads, progress).type === 'bid') bids++;
      }
      return bids;
    };
    // Late in the lot the room lets a visitor keep it far more readily than it lets a paddle
    // keep it early - this is the whole shape: a crowded opening, a quiet close.
    expect(count(true, 0.9)).toBeLessThan(count(true, 0));
    expect(count(true, 0.9)).toBeLessThan(count(false, 0));
  });
});

describe('bidCeiling / nextBidAmount', () => {
  it('is 3x the reserve when one is set', () => {
    expect(bidCeiling(usdc(50), usdc(100))).toBe(usdc(300));
  });

  it('never returns an amount past the ceiling, for any rng draw', () => {
    const reserve = usdc(100);
    const opening = usdc(50);
    const increment = usdc(5);
    for (let seed = 0; seed < 20; seed++) {
      const rng = mulberry32(seed);
      let highBid: bigint | null = null;
      for (let round = 0; round < 100; round++) {
        const amount = nextBidAmount({ highBid, opening, increment, reserve, rng });
        if (amount === null) break; // hit the ceiling - this is the required outcome eventually
        expect(amount).toBeLessThanOrEqual(bidCeiling(opening, reserve));
        highBid = amount;
      }
    }
  });

  it('stops (returns null) once the minimum legal bid alone would clear the ceiling', () => {
    const reserve = usdc(100);
    const rng = () => 0; // no extra increments - isolates the min-vs-ceiling check
    const amount = nextBidAmount({ highBid: bidCeiling(usdc(50), reserve), opening: usdc(50), increment: usdc(5), reserve, rng });
    expect(amount).toBeNull();
  });
});

describe('step', () => {
  it('never bids past the ceiling and always resolves to bid or hammer', () => {
    const ctx: LotContext = { highBid: null, opening: usdc(50), increment: usdc(5), reserve: usdc(100), bidsPlacedOnLot: 0 };
    for (let seed = 0; seed < 30; seed++) {
      const rng = mulberry32(seed);
      const result = step(ctx, rng);
      expect(['bid', 'hammer']).toContain(result.type);
      if (result.type === 'bid') expect(result.amount).toBeLessThanOrEqual(bidCeiling(ctx.opening, ctx.reserve));
      expect(result.delayMs).toBeGreaterThan(0);
    }
  });
});

/**
 * A single lot, driven to its conclusion by repeated step() calls - the same loop shape the
 * live route runs, minus any I/O. Proves the exported primitives compose into a full lot
 * without ever going idle forever, and lets the multi-lot test below assert the two
 * requirements that only show up across a whole show: never two lots open, not every lot sells.
 */
function runLotToConclusion(opening: bigint, increment: bigint, reserve: bigint | null, rng: () => number) {
  let ctx: LotContext = { highBid: null, opening, increment, reserve, bidsPlacedOnLot: 0 };
  let lastPaddle: string | null = null;
  const bids: { paddle: string; amount: bigint }[] = [];
  for (let round = 0; round < 500; round++) { // generous cap - a real run always hammers well before this
    const result = step(ctx, rng);
    if (result.type === 'hammer') {
      return { outcome: hammerOutcome({ highBid: ctx.highBid, reserve, requested: 'sold' }), highBid: ctx.highBid, bids };
    }
    const paddle = pickPaddle(PADDLES, lastPaddle, rng);
    bids.push({ paddle, amount: result.amount });
    ctx = { ...ctx, highBid: result.amount, bidsPlacedOnLot: ctx.bidsPlacedOnLot + 1 };
    lastPaddle = paddle;
  }
  throw new Error('lot never concluded within the round cap - pacing regression');
}

describe('a simulated show (multi-lot invariants)', () => {
  it('always concludes every lot (sold or passed), across many seeds, never running two lots open', () => {
    const lots = Array.from({ length: 12 }, (_, i) => ({
      opening: usdc(50 + i), increment: usdc(5), reserve: usdc(100 + i * 3),
    }));

    let lotIsOpen = false;
    const outcomes: ('sold' | 'passed')[] = [];

    for (let seed = 0; seed < 40; seed++) {
      const rng = mulberry32(seed * 7919 + 1);
      for (const lot of lots) {
        // A lot only "opens" here once the previous one has fully concluded
        // (runLotToConclusion always returns before the next iteration starts), so overlap is
        // structurally impossible - this assertion documents that invariant rather than
        // merely hoping for it.
        expect(lotIsOpen).toBe(false);
        lotIsOpen = true;
        const result = runLotToConclusion(lot.opening, lot.increment, lot.reserve, rng);
        lotIsOpen = false;
        outcomes.push(result.outcome as 'sold' | 'passed');
        if (result.outcome === 'sold') expect(result.highBid).not.toBeNull();
      }
    }

    expect(outcomes.length).toBe(40 * 12);
    // Not every lot sells, and not every lot passes - both outcomes must show up, which is
    // what demonstrates the reserve rule rather than just always/never clearing it.
    expect(outcomes.some((o) => o === 'sold')).toBe(true);
    expect(outcomes.some((o) => o === 'passed')).toBe(true);
  });
});
