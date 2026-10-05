/**
 * The auction decisions, pure. The service (server/auction/service.ts) fetches and locks rows, calls these, and
 * writes the result; nothing here touches the database or the clock (time comes in as `nowMs`).
 *
 * Automatic close: a lot closes when `closesAt` passes, extended by anti-sniping. There is
 * no hammer, no accept-below-reserve and no operator override.
 */
import { MAX_BID } from '@/contracts/common';
import type { ErrorCode } from '@/contracts/errors';
import type { LotState, ShowStatus } from '@/contracts/common';
import { nextIncrement } from '@/lib/bidding';
import { hammerOutcome } from '@/lib/auctioneer';
import { PAUSE_MAX_COUNT, PAUSE_MAX_MS, PAUSE_MIN_LEFT_MS, type AuctionRules } from './rules';

// ---------------------------------------------------------------------------------------------
// Anti-sniping
// ---------------------------------------------------------------------------------------------

/**
 * Where `closesAt` lands after a bid at `now` (precondition: now < closesAt). A bid inside the last snipeWindowS
 * seconds moves the close to at least now + snipeExtendS, but never past openedAt + lotDurationS + maxExtensionS,
 * and never backwards.
 */
export function nextClosesAt(i: { closesAt: number; openedAt: number | null; now: number; rules: AuctionRules }): { closesAt: number; extended: boolean } {
  const r = i.rules;
  if (i.closesAt - i.now > r.snipeWindowS * 1000) return { closesAt: i.closesAt, extended: false };
  const opened = i.openedAt ?? i.closesAt - r.lotDurationS * 1000;
  const cap = opened + (r.lotDurationS + r.maxExtensionS) * 1000;
  const closesAt = Math.max(i.closesAt, Math.min(i.now + r.snipeExtendS * 1000, cap));
  return { closesAt, extended: closesAt > i.closesAt };
}

/** Where a seller's `extend` of `seconds` lands: same cap as anti-sniping, never backwards. */
export function extendedClosesAt(i: { closesAt: number; openedAt: number | null; seconds: number; rules: AuctionRules }): number {
  const opened = i.openedAt ?? i.closesAt - i.rules.lotDurationS * 1000;
  const cap = opened + (i.rules.lotDurationS + i.rules.maxExtensionS) * 1000;
  return Math.max(i.closesAt, Math.min(i.closesAt + i.seconds * 1000, cap));
}

// ---------------------------------------------------------------------------------------------
// The seller's pause: clock math and the rules that limit it
// ---------------------------------------------------------------------------------------------

/** The moment a pause ends by itself. */
export const pauseExpiresAt = (pausedAt: number): number => pausedAt + PAUSE_MAX_MS;

/** A pause whose limit has passed but that nobody has resumed yet (the lazy resume is due). */
export const pauseExpired = (pausedAt: number, now: number): boolean => now >= pauseExpiresAt(pausedAt);

/**
 * What a resume does to the clock. The room runs again from `resumedAt`, which is `now` for a manual resume and never later than the pause
 * limit: a resume that is noticed late (nobody polled for a while) still counts the pause as exactly 5 minutes long, because bids are
 * accepted again from that moment. `shiftMs` is how far the open lot's deadline moves: the paused time, so no bidder loses a second.
 */
export function resumeShift(i: { pausedAt: number; now: number }): { resumedAt: number; shiftMs: number } {
  const resumedAt = Math.max(i.pausedAt, Math.min(i.now, pauseExpiresAt(i.pausedAt)));
  return { resumedAt, shiftMs: resumedAt - i.pausedAt };
}

export type PauseDecision = { ok: true; msLeft: number; resumesBy: number; count: number } | { ok: false; code: ErrorCode; reason: string };

/**
 * May the seller pause now? First failure wins. `pausedAt` is the pause already in effect (a due auto-resume must have been applied before
 * asking). The lot must be open with at least PAUSE_MIN_LEFT_MS left; a show gets PAUSE_MAX_COUNT pauses.
 */
export function decidePause(i: {
  status: ShowStatus;
  kind: 'live' | 'timed';
  pausedAt: number | null;
  pauseCount: number;
  openLot: { closesAt: number | null } | null;
  now: number;
}): PauseDecision {
  if (i.status !== 'live') return { ok: false, code: 'wrong_state', reason: 'Only a live show can be paused.' };
  if (i.kind === 'timed') return { ok: false, code: 'wrong_state', reason: 'A timed auction cannot be paused.' };
  if (i.pausedAt !== null) return { ok: false, code: 'show_paused', reason: 'The room is already paused.' };
  if (i.pauseCount >= PAUSE_MAX_COUNT) return { ok: false, code: 'pause_limit', reason: `A show can be paused ${PAUSE_MAX_COUNT} times.` };
  if (!i.openLot || i.openLot.closesAt === null) return { ok: false, code: 'lot_not_open', reason: 'There is no lot on the block to pause.' };
  const msLeft = i.openLot.closesAt - i.now;
  if (msLeft < PAUSE_MIN_LEFT_MS) return { ok: false, code: 'pause_too_late', reason: `A lot cannot be paused in its last ${PAUSE_MIN_LEFT_MS / 1000} seconds.` };
  return { ok: true, msLeft, resumesBy: i.now + PAUSE_MAX_MS, count: i.pauseCount + 1 };
}

