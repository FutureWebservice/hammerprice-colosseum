/**
 * Funded-paddle reads. `getUsdcBalance` reads the bidder's USDC token account at commitment
 * 'confirmed', treats a missing account as 0, caches for 4 s per (cluster, wallet), and FAILS CLOSED: when every RPC
 * endpoint is down the caller gets ChainError('balance_unavailable') and must not accept a bid on a guess.
 */
import { PublicKey } from '@solana/web3.js';
import type { Cluster } from '@/contracts';
import { resolveCluster, usdcMintFor } from './config';
import { ChainError } from './errors';
import { ataAddress } from './ix';
import { makeRpc, RpcError, type RpcCall } from './rpc';

export const BALANCE_TTL_MS = 4000;
const cache = new Map<string, { at: number; value: bigint }>();
const key = (cluster: Cluster, wallet: string) => `${cluster}:${wallet}`;

/** Called after a faucet mint or a settlement so the next read sees the new balance. */
export function invalidateBalance(wallet?: string, cluster?: Cluster): void {
  if (!wallet) return void cache.clear();
  for (const k of [...cache.keys()]) if (k.endsWith(`:${wallet}`) && (!cluster || k.startsWith(`${cluster}:`))) cache.delete(k);
}

export interface FundsDeps { call?: RpcCall; now?: () => number; usdcMint?: string }

export async function getUsdcBalance(wallet: string, cluster: Cluster = resolveCluster(), deps: FundsDeps = {}): Promise<bigint> {
  const now = (deps.now ?? Date.now)();
  const k = key(cluster, wallet);
  const hit = cache.get(k);
  if (hit && now - hit.at < BALANCE_TTL_MS) return hit.value;
  let ata: string;
  try {
    ata = ataAddress(new PublicKey(deps.usdcMint ?? usdcMintFor(cluster)), new PublicKey(wallet)).toBase58();
  } catch {
    throw new ChainError('validation', 'not a valid wallet address');
  }
  let value: bigint;
  try {
    const r = await (deps.call ?? makeRpc(cluster))<{ value: { amount: string } }>('getTokenAccountBalance', [ata, { commitment: 'confirmed' }]);
    value = BigInt(r.value.amount);
  } catch (e) {
    // "could not find account" is an application answer: the wallet holds no USDC.
    if (e instanceof RpcError && /could not find account/i.test(e.message)) value = 0n;
    else throw new ChainError('balance_unavailable', 'could not read the USDC balance, try again');
  }
  cache.set(k, { at: now, value });
  return value;
}

/** available = balance - what the bidder already leads elsewhere - what they owe on open settlements (never negative). */
export function computeAvailable(a: { balance: bigint; leadingBids: bigint; openSettlements: bigint }): bigint {
  const v = a.balance - a.leadingBids - a.openSettlements;
  return v > 0n ? v : 0n;
}
