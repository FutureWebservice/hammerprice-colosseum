/**
 * What one SOL is worth in dollars, so a price quoted in USDC can also be shown in SOL.
 *
 * Every amount in this app is USDC base units and stays that way: USDC is what a lot settles in, and money that has to survive
 * arithmetic is stored as an integer, never a float. The SOL figure is a DISPLAY CONVENIENCE, computed at the edge and never fed
 * back into a bid, a reserve or an increment. `null` means "unknown": the UI then shows the USDC price alone.
 *
 * Sources, in order, keyless:
 *  1. Pyth's SOL/USD price account on Solana (read with a plain getAccountInfo, no Hermes, no API key). Accepted only when the
 *     account is owned by the Pyth receiver program, is the SOL/USD feed, is fully verified, was published less than 60 s ago and
 *     its confidence interval is under 1% of the price.
 *  2. Jupiter's keyless lite price API.
 *  3. Coinbase spot.
 * The feed account only exists on mainnet, so this read goes to a mainnet RPC (SOL_PRICE_RPC_URL, default the public endpoint).
 * It reads market data and moves nothing; a mainnet deployment is guarded elsewhere (assertClusterReady).
 */
import { PublicKey } from '@solana/web3.js';
import { cleanEnv } from './chain/config';
import { getAccount, makeRpc } from './chain/rpc';

export const PYTH_SOL_USD_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const PYTH_RECEIVER_PROGRAM = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
export const PYTH_SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Anchor discriminator of PriceUpdateV2. */
const PRICE_UPDATE_V2 = Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]);

export const MAX_STALENESS_S = 60;
export const MAX_CONFIDENCE_RATIO = 0.01;
/** A rate outside these is a broken response, not a market move. */
const MIN_PLAUSIBLE_USD = 1;
const MAX_PLAUSIBLE_USD = 100_000;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 3000;

const plausible = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= MIN_PLAUSIBLE_USD && n <= MAX_PLAUSIBLE_USD;

/**
 * PriceUpdateV2: 8 discriminator, 32 write authority, verification level (Borsh enum: Partial{u8} = 0, Full = 1), then the price
 * message: feed id 32, price i64, conf u64, exponent i32, publish time i64, prev publish time i64, ema price i64, ema conf u64.
 * Returns the price in dollars, or null when anything about the account is not acceptable.
 */
export function decodePythPrice(account: { owner: string; data: Uint8Array } | null, nowS: number): number | null {
  if (!account || account.owner !== PYTH_RECEIVER_PROGRAM) return null;
  const d = Buffer.from(account.data.buffer, account.data.byteOffset, account.data.byteLength);
  if (d.length < 8 + 32 + 1 + 32 + 8 + 8 + 4 + 8 || !d.subarray(0, 8).equals(PRICE_UPDATE_V2)) return null;
  let o = 8 + 32;
  if (d[o] !== 1) return null; // Partial verification: not enough guardian signatures to trust it
  o += 1;
  if (d.subarray(o, o + 32).toString('hex') !== PYTH_SOL_USD_FEED_ID) return null;
  o += 32;
  const price = d.readBigInt64LE(o); o += 8;
  const conf = d.readBigUInt64LE(o); o += 8;
  const expo = d.readInt32LE(o); o += 4;
  const publishS = Number(d.readBigInt64LE(o));
  if (nowS - publishS > MAX_STALENESS_S || publishS - nowS > MAX_STALENESS_S) return null;
  if (price <= 0n || expo < -18 || expo > 0) return null;
  const usd = Number(price) * 10 ** expo;
  if (!plausible(usd) || Number(conf) / Number(price) > MAX_CONFIDENCE_RATIO) return null;
  return usd;
}

type Fetch = typeof fetch;
const getJson = async (f: Fetch, url: string): Promise<unknown> => {
  const res = await f(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const SOL_MINT = 'So11111111111111111111111111111111111111112';
export async function jupiterSolUsd(f: Fetch): Promise<number | null> {
  const body = (await getJson(f, `https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`)) as Record<string, { usdPrice?: unknown }> | null;
  const v = Number(body?.[SOL_MINT]?.usdPrice);
  return plausible(v) ? v : null;
}
export async function coinbaseSolUsd(f: Fetch): Promise<number | null> {
  const body = (await getJson(f, 'https://api.coinbase.com/v2/prices/SOL-USD/spot')) as { data?: { amount?: unknown } } | null;
  const v = Number(body?.data?.amount);
  return plausible(v) ? v : null;
}

export interface SolPriceDeps { fetch?: Fetch; now?: () => number; rpcUrl?: string }

/** The first acceptable source wins. A source that throws or answers nonsense is skipped, never fatal. */
export async function readSolUsd(deps: SolPriceDeps = {}): Promise<{ usd: number; source: 'pyth' | 'jupiter' | 'coinbase' } | null> {
  const f = deps.fetch ?? globalThis.fetch;
  const nowS = (deps.now ?? Date.now)() / 1000;
  const attempts: [('pyth' | 'jupiter' | 'coinbase'), () => Promise<number | null>][] = [
    ['pyth', async () => {
      const url = deps.rpcUrl ?? cleanEnv('SOL_PRICE_RPC_URL', process.env.SOL_PRICE_RPC_URL) ?? 'https://api.mainnet-beta.solana.com';
      new PublicKey(PYTH_SOL_USD_ACCOUNT);
      return decodePythPrice(await getAccount(makeRpc('mainnet-beta', { fetch: f, urls: [url], timeoutMs: TIMEOUT_MS }), PYTH_SOL_USD_ACCOUNT), nowS);
    }],
    ['jupiter', () => jupiterSolUsd(f)],
    ['coinbase', () => coinbaseSolUsd(f)],
  ];
  for (const [source, read] of attempts) {
    try { const usd = await read(); if (usd !== null) return { usd, source }; } catch { /* next source */ }
  }
  return null;
}

let cached: { at: number; usd: number } | null = null;
let reading: Promise<number | null> | null = null;
/** A rate up to this old is still shown while a fresh one is read (it is a display convenience: see the top of this file). */
const STALE_MS = 30 * 60_000;
/** Longest the room page waits for the FIRST read of an instance. A slower source fills the cache for the next page and this one shows USDC alone. */
export const FIRST_READ_BUDGET_MS = 1500;

/** One read at a time per instance, however many pages ask. */
function refresh(): Promise<number | null> {
  reading ??= readSolUsd()
    .then((r) => { if (r) cached = { at: Date.now(), usd: r.usd }; return r?.usd ?? null; })
    .catch(() => null)
    .finally(() => { reading = null; });
  return reading;
}

/**
 * Cached for a minute per server instance, and for up to half an hour as a fallback while a new read runs, so a room page never waits for a price source
 * after the first one (a cold read could take 3 s per source). Returns null when no source is acceptable.
 */
export async function getSolUsd(): Promise<number | null> {
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < CACHE_MS) return cached.usd;
  const read = refresh();
  if (cached && age < STALE_MS) return cached.usd;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), FIRST_READ_BUDGET_MS); });
  try { return await Promise.race([read, budget]); } finally { clearTimeout(timer); }
}
/** Tests only. */
export const clearSolPriceCache = (): void => { cached = null; reading = null; };
