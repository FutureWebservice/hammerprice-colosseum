/**
 * The purchase of one pack as plain, testable pieces: the states the screen can be in, what an API or wallet failure means for the person, and
 * the seed. The hook that drives them is usePackPurchase.ts.
 */
import type { PackDrawView, PackPayment } from '@/contracts';
import type { WalletFailure } from '@/lib/client/bidder';
import type { ReviewedSettlement } from '@/lib/client/settle';

export type PurchaseState =
  | { kind: 'idle' }
  | { kind: 'working'; stage: 'drawing' | 'preparing' }
  /** The wallet prompt is open (or about to be); `review` is decoded from the transaction bytes. */
  | { kind: 'wallet'; draw: PackDrawView; payment: PackPayment; review: ReviewedSettlement | null }
  /** The buyer signed. `on: 'operator'` waits for a third-party operator, `on: 'chain'` for the transaction to land. (equal-value packs) */
  | { kind: 'waiting'; draw: PackDrawView; on: 'operator' | 'chain'; roundExpiresAt: string | null }
  /** Pay first (chance packs): the payment was sent; the screen follows the purchase (confirming, drawing, delivering) to delivered or refunded. */
  | { kind: 'following'; draw: PackDrawView }
  /** Pay first: the operator did not deliver. Hammerprice holds no money and cannot refund: the buyer keeps the evidence. */
  | { kind: 'undelivered'; draw: PackDrawView }
  /** The signing round ran out unsigned: nothing was charged, one press continues. */
  | { kind: 'lapsed'; draw: PackDrawView | null }
  /** Delivered (`settled`), or the end of the devnet demo (`demo_revealed`: the card is shown and a copy of it was minted into the wallet). */
  | { kind: 'settled'; draw: PackDrawView }
  | { kind: 'ended'; draw: PackDrawView; reason: 'expired' | 'failed' }
  | { kind: 'error'; code: string; wallet?: WalletFailure; retryAfterS?: number };

/** 32 lowercase hex characters from the browser's CSPRNG: the buyer's contribution to the draw. */
export function newClientSeed(random: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  return Array.from(random(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The `errors.*` key of the packs namespace for a failure. Anything unknown is the generic text (which always says nothing was charged).
 * A rate limit that resets in more than two minutes is the pack's daily cap, not the per-minute limit.
 */
export function errorKey(code: string, o: { wallet?: WalletFailure; retryAfterS?: number } = {}): string {
  if (code === 'wallet') return o.wallet === 'rejected' ? 'walletRejected' : o.wallet === 'cluster' ? 'walletCluster' : o.wallet === 'unsupported' ? 'walletUnsupported' : 'walletUnknown';
  if (code === 'rate_limited' && (o.retryAfterS ?? 0) > 120) return 'rate_limited_day';
  const known = new Set([
    'unauthenticated', 'insufficient_usdc', 'rate_limited', 'wrong_state', 'asset_not_ready', 'already_listed', 'paused', 'forbidden', 'vrf_pending', 'rpc_unavailable', 'round_expired',
    'simulation_failed', 'tx_mismatch', 'feature_off', 'expired', 'failed', 'review', 'validator', 'wallet_modified',
  ]);
  return known.has(code) ? code : 'generic';
}

/** Seconds until `iso`, never negative; null without a time. */
export function secondsLeft(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - nowMs) / 1000)) : null;
}

/** What a polled pay-first draw means for a purchase that is being followed. */
export function stateAfterFollow(draw: PackDrawView): PurchaseState {
  if (draw.status === 'settled' || draw.status === 'demo_revealed') return { kind: 'settled', draw }; // a demo draw ends at once: the reveal shows the card and the demo notice
  if (draw.status === 'undelivered') return { kind: 'undelivered', draw };
  if (draw.status === 'expired' || draw.status === 'failed') return { kind: 'ended', draw, reason: draw.status };
  if (draw.status === 'awaiting_payment') return { kind: 'lapsed', draw }; // a payment that did not land: nothing was charged, one press continues
  return { kind: 'following', draw };
}

/** The steps a pay-first purchase goes through, in order. */
export const PAY_STEPS = ['pay', 'confirm', 'draw', 'deliver'] as const;
export type PayStep = (typeof PAY_STEPS)[number];
/** A drawn card of a third-party pack waits for its operator: that is the delivery step. (The house demo delivers by itself within seconds.) */
export const waitsForOperator = (draw: Pick<PackDrawView, 'status' | 'operator'>): boolean => draw.status === 'drawn' && draw.operator?.isHouse === false;
/** Which step a status is in. */
export function payStepOf(status: PackDrawView['status'], thirdParty = false): PayStep | 'done' {
  switch (status) {
    case 'awaiting_payment': return 'pay';
    case 'confirming': return 'confirm';
    case 'paid': return 'draw';
    case 'drawn': return thirdParty ? 'deliver' : 'draw';
    case 'delivering': return 'deliver';
    case 'settled': case 'demo_revealed': return 'done';
    default: return 'pay';
  }
}

/** The status line of a followed pay-first purchase. */
export const followKey = (status: PackDrawView['status'], thirdParty = false): string => (
  status === 'confirming' ? 'step.confirming' : status === 'paid' ? 'step.drawAfter' : status === 'drawn' ? (thirdParty ? 'step.waitingDelivery' : 'step.drawn') : status === 'delivering' ? 'step.delivering' : 'step.confirming'
);

/** What a polled draw means for a purchase that is waiting. */
export function stateAfterPoll(draw: PackDrawView, current: Extract<PurchaseState, { kind: 'waiting' }>, nowMs: number): PurchaseState {
  if (draw.status === 'settled' || draw.status === 'demo_revealed') return { kind: 'settled', draw };
  if (draw.status === 'expired' || draw.status === 'failed') return { kind: 'ended', draw, reason: draw.status };
  if (draw.status === 'reserved' && current.roundExpiresAt && Date.parse(current.roundExpiresAt) + 2000 < nowMs) return { kind: 'lapsed', draw };
  if (draw.status === 'submitted') return { kind: 'waiting', draw, on: 'chain', roundExpiresAt: current.roundExpiresAt };
  return { ...current, draw };
}

/** The step the screen reports to assistive technology and to the status line. */
export function statusKey(s: PurchaseState): string | null {
  switch (s.kind) {
    case 'working': return s.stage === 'drawing' ? 'step.drawing' : 'step.preparing';
    case 'wallet': return 'step.wallet';
    case 'waiting': return s.on === 'operator' ? 'step.waitingOperator' : 'step.paying';
    case 'following': return followKey(s.draw.status, waitsForOperator(s.draw));
    case 'lapsed': return 'step.lapsed';
    default: return null;
  }
}
