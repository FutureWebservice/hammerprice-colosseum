/**
 * The demo auctioneer's pacing and bidding-decision logic: how much a simulated paddle bids
 * next, how long the room waits before that bid lands, and when the bidding has gone quiet
 * long enough for the hammer to fall. No I/O - same pattern as bidding.ts and auctioneer.ts,
 * and reuses nextIncrement from bidding.ts rather than re-deriving the money rules.
 *
 * Split out of demo-auctioneer.ts (which re-exports everything here for backward
 * compatibility) so this half - the half src/lib/demo-clock.ts needs, and through it the
 * browser - never drags node:crypto, tweetnacl or @solana/web3.js into a client bundle. Those
 * only exist to derive and sign with the paddles' Ed25519 keypairs, which nothing running in
 * the browser needs to do.
 */
import { nextIncrement } from './bidding';

/** A tiny seeded PRNG (mulberry32) so tests get a reproducible bid sequence without pulling in
 *  a dependency for eight lines of arithmetic. Also what demo-clock.ts seeds per (cycle, lot)
 *  to make the whole simulation a pure function of wall-clock time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PADDLES = [
  'Paddle 07', 'Paddle 12', 'Paddle 19', 'Paddle 23',
  'Paddle 31', 'Paddle 44', 'Paddle 58', 'Paddle 62',
] as const;

/** Pick a paddle, preferring not to repeat whoever holds the high bid - real rooms don't let a
 *  bidder chase their own bid, and it reads as scripted when the same name bids twice running. */
export function pickPaddle(paddles: readonly string[], exclude: string | null, rng: () => number): string {
  const pool = exclude ? paddles.filter((p) => p !== exclude) : paddles;
  const list = pool.length ? pool : paddles;
  return list[Math.floor(rng() * list.length)]!;
}

// ---------------------------------------------------------------------------------------------
// Pacing. A lot's "pace" bucket drives both how eager the next bid is (delay) and whether one
// comes at all (shouldBid) - this is what makes the room feel like it's converging on a number
// rather than counting up on a metronome.
// ---------------------------------------------------------------------------------------------

export type BidPace = 'below' | 'near' | 'at-or-above' | 'no-reserve';

/** Where the high bid sits relative to the confidential reserve. "near" is the top 20% of the
 *  gap between nothing bid and reserve - close enough that the room can smell it. */
export function paceOf(highBid: bigint | null, reserve: bigint | null): BidPace {
  if (reserve == null) return 'no-reserve';
  const cur = highBid ?? BigInt(0);
  if (cur >= reserve) return 'at-or-above';
  const nearFloor = reserve - reserve / BigInt(5);
  return cur >= nearFloor ? 'near' : 'below';
}

const DELAY_RANGE_MS: Record<BidPace, readonly [number, number]> = {
  // Tightened across the board: a sale that takes eighty seconds to reach its limit reads as
  // slow to someone who dropped in to watch one lot. The shape is unchanged, the room still
  // hurries as it nears the limit and slows once past it; it just breathes faster.
  below: [1_800, 6_500],
  near: [1_200, 3_500],
  'no-reserve': [2_500, 8_000],
  'at-or-above': [4_000, 14_000],
};

/** How long the room waits before the next bid (or, when shouldBid says no, how long it sits
 *  in silence before the hammer falls) - reusing the same range either way reads correctly:
 *  the auctioneer waits about as long as another bid would have taken, then closes it out. */
export function nextBidDelayMs(pace: BidPace, rng: () => number): number {
  const [lo, hi] = DELAY_RANGE_MS[pace];
  return lo + Math.floor(rng() * (hi - lo));
}

/** Below its limit, a lot takes at least this many bids before the room is allowed to go
 *  quiet. Four is enough to read as an auction and still leaves the ceiling and the
 *  above-limit curve doing the real work of ending a lot. */
const MIN_BIDS_BEFORE_QUIET = 4;

/** Whether a bid lands at all this round.
 *
 *  The shape the room is meant to have, and the one a visitor asked for after bidding in it:
 *  a crowded opening and a quiet close. Early on, paddles chase everything, including a real
 *  visitor's bid, so there is a genuine contest; late on they drop away, so a bidder who keeps
 *  going takes the lot. `progress` is how far through the lot's window the round falls, 0 at
 *  the opening and 1 at the ceiling.
 *
 *  Below the limit the room almost never stops. A lot that goes quiet before the limit passes,
 *  and a demo full of unsold lots teaches a visitor nothing about a product whose whole point
 *  is the hammer falling. The limit still binds: what ends a lot is reaching it and then the
 *  bidding drying up above it, not the room losing interest below it. */