// ---------------------------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------------------------

export interface DecideBidInput {
  lot: {
    state: LotState;
    highBid: bigint | null;
    highBidderId: string | null;
    openingPrice: bigint;
    increment: bigint;
    reserve: bigint | null;
    /** ms epoch; null = not a timed lot (legacy row). */
    closesAt: number | null;
    openedAt: number | null;
    sellerProfileId: string;
    sellerWallet: string | null;
  };
  show: { status: ShowStatus; rules: AuctionRules; isHouse: boolean; sellerProfileId: string; sellerWallet: string | null; /** ms epoch of the pause in effect; null or absent = running. */ pausedAt?: number | null };
  bidder: { profileId: string; wallet: string; isBanned: boolean; isBot: boolean };
  /** The bidder's registration for this show; null = none. */
  paddle: { number: number; validUntil: number; revoked: boolean; maxBid: bigint | null } | null;
  via: 'wallet' | 'session' | 'house';
  amount: bigint;
  nowMs: number;
  /** Spendable USDC in base units: chain balance minus commitments, floored at 0 by the caller. */
  available: bigint;
}

export type DecideBidResult =
  | { ok: true; belowReserve: boolean; closesAt: number; extended: boolean }
  | { ok: false; code: ErrorCode; reason: string; minNext?: bigint };

const no = (code: ErrorCode, reason: string, minNext?: bigint): DecideBidResult => (minNext === undefined ? { ok: false, code, reason } : { ok: false, code, reason, minNext });

/** The smallest amount that would be accepted now. */
export const minNextBid = (lot: Pick<DecideBidInput['lot'], 'highBid' | 'openingPrice' | 'increment'>): bigint => nextIncrement(lot.highBid, lot.openingPrice, lot.increment);

/** First failure wins; every code is in contracts/errors.ts. */
export function decideBid(i: DecideBidInput): DecideBidResult {
  const { lot, show, bidder, paddle, amount, nowMs } = i;

  if (show.status === 'scheduled' || (show.status === 'ended' && lot.state !== 'open')) return no('show_not_live', 'This show is not live.');
  // An ended show whose last lot is still running keeps taking bids until that lot closes (ending a show stops new lots, not the one on the block).

  if (lot.state === 'catalogued') return no('lot_not_open', 'This lot has not opened yet.');
  if (lot.state !== 'open') return no('lot_closed', 'Bidding on this lot is closed.');
  if (lot.closesAt === null) return no('lot_not_open', 'This lot is not timed.');
  // The seller paused the room: the clock is frozen, so a deadline in the past is not a close. Nobody bids until it resumes.
  if (show.pausedAt != null) return no('show_paused', 'The seller paused the room. Bidding resumes with the same time left.');
  if (nowMs >= lot.closesAt) return no('lot_closed', 'Bidding on this lot is closed.');

  if (bidder.isBanned) return no('banned', 'This account cannot bid.');
  // House bidders exist only on the house show (shill-bidding guard).
  if ((bidder.isBot || i.via === 'house') && !show.isHouse) return no('forbidden', 'House bidders may only bid on the house show.');
  if (i.via === 'house' && !bidder.isBot) return no('forbidden', 'Only house bidders may bid as the house.');

  if (!paddle || paddle.revoked || paddle.validUntil <= nowMs) return no('no_paddle', 'Register a paddle for this show to bid.');
  if (i.via === 'session' && paddle.maxBid !== null && amount > paddle.maxBid) return no('no_paddle', "That is above the maximum this paddle's session key was authorised for.");

  const sellerLinked =
    bidder.profileId === lot.sellerProfileId || bidder.profileId === show.sellerProfileId ||
    (lot.sellerWallet !== null && bidder.wallet === lot.sellerWallet) || (show.sellerWallet !== null && bidder.wallet === show.sellerWallet);
  if (sellerLinked) return no('self_bid', 'The seller cannot bid on their own lot.');

  if (lot.highBidderId !== null && lot.highBidderId === bidder.profileId) return no('already_high_bidder', 'You already hold the high bid.');

  if (amount > MAX_BID) return no('amount_too_large', 'That amount is above the maximum bid.');
  const min = minNextBid(lot);
  if (amount <= 0n || amount < min) return no('bid_too_low', `The next bid must be at least ${min}.`, min);
  if (amount > i.available) return no('insufficient_funds', 'Your available USDC does not cover this bid.');

  const { closesAt, extended } = nextClosesAt({ closesAt: lot.closesAt, openedAt: lot.openedAt, now: nowMs, rules: show.rules });
  return { ok: true, belowReserve: lot.reserve !== null && amount < lot.reserve, closesAt, extended };
}

