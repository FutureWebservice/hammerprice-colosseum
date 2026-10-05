/**
 * Bid rules. Pure and dependency-free apart from the lot-state type, so this is testable
 * without a request context.
 *
 * All amounts are bigint USDC base units (6dp). Never floats.
 */

export type LotState = 'catalogued' | 'open' | 'sold' | 'passed' | 'withdrawn';

/** The minimum a new bid must meet: the opening price if nothing has bid yet, else one increment over the high bid. */
export function nextIncrement(highBid: bigint | null, opening: bigint, increment: bigint): bigint {
  return highBid === null ? opening : highBid + increment;
}

export type BidValidation =
  | { ok: true; belowReserve: boolean }
  | { ok: false; reason: string };

export function validateBid(params: {
  amount: bigint;
  highBid: bigint | null;
  opening: bigint;
  increment: bigint;
  lotState: LotState;
  escrowBalance: bigint;
  /** null/undefined = no reserve set, so nothing can be below it. */
  reserve?: bigint | null;
}): BidValidation {
  const { amount, highBid, opening, increment, lotState, escrowBalance, reserve } = params;

  if (lotState !== 'open') return { ok: false, reason: 'Lot is not open for bidding' };

  const min = nextIncrement(highBid, opening, increment);
  if (amount < min) return { ok: false, reason: `Bid must be at least ${min}` };

  if (amount > escrowBalance) return { ok: false, reason: 'Bid exceeds escrow balance' };

  return { ok: true, belowReserve: reserve != null && amount < reserve };
}

export interface BidStanding {
  /** True once `amount` is at or above the reserve, or there is no reserve to clear. */
  clearsReserve: boolean;
  /** How far below the reserve `amount` sits, in base units - null whenever clearsReserve is true. */
  shortfall: bigint | null;
}

/**
 * Where a candidate bid sits relative to the reserve, for display before it's ever submitted
 * (BidPanel's standing sentence and its three-number row). `highBid` isn't used by the
 * comparison itself - it's accepted so a call site can pass the same lot fields it already has
 * without picking them apart first.
 *
 * This mirrors validateBid's `belowReserve` flag but is deliberately standalone: validateBid
 * needs a live lotState/opening/increment/escrowBalance to decide if a bid may even be
 * submitted, while this only ever answers "does this amount clear the limit" for a number the
 * panel is merely showing.
 */
export function bidStanding({ amount, reserve }: { amount: bigint; highBid: bigint | null; reserve?: bigint | null }): BidStanding {
  if (reserve == null || amount >= reserve) return { clearsReserve: true, shortfall: null };
  return { clearsReserve: false, shortfall: reserve - amount };
}

/**
 * Was a thrown insert error the unique-violation on (bidderId, nonce) - i.e. the same signed
 * bid replayed? Postgres error code 23505.
 *
 * drizzle-orm wraps every driver error in its own `DrizzleQueryError`, which never carries
 * `.code` itself - the real, driver-shaped error (the one with `.code`) is nested one level
 * down as `.cause`. Checking only `err.code` never matches, so a replayed bid fell through to
 * an unhandled 500 instead of this route's documented 400. Check both shapes.
 */
export function isDuplicateNonceError(err: unknown): boolean {
  const codeOf = (e: unknown): string | undefined =>
    e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined;

  if (!err || typeof err !== 'object') return false;
  return codeOf(err) === '23505' || codeOf((err as { cause?: unknown }).cause) === '23505';
}
