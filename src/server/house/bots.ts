/**
 * House bidders, the pure half. Nothing here touches the database, the clock or
 * the network: `decideBotBid` gets everything it needs (including the random source) as arguments, so it is exact to test and
 * the service in bots-service.ts only has to feed it and act on the answer.
 *
 * What a house bidder is: a labelled bidder, paddles 1..HOUSE_BOT_COUNT of a HOUSE show, that keeps an idle house lot alive so a
 * visitor sees real bidding. It is not a way to move prices and it is not a rival:
 *   - only on the house show (the engine also refuses a bot anywhere else: shill-bidding guard),
 *   - never above 60% of the card's value, so any human bid above that wins; the lot never needs a bot to be outbid by more than a bid,
 *   - the moment a human is the high bidder the bots stop, and they never outbid a human (they "stop below the human's bid"),
 *   - human-like pacing: a quiet gap of 3 to 8 s before the first bid and 2.5 to 8 s between bids, never in the last seconds of a lot,
 *   - never the same bot twice in a row.
 * On a TIMED lot (hours to days) the pacing scales with what is left instead of seconds: a quiet gap of 5 to 20 percent of the remaining time (at
 * least 2.5 s), at most 4 bids, the last of them kept for the final 10 minutes so the room shows a bid late in the lot (and its soft close). The
 * "person leading" and the cap rules are the same.
 * The room labels paddles 1..HOUSE_BOT_COUNT of the house show "House bidder".
 */
import { nextIncrement } from '@/lib/bidding';

/** Paddle numbers 1..3 of every house show belong to the house bidders (they are registered first, whether or not bots are enabled). */
export const HOUSE_BOT_COUNT = 3;
/** A house bidder never bids above this share of the card's value. */
export const BOT_CAP_PERCENT = 60n;
/** At most this many house bids on one lot. */
export const MAX_BOT_BIDS_PER_LOT = 4;
/** No house bid when less than this is left on the lot (a late bid would also trigger the anti-sniping extension). */
const MIN_LEFT_MS = 20_000;
/** Timed lots: the stretch at the end in which the last house bid is kept, and the share of the remaining time a house bidder waits (5 to 20 percent). */
export const TIMED_FINAL_WINDOW_MS = 10 * 60_000;
const TIMED_WAIT_MIN = 0.05;
const TIMED_WAIT_SPAN = 0.15;
const MIN_WAIT_MS = 2_500;

export const isHousePaddle = (n: number | null | undefined): boolean => typeof n === 'number' && n >= 1 && n <= HOUSE_BOT_COUNT;

export interface BotLot {
  state: 'open' | 'catalogued' | 'sold' | 'passed' | 'withdrawn';
  /** ms epoch */
  closesAt: number | null;
  /** ms epoch the lot opened (or a good estimate) */
  openedAt: number | null;
  highBid: bigint | null;
  /** paddle number of the current high bidder, null when nobody bid */
  highBidderPaddle: number | null;
  bidCount: number;
  openingPrice: bigint;
  increment: bigint;
  /** The card's value (USDC base units); null when unknown, then nothing is bid. */
  value: bigint | null;
}

export interface BotInput {
  enabled: boolean;
  isHouseShow: boolean;
  showLive: boolean;
  /** ms epoch from the database clock (the snapshot's serverNow) */
  now: number;
  lot: BotLot | null;
  /** ms epoch of the lot's last bid, null when it has none */
  lastBidAt: number | null;
  /** uniform [0,1); pass a seeded generator for a repeatable answer */
  rng: () => number;
  /** The show is a timed show (one lot for hours or days): the pacing follows the time left, see above. Absent = live. */
  timed?: boolean;
}

export type BotDecision = { bid: { paddle: number; amount: bigint } } | { skip: string };

const skip = (reason: string): BotDecision => ({ skip: reason });

/** The most a house bidder will pay for a card worth `value`. */
export const botCap = (value: bigint): bigint => (value * BOT_CAP_PERCENT) / 100n;

export function decideBotBid(i: BotInput): BotDecision {
  const { lot } = i;
  if (!i.enabled) return skip('disabled');
  if (!i.isHouseShow) return skip('not the house show');
  if (!i.showLive || !lot || lot.state !== 'open' || lot.closesAt === null) return skip('no open lot');
  if (i.now >= lot.closesAt - MIN_LEFT_MS) return skip('too late in the lot');
  if (lot.value === null || lot.value <= 0n) return skip('no value known');
  if (lot.bidCount >= MAX_BOT_BIDS_PER_LOT) return skip('enough house bids');
  // A human holds the high bid: the house bidders never outbid them.
  if (lot.highBidderPaddle !== null && !isHousePaddle(lot.highBidderPaddle)) return skip('a person is leading');

  const amount = nextIncrement(lot.highBid, lot.openingPrice, lot.increment);
  if (amount > botCap(lot.value)) return skip('at the cap');

  // Pacing: the gap is drawn from the seed once per (lot, bid count), so every poll in the same state agrees on it.
  const first = lot.bidCount === 0;
  const since = i.lastBidAt ?? lot.openedAt ?? i.now;
  if (i.timed === true) {
    const windowStart = lot.closesAt - TIMED_FINAL_WINDOW_MS;
    // The last of the house bids is for the final 10 minutes; before that the lot may take all but one.
    if (i.now < windowStart && lot.bidCount >= MAX_BOT_BIDS_PER_LOT - 1) return skip('keeping the last bid for the final minutes');
    // A lot that already has bids but whose last bid time is out of the snapshot's window: do not guess (a guess could bid in a burst).
    if (lot.bidCount > 0 && i.lastBidAt === null) return skip('last bid time unknown');
    const from = i.now >= windowStart ? Math.max(since, windowStart) : since; // inside the window the wait starts no earlier than the window
    const waitMs = Math.max(MIN_WAIT_MS, Math.floor((TIMED_WAIT_MIN + TIMED_WAIT_SPAN * i.rng()) * (lot.closesAt - from)));
    if (i.now - from < waitMs) return skip('waiting');
  } else {
    const waitMs = first ? 3000 + Math.floor(i.rng() * 5000) : 2500 + Math.floor(i.rng() * 5500);
    if (i.now - since < waitMs) return skip('waiting');
  }

  const candidates = Array.from({ length: HOUSE_BOT_COUNT }, (_, n) => n + 1).filter((p) => p !== lot.highBidderPaddle);
  return { bid: { paddle: candidates[Math.floor(i.rng() * candidates.length) % candidates.length], amount } };
}

/** A small seeded generator (mulberry32) over a string, so the decision for one (lot, bid count) is the same on every poll. */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let n = 0; n < seed.length; n++) { h = Math.imul(h ^ seed.charCodeAt(n), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
