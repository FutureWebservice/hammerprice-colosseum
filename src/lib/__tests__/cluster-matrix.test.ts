import { describe, it, expect } from 'vitest';
import { MAINNET_USDC_MINT, assertFeePayerPlatform, feeWalletAddress, resolveCluster, rpcUrlsFor, usdcMintFor } from '@/lib/chain/config';
import { ConfigError } from '@/lib/chain/errors';
import { DEVNET_ENV, MAINNET_ENV } from './fixtures/envs';

// Scaffold of the cluster matrix: the same assertions against BOTH configs. Feature packages add their rows (402 network,
// explorer link, VRF cluster line, text switch) as they land. Nothing here contacts a network.
describe.each([
  ['devnet', DEVNET_ENV],
  ['mainnet-beta', MAINNET_ENV],
] as const)('cluster matrix: %s', (cluster, env) => {
  it('resolves the cluster from the one switch', () => expect(resolveCluster(env)).toBe(cluster));

  it('picks the USDC mint of the cluster and never the other one', () => {
    const mint = usdcMintFor(cluster, env);
    if (cluster === 'mainnet-beta') expect(mint).toBe(MAINNET_USDC_MINT);
    else expect(mint).not.toBe(MAINNET_USDC_MINT);
  });

  it('puts the configured RPC first and keeps a same-cluster public fallback', () => {
    const urls = rpcUrlsFor(cluster, env);
    expect(urls[0]).toBe(env.SOLANA_RPC_URL);
    expect(urls.join(',')).toContain(cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet');
    expect(urls.join(',')).not.toContain(cluster === 'mainnet-beta' ? 'devnet' : 'mainnet');
  });

  it('reads the fee wallet and keeps the platform fee payer', () => {
    expect(feeWalletAddress(env)).toBe(env.PLATFORM_WALLET_ADDRESS);
    expect(() => assertFeePayerPlatform(env)).not.toThrow();
  });
});

describe('cluster matrix: no fallback to the other cluster', () => {
  it('refuses a devnet USDC mint on mainnet', () => {
    expect(() => usdcMintFor('mainnet-beta', { ...MAINNET_ENV, USDC_MINT: DEVNET_ENV.USDC_MINT })).toThrow(ConfigError);
  });
  it('refuses a server and a browser network that disagree', () => {
    expect(() => resolveCluster({ ...MAINNET_ENV, NEXT_PUBLIC_SOLANA_NETWORK: 'devnet' })).toThrow(ConfigError);
  });
  it('uses the public endpoint of the OTHER cluster, never the configured one', () => {
    expect(rpcUrlsFor('devnet', MAINNET_ENV)).toEqual(['https://api.devnet.solana.com']);
    expect(rpcUrlsFor('mainnet-beta', DEVNET_ENV)).toEqual(['https://api.mainnet-beta.solana.com']);
  });
});
