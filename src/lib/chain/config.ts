/**
 * Cluster, per-cluster USDC mint and RPC list: the building blocks of lib/chain/cluster.ts, which holds the one-switch rule
 * (SOLANA_CLUSTER) and the fail-closed readiness check that guards every money route.
 *
 * Pure: reads an env object you pass in (default process.env), so tests never touch the real environment.
 * A polluted value (whitespace, a trailing `# comment`, quotes) is REFUSED instead of trimmed: a real production
 * value once held "https://host      # Client-safe (no key)" and was inlined into the client bundle as is.
 */
import type { Cluster } from '@/contracts';
import { ConfigError } from './errors';

type Env = Record<string, string | undefined>;

export const CLUSTERS = ['devnet', 'mainnet-beta'] as const;
/** Real USDC on mainnet. On devnet `USDC_MINT` names our own test mint; Circle's devnet mint is only the fallback. */
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CIRCLE_DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const DEFAULT_RPC: Record<Cluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};
/** Collector Crypt's Core collection on mainnet (collector-crypt-onchain.md): the seller's picker lists the cards inside it. */
export const CC_MAINNET_COLLECTION = 'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac';
export const USDC_DECIMALS = 6;
export const DEFAULT_SETTLEMENT_WINDOW_S = 900;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const POLLUTED = /[\s#"'`]/;

/** A value that was pasted with whitespace, a comment or quotes is rejected. Empty/undefined means "not set". */
export function cleanEnv(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (POLLUTED.test(value)) throw new ConfigError(`${name} contains whitespace, a comment or quotes; set a clean value`);
  return value;
}

export function cleanPublicKey(name: string, value: string | undefined): string | undefined {
  const v = cleanEnv(name, value);
  if (v !== undefined && !BASE58.test(v)) throw new ConfigError(`${name} is not a base58 public key`);
  return v;
}

function cleanUrl(name: string, value: string): string {
  let u: URL;
  try { u = new URL(value); } catch { throw new ConfigError(`${name} contains an entry that is not a URL`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new ConfigError(`${name} must use https`);
  return value;
}

const normCluster = (name: string, v: string): Cluster => {
  const c = v === 'mainnet' ? 'mainnet-beta' : v;
  if (c !== 'devnet' && c !== 'mainnet-beta') throw new ConfigError(`${name} must be devnet or mainnet-beta`);
  return c;
};

/** SOLANA_CLUSTER (server) and NEXT_PUBLIC_SOLANA_NETWORK (browser) must agree when both are set. Default devnet. */
export function resolveCluster(env: Env = process.env): Cluster {
  const s = cleanEnv('SOLANA_CLUSTER', env.SOLANA_CLUSTER);
  const p = cleanEnv('NEXT_PUBLIC_SOLANA_NETWORK', env.NEXT_PUBLIC_SOLANA_NETWORK);
  const a = s === undefined ? undefined : normCluster('SOLANA_CLUSTER', s);
  const b = p === undefined ? undefined : normCluster('NEXT_PUBLIC_SOLANA_NETWORK', p);
  if (a && b && a !== b) throw new ConfigError('SOLANA_CLUSTER and NEXT_PUBLIC_SOLANA_NETWORK disagree');
  return a ?? b ?? 'devnet';
}

/** The USDC mint of a cluster. Mainnet is fixed (a configured test mint there is an error, not an override). */
export function usdcMintFor(cluster: Cluster, env: Env = process.env): string {
  const configured = cleanPublicKey('USDC_MINT', env.USDC_MINT);
  if (cluster === 'mainnet-beta') {
    if (configured && configured !== MAINNET_USDC_MINT) throw new ConfigError('USDC_MINT is not the mainnet USDC mint');
    return MAINNET_USDC_MINT;
  }
  return configured ?? CIRCLE_DEVNET_USDC_MINT;
}

/**
 * RPC endpoints in failover order. The configured list (SOLANA_RPC_URL, then SOLANA_RPC_FALLBACK_URLS) applies
 * to the configured cluster only; any other cluster gets its public endpoint.
 */
export function rpcUrlsFor(cluster: Cluster, env: Env = process.env): string[] {
  if (cluster !== resolveCluster(env)) return [DEFAULT_RPC[cluster]];
  const urls: string[] = [];
  const primary = cleanEnv('SOLANA_RPC_URL', env.SOLANA_RPC_URL);
  if (primary) urls.push(cleanUrl('SOLANA_RPC_URL', primary));
  const fb = cleanEnv('SOLANA_RPC_FALLBACK_URLS', env.SOLANA_RPC_FALLBACK_URLS);
  if (fb) for (const u of fb.split(',')) if (u) urls.push(cleanUrl('SOLANA_RPC_FALLBACK_URLS', u));
  urls.push(DEFAULT_RPC[cluster]);
  return [...new Set(urls)];
}

/** DAS needs an indexer endpoint (Helius and friends); the public devnet RPC has none. Unset means "read accounts instead". */
export function dasUrl(env: Env = process.env): string | undefined {
  const u = cleanEnv('DAS_RPC_URL', env.DAS_RPC_URL);
  return u ? cleanUrl('DAS_RPC_URL', u) : undefined;
}

export const feeWalletAddress = (env: Env = process.env): string | undefined =>
  cleanPublicKey('PLATFORM_WALLET_ADDRESS', env.PLATFORM_WALLET_ADDRESS);

/** Seconds buyer and seller have to sign after the hammer. */
export function settlementWindowS(env: Env = process.env): number {
  const v = cleanEnv('SETTLEMENT_WINDOW_S', env.SETTLEMENT_WINDOW_S);
  if (v === undefined) return DEFAULT_SETTLEMENT_WINDOW_S;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 60 || n > 7 * 86400) throw new ConfigError('SETTLEMENT_WINDOW_S must be an integer from 60 to 604800');
  return n;
}

/** Only `platform` is built: SA pays fees and ATA rent. `buyer` (the planned mainnet default) is refused, not silently ignored. */
export function assertFeePayerPlatform(env: Env = process.env): void {
  const v = cleanEnv('FEE_PAYER', env.FEE_PAYER);
  if (v !== undefined && v !== 'platform') throw new ConfigError(`FEE_PAYER=${v} is not built in this release; only "platform" is supported`);
}
