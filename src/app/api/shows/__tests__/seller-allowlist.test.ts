import { describe, expect, it } from 'vitest';
import { assertSellerAllowed, describeSellerAccess } from '../seller-allowlist';

const W = 'So11111111111111111111111111111111111111112';
const refused = (wallet: string, env: Record<string, string | undefined>) => { try { assertSellerAllowed(wallet, env); return false; } catch (e) { return (e as { code?: string }).code === 'seller_not_allowed'; } };

describe('seller allowlist', () => {
  it('devnet: an empty list lets any signed-in wallet sell test cards', () => {
    expect(refused(W, { SOLANA_CLUSTER: 'devnet' })).toBe(false);
    expect(refused(W, {})).toBe(false);
  });
  it('SEC: mainnet with no list is closed, not open', () => {
    expect(refused(W, { SOLANA_CLUSTER: 'mainnet-beta' })).toBe(true);
    expect(refused(W, { NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta', SELLER_ALLOWLIST: ' , ' })).toBe(true);
  });
  it('`*` is the explicit open policy: any wallet may sell, on either cluster', () => {
    for (const SOLANA_CLUSTER of ['devnet', 'mainnet-beta']) expect(refused('someoneElse', { SOLANA_CLUSTER, SELLER_ALLOWLIST: '*' })).toBe(false);
    expect(refused('someoneElse', { SOLANA_CLUSTER: 'mainnet-beta', SELLER_ALLOWLIST: `${W}, *` })).toBe(false);
  });
  it('a list admits exactly the wallets on it, on either cluster', () => {
    for (const SOLANA_CLUSTER of ['devnet', 'mainnet-beta']) {
      expect(refused(W, { SOLANA_CLUSTER, SELLER_ALLOWLIST: ` ${W} , other ` })).toBe(false);
      expect(refused('someoneElse', { SOLANA_CLUSTER, SELLER_ALLOWLIST: W })).toBe(true);
    }
  });

  it('the screen state (describeSellerAccess) always agrees with the API refusal', () => {
    for (const SOLANA_CLUSTER of ['devnet', 'mainnet-beta']) {
      for (const SELLER_ALLOWLIST of [undefined, '', '*', W, `${W},other`]) {
        for (const wallet of [W, 'someoneElse']) {
          const env = { SOLANA_CLUSTER, SELLER_ALLOWLIST };
          expect(describeSellerAccess(wallet, env).allowed, JSON.stringify({ env, wallet })).toBe(!refused(wallet, env));
        }
      }
    }
    expect(describeSellerAccess(null, { SOLANA_CLUSTER: 'devnet' })).toEqual({ mode: 'open', allowed: null });
    expect(describeSellerAccess(null, { SOLANA_CLUSTER: 'mainnet-beta' })).toEqual({ mode: 'closed', allowed: null });
    expect(describeSellerAccess(W, { SOLANA_CLUSTER: 'mainnet-beta', SELLER_ALLOWLIST: 'x' })).toEqual({ mode: 'invited', allowed: false });
  });
});
