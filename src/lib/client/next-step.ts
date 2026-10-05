/**
 * "What is my next step?": one pure function from the bidder's state to a message key. It reads only what the room
 * already knows (readyStep from bidder.ts, the paddle, the show phase, the standing on the current lot, the
 * settlement), so there is no new data source. The sentence for each key is in tour.json under `nextStep`.
 */
import { readyStep } from './bidder';

export const NEXT_STEP_KEYS = [
  'noWallet', 'notVerified', 'noFunds', 'noPaddle', 'ready', 'leading', 'outbid',
  'won', 'paying', 'waitingSeller', 'confirming', 'done', 'showEnded', 'notOpen',
] as const;
export type NextStepKey = (typeof NEXT_STEP_KEYS)[number];

export interface NextStepState {
  wallet: string | null;
  me: 'off' | 'loading' | 'signed_out' | 'ready' | 'error';
  /** USDC balance in base units from /api/me. */
  usdc: string | null | undefined;
  hasPaddle: boolean;
  show: 'scheduled' | 'live' | 'ended';
  /** The bidder's place on the lot being sold now. */
  standing: 'none' | 'leading' | 'outbid';
  /** This bidder's open or finished payment, when there is one. */
  settlement: null | 'won' | 'paying' | 'waiting_counterparty' | 'sent' | 'done';
}

const SETTLEMENT_KEY = { won: 'won', paying: 'paying', waiting_counterparty: 'waitingSeller', sent: 'confirming', done: 'done' } as const;

/**
 * The buyer's open payment (the cc_marketplace-only 'awaiting_seller' is left unmapped), as the next-step state wants it. Only the buyer role counts: the sentences speak to the person
 * who pays ("Then the card is yours"), and a seller's signature request is shown by the settlement bar and its sheet.
 */
export function settlementFromPending(pending: ReadonlyArray<{ role: 'buyer' | 'seller'; status: string; buyerSigned?: boolean }> | null | undefined): NextStepState['settlement'] {
  const mine = pending?.find((p) => p.role === 'buyer');
  if (!mine) return null;
  switch (mine.status) {
    // Co-sign flow: 'awaiting_payment' also covers "waiting for signatures", so the buyer's own signature decides.
    case 'awaiting_payment': return mine.buyerSigned ? 'waiting_counterparty' : 'won';
    // 'submitted': the transaction is already on chain, nothing is left to confirm in the wallet.
    case 'submitted': return 'sent';
    default: return null;
  }
}

export function nextStep(s: NextStepState): NextStepKey {
  // A payment in progress or finished outranks everything, also after the show ended.
  if (s.settlement) return SETTLEMENT_KEY[s.settlement];
  if (s.show === 'ended') return 'showEnded';
  const ready = readyStep({ wallet: s.wallet, me: s.me, usdc: s.usdc });
  if (ready === 1) return 'noWallet';
  if (ready === 2) return 'notVerified';
  if (ready === 3) return 'noFunds';
  if (!s.hasPaddle) return 'noPaddle';
  if (s.show === 'scheduled') return 'notOpen';
  return s.standing === 'leading' ? 'leading' : s.standing === 'outbid' ? 'outbid' : 'ready';
}
