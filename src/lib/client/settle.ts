/**
 * The client side of a co-signed settlement.
 *
 * Buyer and seller each sign the SAME unsigned message. Before a wallet is asked to sign, this module
 *   1. decodes price, fee, parties and the card transfer FROM THE TRANSACTION BYTES (never from the JSON the
 *      server sent next to them) and compares them with what the viewer agreed to (`reviewSettlement`),
 *   2. runs CHAIN's byte-exact `assertSettlementTx` (injected, see `signRound`),
 *   3. checks that the wallet did not alter the message it signed.
 * Any failure stops before or after signing and nothing is posted.
 *
 * Pure except for what is injected; tested in node with locally built transactions.
 */
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  type AssertSettlementTx, type ExpectedSettlement, type PartyRole, type PreparedSettlement, type SettlementView, type SignResult,
} from '@/contracts';
import { fromBase64, toBase64 } from './bidder';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// ---------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------

export interface DecodedLeg { mint: string; amount: bigint; decimals: number; authority: string; destination: string }
export interface DecodedCoreTransfer { asset: string; payer: string; authority: string; newOwner: string }
export interface DecodedSettlement {
  feePayer: string;
  signers: string[];
  legs: DecodedLeg[];
  coreTransfers: DecodedCoreTransfer[];
  memos: string[];
  /** System advanceNonce as the first instruction (durable-nonce lifetime). */
  advancesNonce: boolean;
  /**
   * Anything a settlement must not contain: a program outside the allow-list, or an instruction of an allowed
   * program that is not the one expected (a token Approve or SetAuthority, a Core burn, a system transfer).
   */
  foreign: string[];
}

/** Legacy or v0 message; only static accounts are read, which is all a settlement uses. */
export function decodeSettlementTx(bytes: Uint8Array): DecodedSettlement {
  const msg = VersionedTransaction.deserialize(bytes).message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const out: DecodedSettlement = {
    feePayer: keys[0] ?? '',
    signers: keys.slice(0, msg.header.numRequiredSignatures),
    legs: [], coreTransfers: [], memos: [], advancesNonce: false, foreign: [],
  };
  msg.compiledInstructions.forEach((ix, n) => {
    const program = keys[ix.programIdIndex]!;
    const acc = ix.accountKeyIndexes.map((i) => keys[i]!);
    const data = ix.data;
    if (program === TOKEN_PROGRAM && data[0] === 12 && data.length === 10) {
      // TransferChecked: [source, mint, destination, authority], data = 12, u64 amount LE, u8 decimals
      out.legs.push({
        mint: acc[1]!, destination: acc[2]!, authority: acc[3]!, decimals: data[9]!,
        amount: new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true),
      });
    } else if (program === CORE_PROGRAM && data[0] === 14) {
      // Core TransferV1: [asset, collection, payer, authority, newOwner, system, logWrapper]
      out.coreTransfers.push({ asset: acc[0]!, payer: acc[2]!, authority: acc[3]!, newOwner: acc[4]! });
    } else if (program === MEMO_PROGRAM) {
      out.memos.push(new TextDecoder().decode(data));
    } else if (program === COMPUTE_BUDGET) {
      // priority fee and unit limit are paid by the fee payer, which is not the viewer
    } else if (program === ATA_PROGRAM && (data.length === 0 || data[0] === 0 || data[0] === 1)) {
      // create / create idempotent (payer is the settlement authority)
    } else if (program === SYSTEM_PROGRAM && n === 0 && data.length === 4 && data[0] === 4) {
      out.advancesNonce = true;
    } else {
      out.foreign.push(`${program}:${data[0] ?? ''}`);
    }
  });
  return out;
}

/** Associated token account of `owner` for `mint`. */
export function ataOf(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}

// ---------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------

export type ReviewProblem =
  | 'fee_payer' | 'signers' | 'cluster' | 'not_your_role' | 'foreign_program' | 'mint' | 'leg_authority' | 'leg_destination'
  | 'leg_amounts' | 'gross' | 'price_mismatch' | 'card' | 'memo' | 'shape';

export interface ReviewContext {
  expected: ExpectedSettlement;
  role: PartyRole;
  myWallet: string;
  /** The cluster of the show (snapshot.show.cluster). */
  cluster: string | null;
  /** What the buyer agreed to: the lot's final high bid from the public snapshot. Null when unknown (seller side). */
  agreedGross?: string | null;
}

export interface ReviewedSettlement {
  ok: boolean;
  problems: ReviewProblem[];
  /** All figures below come from the transaction bytes. */
  gross: bigint;
  toSeller: bigint;
  toFeeWallet: bigint;
  toRoyalty: bigint;
  asset: string | null;
  buyer: string | null;
  seller: string | null;
  memo: string | null;
  bidLogHash: string | null;
}

