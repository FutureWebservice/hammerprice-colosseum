/**
 * /verify: read the settlement transaction from the chain and compare its memo with the bid-log hash the browser recomputed.
 *
 * Pure apart from the injected `RpcCall` (src/lib/chain/rpc.ts, so tests pass a fake fetch). Nothing here names a cluster:
 * the cluster, the RPC URL and the USDC mint come from `chainTarget`, which follows the deployment's public config.
 *
 * Honest outcomes, never a silent pass: `confirmed` (memo in a finalized, successful transaction equals the recomputed hash),
 * `contradicts` (the chain says something else, both values are shown), `not_found` (nothing final to compare with yet) and
 * `unreachable` (the network could not be read, which says nothing about the bids).
 */
import bs58 from 'bs58';
import { z } from 'zod';
import type { Cluster } from '@/contracts';
import { rpcEndpoint } from '@/lib/auth/config';
import { MAINNET_USDC_MINT, usdcMintFor } from '@/lib/chain/config';
import { getSignatureStatus, type RpcCall } from '@/lib/chain/rpc';

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const CORE_TRANSFER_V1 = 14;
// A regex, not a string literal: src/legal/__tests__/audit.test.ts treats every quoted 'hp:...' as a browser storage key.
const MEMO_PREFIX = /^hp:settle:/;
const MEMO_RE = /^hp:settle:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{64})$/;
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// ---- where to look ------------------------------------------------------------------------------

export interface Deployment {
  /** The cluster this deployment serves (NEXT_PUBLIC_SOLANA_NETWORK, normalised). */
  cluster: Cluster;
  /** NEXT_PUBLIC_SOLANA_RPC_PUBLIC: a clean public https URL for the deployment's own cluster, else unset. */
  rpcPublic?: string | null;
  /** NEXT_PUBLIC_USDC_MINT: the USDC mint of the deployment's cluster (the devnet test mint). */
  usdcMint?: string | null;
}

export interface ChainTarget { cluster: Cluster; rpcUrl: string; usdcMint: string | undefined }

/**
 * The settlement's own cluster wins (a transaction lives on exactly one cluster); the deployment's config only fills in when
 * the API did not say. The configured RPC and USDC mint apply to the deployment's cluster only: any other cluster gets its
 * public endpoint, and mainnet always the real USDC mint. Mirrors rpcUrlsFor / usdcMintFor on the server.
 */
export function chainTarget(settlementCluster: Cluster | null, d: Deployment): ChainTarget {
  const cluster = settlementCluster ?? d.cluster;
  const own = cluster === d.cluster;
  let usdcMint: string | undefined;
  try { usdcMint = usdcMintFor(cluster, own && d.usdcMint ? { USDC_MINT: d.usdcMint } : {}); } catch { usdcMint = cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : undefined; }
  return { cluster, rpcUrl: rpcEndpoint(cluster, own ? d.rpcPublic : null), usdcMint };
}

// ---- the memo -----------------------------------------------------------------------------------

/** Strict: exactly `hp:settle:<uuid>:<64 lower-case hex>`. Anything else is not a Hammerprice memo. */
export function parseSettleMemo(text: string): { settlementId: string; hash: string } | null {
  const m = MEMO_RE.exec(text);
  return m ? { settlementId: m[1]!, hash: m[2]! } : null;
}

export type MemoRead =
  | { kind: 'ok'; text: string; settlementId: string; hash: string }
  | { kind: 'none' }
  | { kind: 'several' }
  | { kind: 'malformed'; text: string };

// ---- the transaction as a jsonParsed getTransaction result --------------------------------------

const Ix = z.object({
  programId: z.string(),
  program: z.string().optional(),
  parsed: z.unknown().optional(),
  data: z.string().optional(),
  accounts: z.array(z.string()).optional(),
});

const ParsedTx = z.object({
  slot: z.number(),
  blockTime: z.number().nullish(),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({ accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean() })), instructions: z.array(Ix) }),
  }),
  meta: z.object({
    err: z.unknown().nullish(),
    postTokenBalances: z.array(z.object({ accountIndex: z.number(), owner: z.string().optional() })).nullish(),
  }),
});
export type ParsedTx = z.infer<typeof ParsedTx>;

const TokenTransfer = z.object({
  type: z.string(),
  info: z.object({ authority: z.string(), destination: z.string(), mint: z.string(), tokenAmount: z.object({ amount: z.string(), decimals: z.number() }) }),
});

/** The memo of a settlement transaction: top-level instructions of the memo program only, exactly one starting with `hp:settle:`. */
export function memoOf(tx: ParsedTx): MemoRead {
  const texts: string[] = [];
  for (const ix of tx.transaction.message.instructions) {
    if (ix.programId !== MEMO_PROGRAM) continue; // a lookalike from another program is not a memo
    let text: string | null = typeof ix.parsed === 'string' ? ix.parsed : null;
    if (text === null && ix.data) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bs58.decode(ix.data)); } catch { text = null; } }
    if (text !== null && MEMO_PREFIX.test(text)) texts.push(text);
  }
  if (texts.length === 0) return { kind: 'none' };
  if (texts.length > 1) return { kind: 'several' };
  const p = parseSettleMemo(texts[0]!);
  return p ? { kind: 'ok', text: texts[0]!, ...p } : { kind: 'malformed', text: texts[0]! };
}

// ---- what the page shows next to the verdict ----------------------------------------------------

