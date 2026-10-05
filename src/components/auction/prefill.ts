/**
 * The room link of a Telegram lot alert: `/<lang>/room/<show>?lot=<number>&bid=<amount in USDC>`. The parameters are untrusted text from the
 * address bar and are used for ONE thing: to open the existing bid confirmation on that lot with the amount already filled in. The person still
 * presses the confirm button and signs in their own wallet. Nothing is placed, signed or sent because of a link, and nothing from the link
 * reaches the server: `useBid` sends the amount the person confirmed, which the engine checks like any other bid.
 */
import { MAX_BID } from '@/contracts/common';

export interface BidPrefill {
  /** The lot number the link names (1 to 9999). */
  lot: number;
  /** The amount in USDC base units (6 decimals). */
  amount: bigint;
}

/** A pre-filled amount more than this many times the minimum is not used (a link is not a reason to bid far above the price). */
export const PREFILL_MAX_FACTOR = 2n;

const LOT = /^[1-9]\d{0,3}$/;
const AMOUNT = /^(\d{1,7})(?:\.(\d{1,6}))?$/;

/** The pre-fill named by a query string, or null when it is absent or malformed in any way (repeated, not a plain decimal, zero, above the bid cap). */
export function parseBidPrefill(search: string): BidPrefill | null {
  const q = new URLSearchParams(search);
  const lots = q.getAll('lot');
  const bids = q.getAll('bid');
  if (lots.length !== 1 || bids.length !== 1 || !LOT.test(lots[0])) return null;
  const m = AMOUNT.exec(bids[0]);
  if (!m) return null;
  const amount = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  if (amount <= 0n || amount > MAX_BID) return null;
  return { lot: Number(lots[0]), amount };
}

/**
 * The amount the confirmation shows: the link's amount when it is at least the current minimum and not more than twice of it, else the current
 * minimum (the room has moved on, or the link is odd: the confirmation then simply shows the current state). `used` says which.
 */
export function prefillAmount(prefill: Pick<BidPrefill, 'amount'>, minNext: bigint): { amount: bigint; used: boolean } {
  const ok = prefill.amount >= minNext && prefill.amount <= minNext * PREFILL_MAX_FACTOR;
  return ok ? { amount: prefill.amount, used: true } : { amount: minNext, used: false };
}

/** The address without `lot` and `bid`, so a reload does not replay the pre-fill. Other parameters and the hash stay. */
export function withoutPrefill(pathname: string, search: string, hash: string): string {
  const q = new URLSearchParams(search);
  q.delete('lot');
  q.delete('bid');
  const rest = q.toString();
  return `${pathname}${rest ? `?${rest}` : ''}${hash}`;
}
