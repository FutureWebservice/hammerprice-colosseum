import { describe, expect, it } from 'vitest';
import {
  assertFeePayerPlatform, CIRCLE_DEVNET_USDC_MINT, cleanEnv, DEFAULT_RPC, MAINNET_USDC_MINT, resolveCluster, rpcUrlsFor, settlementWindowS, usdcMintFor, feeWalletAddress, dasUrl,
} from '../config';
import { ConfigError } from '../errors';
import { explorerAddressUrl, explorerTxUrl } from '../explorer';

const OURS = '3qnQSy72DcCUVAR9PrZe8peDYwxufcf3hR1bVnjuHqjs';

describe('cleanEnv: polluted values are refused, not trimmed', () => {
  it('passes a clean value and treats empty as unset', () => {
    expect(cleanEnv('X', 'https://host.example/path?k=v')).toBe('https://host.example/path?k=v');
    expect(cleanEnv('X', '')).toBeUndefined();
    expect(cleanEnv('X', undefined)).toBeUndefined();
  });
  for (const bad of ['https://host      # Client-safe (no key)', 'https://host ', ' https://host', 'https://host\n', 'devnet # comment', '"devnet"', "'devnet'", 'a#b']) {
    it(`refuses ${JSON.stringify(bad)}`, () => expect(() => cleanEnv('X', bad)).toThrow(ConfigError));
  }
  it('the error names the variable and never echoes the value', () => {
    try { cleanEnv('SOLANA_RPC_URL', 'https://secret-key-123 # x'); } catch (e) { expect(String(e)).toContain('SOLANA_RPC_URL'); expect(String(e)).not.toContain('secret-key-123'); }
  });
});

describe('cluster', () => {
  it('defaults to devnet', () => expect(resolveCluster({})).toBe('devnet'));
  it('reads either variable and normalises "mainnet"', () => {
    expect(resolveCluster({ SOLANA_CLUSTER: 'mainnet-beta' })).toBe('mainnet-beta');
    expect(resolveCluster({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet' })).toBe('mainnet-beta');
  });
  it('refuses unknown names and disagreeing variables', () => {
    expect(() => resolveCluster({ SOLANA_CLUSTER: 'testnet' })).toThrow(ConfigError);
    expect(() => resolveCluster({ SOLANA_CLUSTER: 'devnet', NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' })).toThrow(/disagree/);
    expect(() => resolveCluster({ SOLANA_CLUSTER: 'devnet ' })).toThrow(ConfigError);
  });
});

describe('USDC mint per cluster', () => {
  it('devnet: our test mint when configured, else the Circle devnet mint', () => {
    expect(usdcMintFor('devnet', { USDC_MINT: OURS })).toBe(OURS);
    expect(usdcMintFor('devnet', {})).toBe(CIRCLE_DEVNET_USDC_MINT);
  });
  it('mainnet is fixed; a different configured mint is an error, not an override', () => {
    expect(usdcMintFor('mainnet-beta', {})).toBe(MAINNET_USDC_MINT);
    expect(usdcMintFor('mainnet-beta', { USDC_MINT: MAINNET_USDC_MINT })).toBe(MAINNET_USDC_MINT);
    expect(() => usdcMintFor('mainnet-beta', { USDC_MINT: OURS })).toThrow(ConfigError);
  });
  it('rejects a polluted or non-base58 mint', () => {
    expect(() => usdcMintFor('devnet', { USDC_MINT: `${OURS} # test` })).toThrow(ConfigError);
    expect(() => usdcMintFor('devnet', { USDC_MINT: 'not-a-key' })).toThrow(ConfigError);
  });
});

describe('RPC list', () => {
  it('primary, then fallbacks, then the public default, without duplicates', () => {
    expect(rpcUrlsFor('devnet', { SOLANA_RPC_URL: 'https://a.example', SOLANA_RPC_FALLBACK_URLS: 'https://b.example,https://a.example' })).toEqual(['https://a.example', 'https://b.example', DEFAULT_RPC.devnet]);
    expect(rpcUrlsFor('devnet', {})).toEqual([DEFAULT_RPC.devnet]);
  });
  it('configured URLs belong to the configured cluster only', () => {
    expect(rpcUrlsFor('mainnet-beta', { SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://a.example' })).toEqual([DEFAULT_RPC['mainnet-beta']]);
  });
  it('refuses polluted lists, non-URLs and plain http (except localhost)', () => {
    expect(() => rpcUrlsFor('devnet', { SOLANA_RPC_URL: 'https://a.example # note' })).toThrow(ConfigError);
    expect(() => rpcUrlsFor('devnet', { SOLANA_RPC_FALLBACK_URLS: 'https://a.example, https://b.example' })).toThrow(ConfigError);
    expect(() => rpcUrlsFor('devnet', { SOLANA_RPC_URL: 'nonsense' })).toThrow(ConfigError);
    expect(() => rpcUrlsFor('devnet', { SOLANA_RPC_URL: 'http://rpc.example' })).toThrow(/https/);
    expect(rpcUrlsFor('devnet', { SOLANA_RPC_URL: 'http://127.0.0.1:8899' })[0]).toBe('http://127.0.0.1:8899');
  });
});

describe('the small knobs', () => {
  it('settlement window: default 900, clamped by refusal', () => {
    expect(settlementWindowS({})).toBe(900);
    expect(settlementWindowS({ SETTLEMENT_WINDOW_S: '600' })).toBe(600);
    for (const v of ['59', '604801', 'abc', '1.5']) expect(() => settlementWindowS({ SETTLEMENT_WINDOW_S: v })).toThrow(ConfigError);
  });
  it('FEE_PAYER=buyer is refused, not silently ignored', () => {
    expect(() => assertFeePayerPlatform({})).not.toThrow();
    expect(() => assertFeePayerPlatform({ FEE_PAYER: 'platform' })).not.toThrow();
    expect(() => assertFeePayerPlatform({ FEE_PAYER: 'buyer' })).toThrow(/not built/);
  });
  it('fee wallet and DAS endpoint are validated', () => {
    expect(feeWalletAddress({ PLATFORM_WALLET_ADDRESS: OURS })).toBe(OURS);
    expect(() => feeWalletAddress({ PLATFORM_WALLET_ADDRESS: 'x' })).toThrow(ConfigError);
    expect(dasUrl({})).toBeUndefined();
    expect(dasUrl({ DAS_RPC_URL: 'https://das.example/?k=1' })).toBe('https://das.example/?k=1');
  });
});

describe('explorer URLs', () => {
  it('devnet links carry the cluster parameter, mainnet links do not', () => {
    expect(explorerTxUrl('SIG', 'devnet')).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet');
    expect(explorerTxUrl('SIG', 'mainnet-beta')).toBe('https://explorer.solana.com/tx/SIG');
    expect(explorerAddressUrl('ADDR', 'devnet')).toBe('https://explorer.solana.com/address/ADDR?cluster=devnet');
  });
});