export function reviewSettlement(tx: DecodedSettlement, ctx: ReviewContext): ReviewedSettlement {
  const { expected: e } = ctx;
  const problems = new Set<ReviewProblem>();
  const bad = (p: ReviewProblem) => problems.add(p);

  if (tx.feePayer !== e.feePayer) bad('fee_payer');
  if ([...tx.signers].sort().join() !== [e.feePayer, e.buyer, e.seller].sort().join()) bad('signers');
  if (ctx.cluster && e.cluster !== ctx.cluster) bad('cluster');
  if ((ctx.role === 'buyer' ? e.buyer : e.seller) !== ctx.myWallet) bad('not_your_role');
  if (tx.foreign.length > 0) bad('foreign_program');
  if (tx.advancesNonce !== (e.lifetime === 'nonce')) bad('shape');

  const dests = new Map<string, 'seller' | 'fee' | 'royalty'>([
    [ataOf(e.seller, e.usdcMint), 'seller'], [ataOf(e.feeWallet, e.usdcMint), 'fee'],
  ]);
  if (e.royaltyRecipient) dests.set(ataOf(e.royaltyRecipient, e.usdcMint), 'royalty');
  let toSeller = 0n, toFee = 0n, toRoyalty = 0n;
  for (const leg of tx.legs) {
    if (leg.mint !== e.usdcMint || leg.decimals !== 6) bad('mint');
    if (leg.authority !== e.buyer) bad('leg_authority');
    const who = dests.get(leg.destination);
    if (!who) bad('leg_destination');
    else if (who === 'seller') toSeller += leg.amount;
    else if (who === 'fee') toFee += leg.amount;
    else toRoyalty += leg.amount;
  }
  const gross = toSeller + toFee + toRoyalty;
  if (gross !== BigInt(e.gross) || toFee !== BigInt(e.platformFee) || toRoyalty !== BigInt(e.royalty)) bad('leg_amounts');
  if (ctx.agreedGross != null && gross !== BigInt(ctx.agreedGross)) bad('price_mismatch');
  if (ctx.agreedGross == null && gross !== BigInt(e.gross)) bad('gross');

  const core = tx.coreTransfers;
  if (core.length !== 1 || core[0]!.asset !== e.asset || core[0]!.newOwner !== e.buyer || core[0]!.authority !== e.seller) bad('card');
  if (tx.memos.length !== 1 || tx.memos[0] !== e.memo) bad('memo');

  const memo = tx.memos[0] ?? null;
  return {
    ok: problems.size === 0,
    problems: [...problems],
    gross, toSeller, toFeeWallet: toFee, toRoyalty,
    asset: core[0]?.asset ?? null,
    buyer: core[0]?.newOwner ?? null,
    seller: core[0]?.authority ?? null,
    memo,
    bidLogHash: memo ? (/^hp:settle:[0-9a-f-]{36}:([0-9a-f]{64})$/.exec(memo)?.[1] ?? null) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Round state (what both parties' screens say)
// ---------------------------------------------------------------------------------------------

export type RoundState =
  | { kind: 'idle' }
  | { kind: 'sign_now'; secondsLeft: number }
  | { kind: 'waiting'; on: PartyRole; secondsLeft: number }
  | { kind: 'submitted' }
  | { kind: 'settled' }
  | { kind: 'expired' }
  | { kind: 'failed' };

/** `nowMs` is the server clock estimate (clock.ts). */
export function roundState(v: SettlementView, nowMs: number): RoundState {
  if (v.status === 'settled') return { kind: 'settled' };
  if (v.status === 'submitted') return { kind: 'submitted' };
  if (v.status === 'failed') return { kind: 'failed' };
  if (v.status === 'expired' || Date.parse(v.dueAt) <= nowMs) return { kind: 'expired' };
  const left = v.roundExpiresAt ? Date.parse(v.roundExpiresAt) - nowMs : 0;
  if (left <= 0 || !v.role) return { kind: 'idle' };
  const secondsLeft = Math.ceil(left / 1000);
  const mySigned = v.role === 'buyer' ? v.buyerSigned : v.sellerSigned;
  if (!mySigned) return { kind: 'sign_now', secondsLeft };
  return { kind: 'waiting', on: v.role === 'buyer' ? 'seller' : 'buyer', secondsLeft };
}

/** Poll cadence for GET /api/settlements/:id: 2 s while a round is open, 4 s otherwise, never once it is over. */
export function settlementDelayMs(v: SettlementView | null, nowMs: number): number | null {
  if (!v) return 2_000;
  const s = roundState(v, nowMs);
  if (isTerminal(s)) return null;
  return s.kind === 'sign_now' || s.kind === 'waiting' || s.kind === 'submitted' ? 2_000 : 4_000;
}

/**
 * What the pay sheet shows and offers, from the round state and what the wallet is doing right now.
 * `stage` is set by the hook while a run is in flight: 'preparing' until the server has opened the round, then 'wallet'.
 * `asked` is true once this sheet has started a run; a round that is closed again after that has run out unsigned.
 */
export type PayStep = 'loading' | 'start' | 'preparing' | 'confirm' | 'wait' | 'retry' | 'lapsed' | 'done';
export function payStep(i: { state: RoundState | null; stage: 'preparing' | 'wallet' | null; failed: boolean; asked: boolean }): PayStep {
  const { state: s, stage } = i;
  if (!s) return 'loading';
  if (s.kind === 'settled' || s.kind === 'expired' || s.kind === 'failed') return 'done';
  if (s.kind === 'waiting' || s.kind === 'submitted') return 'wait';
  if (stage === 'preparing') return 'preparing';
  if (stage === 'wallet') return s.kind === 'sign_now' ? 'confirm' : 'lapsed';
  if (i.failed) return 'retry';
  if (s.kind === 'idle' && i.asked) return 'lapsed';
  return 'start';
}

export const isTerminal = (s: RoundState): boolean => s.kind === 'settled' || s.kind === 'expired' || s.kind === 'failed';

// Moved to ./explorer.ts so the room's win dialog can show a link without carrying the transaction code (web3.js) that this file needs.
export { explorerTxUrl } from './explorer';

// ---------------------------------------------------------------------------------------------
// The signing round
// ---------------------------------------------------------------------------------------------

export type SettleFailureKind = 'review' | 'validator' | 'wallet' | 'wallet_modified' | 'api';

export class SettleError extends Error {
  constructor(readonly kind: SettleFailureKind, readonly detail?: { problems?: ReviewProblem[]; cause?: unknown; api?: unknown }) {
    super(kind);
    this.name = 'SettleError';
  }
}

export interface SignRoundDeps {
  prepare: () => Promise<PreparedSettlement>;
  /** CHAIN's validator (src/lib/chain/settlement-tx); see src/hooks/room/chainPort.ts. */
  assertTx: AssertSettlementTx;
  /** The wallet adapter's signTransaction. */
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  post: (signedTxBase64: string) => Promise<SignResult>;
  /** Called with the decoded review before anything is signed (also when the review failed), so the screen can show it. */
  onReviewed?: (review: ReviewedSettlement, prepared: PreparedSettlement) => void;
}

/** prepare -> review (decoded from bytes) -> assertSettlementTx -> wallet signs -> message unchanged -> post. */
export async function signRound(deps: SignRoundDeps, ctx: Omit<ReviewContext, 'expected'>): Promise<{ result: SignResult; review: ReviewedSettlement; prepared: PreparedSettlement }> {
  let prepared: PreparedSettlement;
  try {
    prepared = await deps.prepare();
  } catch (api) {
    throw new SettleError('api', { api });
  }
  const bytes = fromBase64(prepared.txBase64);

  const review = reviewSettlement(decodeSettlementTx(bytes), { ...ctx, expected: prepared.expected });
  deps.onReviewed?.(review, prepared);
  if (!review.ok) throw new SettleError('review', { problems: review.problems });

  try {
    deps.assertTx(bytes, prepared.expected);
  } catch (cause) {
    throw new SettleError('validator', { cause });
  }

  const original = VersionedTransaction.deserialize(bytes);
  let signed: VersionedTransaction;
  try {
    signed = await deps.signTransaction(original);
  } catch (cause) {
    throw new SettleError('wallet', { cause });
  }
  if (toBase64(signed.message.serialize()) !== toBase64(original.message.serialize())) throw new SettleError('wallet_modified');

  try {
    return { result: await deps.post(toBase64(signed.serialize())), review, prepared };
  } catch (api) {
    if (api instanceof SettleError) throw api;
    throw new SettleError('api', { api });
  }
}

// ---------------------------------------------------------------------------------------------
// /verify/[lotId]: recompute the bid-log hash from public bid data
// ---------------------------------------------------------------------------------------------

export interface PublicBid {
  id: string;
  amount: string;
  placedAt: string;
  paddle: number | null;
  /** The signed intent text and signature exactly as stored. */
  message: string;
  signature: string;
  signer: 'wallet' | 'session';
  /** Base58 public key that must verify the signature: the bidder's wallet, or the paddle's session key. */
  signerPubkey: string;
}

/** sha256 over "<message>|<signature>" of the accepted bids, joined by newline, ordered by (placed_at, id). */
export async function bidLogHash(bids: readonly PublicBid[]): Promise<string> {
  const ordered = [...bids].sort((a, b) => Date.parse(a.placedAt) - Date.parse(b.placedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const text = ordered.map((b) => `${b.message}|${b.signature}`).join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

export type BidCheck = 'valid' | 'bad_signature' | 'mismatch';

/** One bid: the signature verifies against its public key, and the signed text says what the row says. */
export function checkBid(bid: PublicBid, lotId: string, verifySig: (msg: Uint8Array, sig: Uint8Array, pub: Uint8Array) => boolean, decodePub: (b58: string) => Uint8Array): BidCheck {
  let ok = false;
  try {
    ok = verifySig(new TextEncoder().encode(bid.message), fromBase64(bid.signature), decodePub(bid.signerPubkey));
  } catch {
    ok = false;
  }
  if (!ok) return 'bad_signature';
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(bid.message)?.[1];
  return bid.message.startsWith('hammerprice bid v1\n') && field('lot') === lotId && field('amount') === bid.amount ? 'valid' : 'mismatch';
}