export function shouldBid(
  pace: BidPace,
  bidsPlacedOnLot: number,
  rng: () => number,
  visitorIsHighBidder = false,
  progress = 0,
): boolean {
  const p = Math.min(1, Math.max(0, progress));
  // BELOW THE LIMIT THE ROOM KEEPS GOING, and it does not care who is holding the bid. This is
  // the difference between a contest and a wall, and it is also what stops a persistent bidder
  // from being handed a lot that then passes: while the price is still short of the limit the
  // paddles want it too, so they chase a visitor exactly as they chase each other, and the
  // price climbs to where a sale is possible at all. Going quiet down here would strand the
  // lot below its limit, which is precisely the outcome the visitor kept hitting.
  if (pace !== 'at-or-above') {
    if (bidsPlacedOnLot < MIN_BIDS_BEFORE_QUIET) return true;
    return rng() < (pace === 'near' ? 0.98 : 0.97);
  }
  // Past the limit the lot can be sold to whoever holds it, so this is where the room decides
  // how hard it wants it.
  if (visitorIsHighBidder) {
    // A real fight just after the limit falls (0.72), fading to almost nothing by the close
    // (0.08). This is the curve that makes persistence pay: keep bidding and the room
    // eventually lets you have it.
    return rng() < Math.max(0.08, 0.72 - 0.64 * p);
  }
  // Paddle against paddle above the limit: every further bid only raises a price already high
  // enough to sell, and the room tires of it, faster the later it is.
  return rng() < Math.max(0.04, 0.45 - bidsPlacedOnLot * 0.04 - 0.2 * p);
}

// ---------------------------------------------------------------------------------------------
// Amount. The ceiling is what stops a run of bad luck (or a bug in the pacing above) from
// bidding a lot to the moon: once the next legal bid would clear it, there is no next bid.
// ---------------------------------------------------------------------------------------------

/** A public safety cap, not the confidential reserve: 3x the reserve (or, if the lot has none,
 *  3x twice the opening price) is generous enough to never be mistaken for realistic bidding
 *  and hard enough that a paddle can never run away regardless of how the pacing rolls. */
export function bidCeiling(opening: bigint, reserve: bigint | null): bigint {
  const base = reserve ?? opening * BigInt(2);
  return base * BigInt(3);
}

/** The next bid, or null if even the minimum legal bid (bidding.ts's nextIncrement) would
 *  clear the ceiling - the caller's signal to stop bidding and let the hammer fall instead. */
export function nextBidAmount(params: {
  highBid: bigint | null;
  opening: bigint;
  increment: bigint;
  reserve: bigint | null;
  rng: () => number;
}): bigint | null {
  const { highBid, opening, increment, reserve, rng } = params;
  const min = nextIncrement(highBid, opening, increment);
  const ceiling = bidCeiling(opening, reserve);
  if (min > ceiling) return null;
  const extraIncrements = Math.floor(rng() * 3); // a paddle jumps 0, 1 or 2 increments past the minimum
  const amount = min + increment * BigInt(extraIncrements);
  return amount > ceiling ? min : amount;
}

// ---------------------------------------------------------------------------------------------
// One step of the clock for whichever lot is currently open.
// ---------------------------------------------------------------------------------------------

export type LotContext = {
  highBid: bigint | null;
  opening: bigint;
  increment: bigint;
  reserve: bigint | null;
  bidsPlacedOnLot: number;
};

export type StepResult =
  | { type: 'bid'; amount: bigint; delayMs: number }
  | { type: 'hammer'; delayMs: number };

/** Decide the single next thing that happens to an open lot: another bid (with how long the
 *  room waited for it), or the hammer (with how long it sat in silence first). Never returns a
 *  bid past bidCeiling - once nextBidAmount says no, this always hammers.
 *  `visitorIsHighBidder` - see shouldBid - is false for every real room and every simulated
 *  paddle; demo-clock.ts sets it true only for the rounds evaluated while a real visitor's own
 *  bid is the current high bid. */
export function step(ctx: LotContext, rng: () => number, visitorIsHighBidder = false, progress = 0): StepResult {
  const pace = paceOf(ctx.highBid, ctx.reserve);
  const amount = nextBidAmount({ highBid: ctx.highBid, opening: ctx.opening, increment: ctx.increment, reserve: ctx.reserve, rng });
  const delayMs = nextBidDelayMs(pace, rng);
  if (amount !== null && shouldBid(pace, ctx.bidsPlacedOnLot, rng, visitorIsHighBidder, progress)) {
    return { type: 'bid', amount, delayMs };
  }
  return { type: 'hammer', delayMs };
}