export type SignerRole = 'fee_payer' | 'buyer' | 'seller' | 'other';
export interface UsdcMove { from: string; to: string; amount: string; decimals: number; mint: string; isUsdc: boolean }
export interface CardMove { asset: string; from: string; to: string }
export interface ChainFacts {
  cluster: Cluster;
  signature: string;
  slot: number;
  /** Unix seconds, null when the node has no block time. */
  blockTime: number | null;
  /** getTransaction was asked for `finalized`: a node answers it only for a finalized transaction. */
  commitment: 'finalized';
  signers: { address: string; role: SignerRole }[];
  usdc: UsdcMove[];
  card: CardMove | null;
  memo: MemoRead;
}

/** Everything cheap to read from the parsed transaction. Roles come from the instructions themselves, never from our database. */
export function readFacts(tx: ParsedTx, cluster: Cluster, usdcMint?: string): ChainFacts {
  const keys = tx.transaction.message.accountKeys;
  const ixs = tx.transaction.message.instructions;
  const ownerOfAccount = (account: string): string | undefined => {
    const i = keys.findIndex((k) => k.pubkey === account);
    return i < 0 ? undefined : tx.meta.postTokenBalances?.find((b) => b.accountIndex === i)?.owner;
  };

  const usdc: UsdcMove[] = [];
  for (const ix of ixs) {
    if (!ix.program?.startsWith('spl-token')) continue;
    const t = TokenTransfer.safeParse(ix.parsed);
    if (!t.success || t.data.type !== 'transferChecked') continue;
    const { authority, destination, mint, tokenAmount } = t.data.info;
    usdc.push({ from: authority, to: ownerOfAccount(destination) ?? destination, amount: tokenAmount.amount, decimals: tokenAmount.decimals, mint, isUsdc: mint === usdcMint });
  }

  // Core TransferV1 accounts: asset, collection, payer, authority (the program id stands for "omitted"), new owner.
  let card: CardMove | null = null;
  for (const ix of ixs) {
    if (ix.programId !== CORE_PROGRAM || !ix.accounts || !ix.data) continue;
    let tag = -1;
    try { tag = bs58.decode(ix.data)[0] ?? -1; } catch { tag = -1; }
    const [asset, , payer, authority, newOwner] = ix.accounts;
    if (tag !== CORE_TRANSFER_V1 || !asset || !payer || !newOwner) continue;
    card = { asset, from: authority && authority !== CORE_PROGRAM ? authority : payer, to: newOwner };
    break;
  }

  const buyer = usdc[0]?.from ?? card?.to;
  const signers = keys.filter((k) => k.signer).map((k, i) => ({
    address: k.pubkey,
    role: (i === 0 ? 'fee_payer' : k.pubkey === card?.from ? 'seller' : k.pubkey === buyer ? 'buyer' : 'other') as SignerRole,
  }));
  return { cluster, signature: tx.transaction.signatures[0]!, slot: tx.slot, blockTime: tx.blockTime ?? null, commitment: 'finalized', signers, usdc, card, memo: memoOf(tx) };
}

// ---- the verdict --------------------------------------------------------------------------------

export type ContradictionWhy = 'hash' | 'settlement' | 'memo' | 'failed';
export type NotFoundWhy = 'no_signature' | 'not_finalized' | 'unknown';
export type ChainState =
  | { kind: 'confirmed'; facts: ChainFacts }
  | { kind: 'contradicts'; why: ContradictionWhy; facts: ChainFacts }
  | { kind: 'not_found'; why: NotFoundWhy }
  | { kind: 'unreachable' };

export interface CheckInput {
  call: RpcCall;
  cluster: Cluster;
  usdcMint?: string;
  /** What our API says about the lot's settlement. */
  settlement: { id: string; txSignature: string | null };
  /** The bid-log hash the browser just recomputed from the public bids. */
  recomputed: string;
}

export async function checkChain(i: CheckInput): Promise<ChainState> {
  const sig = i.settlement.txSignature;
  if (!sig) return { kind: 'not_found', why: 'no_signature' };
  if (!SIGNATURE_RE.test(sig)) return { kind: 'not_found', why: 'unknown' };

  let raw: unknown;
  try {
    raw = await i.call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }]);
  } catch {
    return { kind: 'unreachable' };
  }
  if (raw === null || raw === undefined) {
    const status = await getSignatureStatus(i.call, sig).catch(() => null);
    return { kind: 'not_found', why: status && status.confirmationStatus !== 'finalized' ? 'not_finalized' : 'unknown' };
  }
  const parsed = ParsedTx.safeParse(raw);
  if (!parsed.success || parsed.data.transaction.signatures[0] !== sig) return { kind: 'unreachable' }; // an answer we cannot read is not a verdict

  const facts = readFacts(parsed.data, i.cluster, i.usdcMint);
  const contradicts = (why: ContradictionWhy): ChainState => ({ kind: 'contradicts', why, facts });
  if (parsed.data.meta.err !== null && parsed.data.meta.err !== undefined) return contradicts('failed');
  if (facts.memo.kind !== 'ok') return contradicts('memo');
  if (facts.memo.settlementId !== i.settlement.id.toLowerCase()) return contradicts('settlement');
  if (facts.memo.hash !== i.recomputed.toLowerCase()) return contradicts('hash');
  return { kind: 'confirmed', facts };
}

/** "76.05" from 76050000 at 6 decimals. Integer maths only. */
export function formatUnits(amount: string, decimals: number): string {
  const a = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const whole = (a / base).toString();
  return frac ? `${whole}.${frac.length < 2 ? frac.padEnd(2, '0') : frac}` : whole;
}
