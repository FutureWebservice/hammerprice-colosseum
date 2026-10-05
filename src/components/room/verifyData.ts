/**
 * Data for /verify/[lotId]: the public bids of one lot plus the settlement's committed bid-log hash.
 * Known limit: the route is a contract request (GET /api/lots/:id/bids, public, cached); until it lands the page shows
 * its "not available" state. The hash and signature maths live in settle.ts and are tested there.
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { checkBid, bidLogHash, type BidCheck, type PublicBid } from '@/lib/client/settle';
import { makeRpc } from '@/lib/chain/rpc';
import { chainTarget, checkChain, type ChainState, type ChainTarget, type Deployment } from '@/lib/verify/chain';

const PublicBidSchema = z.object({
  id: z.string(),
  amount: z.string(),
  placedAt: z.string(),
  paddle: z.number().int().nullable(),
  message: z.string(),
  signature: z.string(),
  signer: z.enum(['wallet', 'session']),
  signerPubkey: z.string(),
});

export const VerifyData = z.object({
  lot: z.object({ id: z.string(), number: z.number().int(), name: z.string(), showId: z.string(), isHouse: z.boolean().optional() }),
  bids: z.array(PublicBidSchema),
  /** Null when the lot has no settlement (unsold, practice, house stock). */
  settlement: z.object({ id: z.string(), bidLogHash: z.string(), txSignature: z.string().nullable(), cluster: z.string().nullable() }).nullable(),
});
export type VerifyData = z.infer<typeof VerifyData>;

export async function fetchVerifyData(lotId: string, fetchImpl: typeof fetch = fetch): Promise<VerifyData | null> {
  const res = await fetchImpl(`/api/lots/${encodeURIComponent(lotId)}/bids`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const parsed = VerifyData.safeParse(await res.json());
  return parsed.success ? parsed.data : null;
}

const verifySig = (msg: Uint8Array, sig: Uint8Array, pub: Uint8Array) => nacl.sign.detached.verify(msg, sig, pub);

export interface Verified {
  checks: Map<string, BidCheck>;
  recomputed: string;
  /** null when there is no settlement to compare with. */
  match: boolean | null;
}

export async function verifyAll(data: VerifyData): Promise<Verified> {
  const bids: PublicBid[] = data.bids;
  const checks = new Map(bids.map((b) => [b.id, checkBid(b, data.lot.id, verifySig, bs58.decode)] as const));
  const recomputed = await bidLogHash(bids);
  return { checks, recomputed, match: data.settlement ? recomputed === data.settlement.bidLogHash : null };
}

/** Which cluster, RPC and USDC mint the settlement's transaction is read with (the settlement's own cluster, the deployment's config otherwise). */
export function settlementTarget(data: VerifyData, deployment: Deployment): ChainTarget | null {
  if (!data.settlement) return null;
  const c = data.settlement.cluster;
  return chainTarget(c === 'devnet' || c === 'mainnet-beta' ? c : null, deployment);
}

/**
 * Read the settlement's transaction from the chain (the public RPC of its cluster, straight from the browser, not through
 * our server) and compare its memo with the hash recomputed above. Never throws: what cannot be read is `unreachable`.
 * `fetchImpl` is for tests.
 */
export async function verifyOnChain(data: VerifyData, recomputed: string, deployment: Deployment, fetchImpl?: typeof fetch): Promise<ChainState | null> {
  const target = settlementTarget(data, deployment);
  if (!target || !data.settlement) return null;
  const call = makeRpc(target.cluster, { urls: [target.rpcUrl], timeoutMs: 8000, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return checkChain({ call, cluster: target.cluster, usdcMint: target.usdcMint, settlement: data.settlement, recomputed }).catch(() => ({ kind: 'unreachable' as const }));
}
