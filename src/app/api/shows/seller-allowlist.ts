import { ApiError } from '@/contracts';
import { resolveCluster } from '@/lib/chain/config';

/**
 * SELLER_ALLOWLIST: comma-separated wallets allowed to create shows. Empty means any signed-in wallet on devnet (test cards, test money),
 * and NOBODY on mainnet: opening real sales to every wallet must be a decision somebody writes down, not what an unset variable does.
 * `*` is that decision made explicitly: any signed-in wallet may sell, on either cluster.
 */
export function assertSellerAllowed(wallet: string, env: Record<string, string | undefined> = process.env): void {
  const allow = (env.SELLER_ALLOWLIST ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  if (allow.length === 0 && resolveCluster(env) === 'mainnet-beta') throw new ApiError('seller_not_allowed', 'Selling on mainnet is by invitation for now');
  if (allow.includes('*')) return;
  if (allow.length > 0 && !allow.includes(wallet)) throw new ApiError('seller_not_allowed', 'This wallet is not allowed to create shows yet');
}

/**
 * What the sell and pack screens may say about who can sell, from the SAME rules as assertSellerAllowed (one function decides both, so the screen never promises
 * what the API refuses). `open`: any signed-in wallet may (devnet with no list, or `*`); `invited`: a list names the wallets; `closed`: mainnet with no list.
 * `allowed` is the answer for `wallet` (null without a wallet).
 */
export type SellerAccess = { mode: 'open' | 'invited' | 'closed'; allowed: boolean | null };
export function describeSellerAccess(wallet: string | null, env: Record<string, string | undefined> = process.env): SellerAccess {
  const allow = (env.SELLER_ALLOWLIST ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  const mode = allow.includes('*') || (allow.length === 0 && resolveCluster(env) !== 'mainnet-beta') ? 'open' : allow.length === 0 ? 'closed' : 'invited';
  return { mode, allowed: wallet === null ? null : mode === 'open' ? true : mode === 'closed' ? false : allow.includes(wallet) };
}
