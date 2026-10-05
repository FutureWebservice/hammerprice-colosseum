/**
 * Auction-control rules: who may swing the hammer, and what the hammer decides.
 *
 * Pure and dependency-free apart from types, so this is testable without a request context -
 * same pattern as bidding.ts.
 */

export type LotState = 'catalogued' | 'open' | 'sold' | 'passed' | 'withdrawn';

export type CanOpenResult = { ok: true } | { ok: false; reason: string };

/** A show has exactly one lot on the block at a time. */
export function canOpen(params: { lotState: LotState; otherOpenLotExists: boolean }): CanOpenResult {
  if (params.lotState !== 'catalogued') {
    return { ok: false, reason: 'Lot is not catalogued' };
  }
  if (params.otherOpenLotExists) {
    return { ok: false, reason: 'Another lot in this show is already open' };
  }
  return { ok: true };
}

/**
 * What the hammer decides. 'withdrawn' is always whatever the auctioneer explicitly requested
 * - it is a seller decision, not a market outcome, so there is nothing to derive. For
 * 'sold'/'passed' the request is only an intent: the actual outcome is derived from the high
 * bid against the reserve, never trusted from the caller, because a reserve below the winning
 * bid is exactly the case a seller relies on this check to catch.
 */
export function hammerOutcome(params: {
  highBid: bigint | null;
  reserve: bigint | null;
  requested: 'sold' | 'passed' | 'withdrawn';
}): 'sold' | 'passed' | 'withdrawn' {
  if (params.requested === 'withdrawn') return 'withdrawn';
  if (params.highBid == null) return 'passed';
  if (params.reserve == null) return 'sold';
  return params.highBid >= params.reserve ? 'sold' : 'passed';
}

/** OPERATOR_WALLETS: comma-separated wallets that may start and end the HOUSE show. Server-only (no NEXT_PUBLIC_ prefix). */
export function operatorWallets(env: Record<string, string | undefined> = process.env): string[] {
  return (env.OPERATOR_WALLETS ?? '').split(',').map((w) => w.trim()).filter(Boolean);
}

/**
 * Who may run a show: its seller, or (house show only, D17) an operator wallet. A third-party seller's show never
 * has an operator, so no environment variable can grant control over someone else's lot.
 *
 * The client bundle has no OPERATOR_WALLETS, so there this is the seller check alone (the old
 * NEXT_PUBLIC_AUCTIONEER_WALLET override is gone).
 */
export function isAuctioneer(wallet: string, showSellerWallet: string | null, opts: { isHouse?: boolean } = {}): boolean {
  if (showSellerWallet != null && wallet === showSellerWallet) return true;
  return opts.isHouse === true && operatorWallets().includes(wallet);
}
