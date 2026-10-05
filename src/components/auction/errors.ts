import type { Tr } from './model';

export interface ErrorLike { key: string; wallet?: string; minNext?: string; retryAfterS?: number }

/**
 * The user-facing sentence for an error from the bid, paddle, sign-in or settlement hooks. `t` is bound to the
 * namespace that owns the `errors.*` keys (room or settlement).
 */
export function errorText(t: Tr, err: ErrorLike, usd: (u: string | null | undefined) => string): string {
  if (err.key === 'errors.walletSign') {
    const w = err.wallet ?? 'unknown';
    return t(`errors.wallet${w.charAt(0).toUpperCase()}${w.slice(1)}`);
  }
  if (err.key === 'errors.bid_too_low') return t(err.key, { amount: usd(err.minNext) });
  if (err.key === 'errors.rate_limited') return t(err.key, { seconds: err.retryAfterS ?? 2 });
  return t(err.key);
}
