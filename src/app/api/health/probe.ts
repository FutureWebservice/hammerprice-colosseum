/**
 * The chain half of /api/health (a block-height call and the settlement authority's balance), remembered per instance for 30 s
 * and a failure for 10 s. The route is public and unauthenticated: without this every hit, or every hit with a fresh query
 * string, would spend two calls of the RPC budget. The balance is floored to 0.1 SOL: enough for "is it funded", too coarse
 * to read a spend rate off it.
 */
import type { Cluster } from '@/contracts';

const LAMPORTS_PER_SOL = 1_000_000_000;
export const PROBE_TTL_MS = 30_000;
export const PROBE_FAIL_TTL_MS = 10_000;

export interface ChainProbe { ms: number; sol: number | null }
let memo: { at: number; ttl: number; value: ChainProbe } | null = null;
let inflight: Promise<ChainProbe> | null = null; // concurrent callers share one probe

/** Tests only. */
export const clearHealthMemo = (): void => { memo = null; inflight = null; };

export const coarseSol = (lamports: number): number => Math.floor((lamports / LAMPORTS_PER_SOL) * 10 + 1e-9) / 10;

export function chainProbe(cluster: Cluster, now = Date.now()): Promise<ChainProbe> {
  if (memo && now - memo.at < memo.ttl) return Promise.resolve(memo.value);
  return (inflight ??= probe(cluster).finally(() => { inflight = null; }));
}

async function probe(cluster: Cluster): Promise<ChainProbe> {
  const t = performance.now();
  let sol: number | null = null;
  try {
    const { makeRpc, getBlockHeight } = await import('@/lib/chain/rpc');
    const call = makeRpc(cluster);
    await getBlockHeight(call);
    const { settlementAuthority } = await import('@/lib/chain/keys');
    const r = await call<{ value: number }>('getBalance', [settlementAuthority().publicKey.toBase58(), { commitment: 'confirmed' }]);
    sol = coarseSol(r.value);
  } catch { /* degraded: the route reports sol null */ }
  const value = { ms: Math.round(performance.now() - t), sol };
  memo = { at: Date.now(), ttl: sol === null ? PROBE_FAIL_TTL_MS : PROBE_TTL_MS, value };
  return value;
}