// ---------------------------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------------------------

/** Sold when the high bid meets the reserve (or there is no reserve and a bid), else passed. Derived, never trusted. */
export function outcomeAtClose(i: { highBid: bigint | null; reserve: bigint | null }): 'sold' | 'passed' {
  return hammerOutcome({ highBid: i.highBid, reserve: i.reserve, requested: 'sold' }) as 'sold' | 'passed';
}

// ---------------------------------------------------------------------------------------------
// The lazy tick: what advanceShow does, decided from one snapshot of the show
// ---------------------------------------------------------------------------------------------

export type TickAction = { type: 'go_live' } | { type: 'resume' } | { type: 'default_order' } | { type: 'close_lot'; lotId: string } | { type: 'open_next' } | { type: 'end_show' };

/**
 * Whether the show is waiting for its drawn lot order (FEATURE_VRF). `none`: nothing to wait for (a catalogue show, a draw that is
 * revealed or defaulted, or a drawn-order show whose request does not exist yet). `wait`: the draw is pending or committed and its
 * reveal deadline has not passed, so no lot opens and the show does not end. `default`: the deadline passed without a reveal, so the
 * draw is marked defaulted (the catalogue order applies) and the first lot opens in the same tick.
 */
export type OrderGate = 'none' | 'wait' | 'default';

export function orderGateOf(i: { orderMode: string; requestStatus: string | null; revealByMs: number | null; nowMs: number }): OrderGate {
  if (i.orderMode !== 'vrf' || i.requestStatus === null) return 'none';
  if (i.requestStatus !== 'pending' && i.requestStatus !== 'committed') return 'none'; // revealed, defaulted, or a status this build does not know
  return i.revealByMs !== null && i.nowMs < i.revealByMs ? 'wait' : 'default';
}

export interface TickInput {
  now: number;
  show: { status: ShowStatus; scheduledAt: number | null; rules: AuctionRules; /** ms epoch of the pause in effect; null or absent = running. */ pausedAt?: number | null };
  /** The show's open lot, if any (the database allows at most one). */
  openLot: { id: string; closesAt: number | null } | null;
  /** Catalogued lots that are ready to open. */
  openableLots: number;
  /** Latest closed_at over the show's lots. */
  lastClosedAt: number | null;
  /** The drawn-order gate (see OrderGate). Omitted = 'none': catalogue shows never need it. */
  orderGate?: OrderGate;
}

/**
 * Ordered actions for one tick. Idempotent by construction: run again after applying them and the answer is empty
 * until time moves. A lot that is not timed (closesAt null) is never closed here and keeps the next lot from opening.
 */
export function decideTick(i: TickInput): TickAction[] {
  const acts: TickAction[] = [];
  let live = i.show.status === 'live';
  if (i.show.status === 'scheduled') {
    if (i.show.scheduledAt === null || i.show.scheduledAt > i.now) return acts;
    acts.push({ type: 'go_live' });
    live = true;
  }
  const gate = i.orderGate ?? 'none';
  if (live && gate === 'default') acts.push({ type: 'default_order' }); // the draw missed its deadline: record it, then the catalogue order opens below
  let lastClosed = i.lastClosedAt;
  let open = i.openLot !== null;
  // A paused show is frozen: nothing closes, opens or ends until the pause is over. When its limit has passed the resume is the first thing that
  // happens, and the open lot is judged on its shifted deadline (the pause counts as exactly its limit long, see resumeShift).
  let openCloses = i.openLot?.closesAt ?? null;
  if (live && i.show.pausedAt != null) {
    if (!pauseExpired(i.show.pausedAt, i.now)) return acts;
    acts.push({ type: 'resume' });
    if (openCloses !== null) openCloses += resumeShift({ pausedAt: i.show.pausedAt, now: i.now }).shiftMs;
  }
  if (i.openLot && openCloses !== null && openCloses <= i.now) {
    acts.push({ type: 'close_lot', lotId: i.openLot.id });
    lastClosed = Math.max(lastClosed ?? -Infinity, openCloses);
    open = false;
  }
  if (live && !open && gate !== 'wait') {
    const gapOver = lastClosed === null || lastClosed + i.show.rules.gapS * 1000 <= i.now;
    if (gapOver) acts.push(i.openableLots > 0 ? { type: 'open_next' } : { type: 'end_show' });
  }
  return acts;
}
