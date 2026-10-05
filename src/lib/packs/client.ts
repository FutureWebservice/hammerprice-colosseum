/**
 * The browser side of a pack purchase: what a wallet is asked to sign is decoded FROM THE TRANSACTION BYTES (never from the JSON the server
 * sent next to them), compared with what the person agreed to, run through the byte-exact validator, and checked again after the wallet
 * returned it. Any failure stops before or after signing and nothing is posted. The same code serves the buyer and, for a pack with a
 * third-party operator, the operator (`role: 'seller'`). Pure except for what is injected; browser safe.
 */
import type { VersionedTransaction } from '@solana/web3.js';
import { VersionedTransaction as Vtx } from '@solana/web3.js';
import type { PackDeliveryToSign, PackDetailResponse, PackDrawView, PackPayExpected, PackPayment } from '@/contracts';
import { assertPackTx, asSettlement } from '@/lib/chain/pack-tx';
import { assertPayTx, assertServerTx } from '@/lib/chain/pack-pay-tx';
import { WALLET_GUARD_PROGRAMS } from '@/lib/chain/settlement-tx';
import { fromBase64, toBase64 } from '@/lib/client/bidder';
import { ataOf, decodeSettlementTx, reviewSettlement, SettleError, type DecodedSettlement, type ReviewedSettlement, type ReviewProblem } from '@/lib/client/settle';
import type { EarlierDraw, ProofDraw, ProofPool } from './verify';

export interface PackSignDeps {
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  myWallet: string;
  /** The cluster this page serves (NEXT_PUBLIC_SOLANA_NETWORK): a payment for another network is refused. */
  cluster: string | null;
  role: 'buyer' | 'seller';
  /** What the buyer agreed to (the pack price on the page). Null on the operator side. */
  agreedGross?: string | null;
  /** Called with the decoded review before anything is signed (also when it failed), so the screen can show it. */
  onReviewed?: (review: ReviewedSettlement) => void;
}

/** The pay-first payment carries no card (no `asset`); the atomic one does. */
export const isPayFirstPayment = (e: PackPayment['expected']): e is PackPayExpected => !('asset' in e);
/** The operator's delivery of the drawn card (A14): a third-party operator signs it, the buyer never does. */
export const isDeliveryPayment = (e: PackPayment['expected']): e is PackDeliveryToSign => 'kind' in e && e.kind === 'delivery';

/**
 * What the OPERATOR is shown for a delivery, decoded from the bytes: exactly one card moves, from the operator's wallet to the buyer named by the sale, no money
 * moves at all, the fee payer is the settlement authority, and the memo names this sale.
 */
export function reviewDelivery(tx: DecodedSettlement, e: PackDeliveryToSign, ctx: { myWallet: string; cluster: string | null }): ReviewedSettlement {
  const problems = new Set<ReviewProblem>();
  const bad = (p: ReviewProblem) => problems.add(p);
  if (tx.feePayer !== e.feePayer) bad('fee_payer');
  if ([...tx.signers].sort().join() !== [e.feePayer, e.operator].sort().join()) bad('signers');
  if (ctx.cluster && e.cluster !== ctx.cluster) bad('cluster');
  if (e.operator !== ctx.myWallet) bad('not_your_role');
  if (tx.foreign.length > 0) bad('foreign_program');
  if (tx.advancesNonce) bad('shape');
  if (tx.legs.length !== 0) bad('leg_amounts'); // a delivery moves no money
  const c = tx.coreTransfers;
  if (c.length !== 1 || c[0]!.asset !== e.asset || c[0]!.newOwner !== e.buyer || c[0]!.authority !== e.operator) bad('card');
  if (tx.memos.length !== 1 || tx.memos[0] !== e.memo) bad('memo');
  return { ok: problems.size === 0, problems: [...problems], gross: 0n, toSeller: 0n, toFeeWallet: 0n, toRoyalty: 0n, asset: e.asset, buyer: e.buyer, seller: e.operator, memo: tx.memos[0] ?? null, bidLogHash: null };
}

/**
 * What the buyer is shown for a PAY FIRST payment, decoded from the bytes: the price, the part that goes to the operator (the house), the fee, and
 * that there is NO card in it. A card transfer in this transaction is a mismatch (`card`), and so is anything else the buyer did not agree to.
 */
export function reviewPayFirst(tx: DecodedSettlement, e: PackPayExpected, ctx: { myWallet: string; cluster: string | null; agreedGross: string | null }): ReviewedSettlement {
  const problems = new Set<ReviewProblem>();
  const bad = (p: ReviewProblem) => problems.add(p);
  if (tx.feePayer !== e.feePayer) bad('fee_payer');
  if ([...tx.signers].sort().join() !== [e.feePayer, e.buyer].sort().join()) bad('signers');
  if (ctx.cluster && e.cluster !== ctx.cluster) bad('cluster');
  if (e.buyer !== ctx.myWallet) bad('not_your_role');
  if (tx.foreign.length > 0) bad('foreign_program');
  if (tx.advancesNonce) bad('shape');
  const dests = new Map<string, 'operator' | 'fee'>([[ataOf(e.operator, e.usdcMint), 'operator'], [ataOf(e.feeWallet, e.usdcMint), 'fee']]);
  let toOperator = 0n, toFee = 0n;
  for (const leg of tx.legs) {
    if (leg.mint !== e.usdcMint || leg.decimals !== 6) bad('mint');
    if (leg.authority !== e.buyer) bad('leg_authority');
    const who = dests.get(leg.destination);
    if (!who) bad('leg_destination'); else if (who === 'operator') toOperator += leg.amount; else toFee += leg.amount;
  }
  const gross = toOperator + toFee;
  if (gross !== BigInt(e.gross) || toFee !== BigInt(e.platformFee)) bad('leg_amounts');
  if (ctx.agreedGross != null && gross !== BigInt(ctx.agreedGross)) bad('price_mismatch');
  if (tx.coreTransfers.length !== 0) bad('card'); // no card exists yet: any card transfer here is not this purchase
  if (tx.memos.length !== 1 || tx.memos[0] !== e.memo) bad('memo');
  return { ok: problems.size === 0, problems: [...problems], gross, toSeller: toOperator, toFeeWallet: toFee, toRoyalty: 0n, asset: null, buyer: e.buyer, seller: e.operator, memo: tx.memos[0] ?? null, bidLogHash: null };
}

/** decode -> review -> assertPackTx / assertPayTx -> wallet signs -> message unchanged. Returns the signed transaction (base64) to post. */
export async function signPackPayment(payment: PackPayment, deps: PackSignDeps): Promise<{ signedTxBase64: string; review: ReviewedSettlement }> {
  const bytes = fromBase64(payment.txBase64);
  const decoded = decodeSettlementTx(bytes);
  const agreed = deps.role === 'buyer' ? deps.agreedGross ?? null : null;
  const exp = payment.expected;
  let review: ReviewedSettlement;
  let check: () => void = () => undefined;
  if (isDeliveryPayment(exp)) {
    review = reviewDelivery(decoded, exp, { myWallet: deps.myWallet, cluster: deps.cluster });
    const { kind: _kind, cluster: _cluster, ...e } = exp;
    check = () => assertServerTx(bytes, { kind: 'delivery', e }, { tolerated: [...WALLET_GUARD_PROGRAMS] });
  } else if (isPayFirstPayment(exp)) {
    review = reviewPayFirst(decoded, exp, { myWallet: deps.myWallet, cluster: deps.cluster, agreedGross: agreed });
    check = () => assertPayTx(bytes, exp);
  } else {
    review = reviewSettlement(decoded, { expected: asSettlement(exp), role: deps.role, myWallet: deps.myWallet, cluster: deps.cluster, agreedGross: agreed });
    check = () => assertPackTx(bytes, exp);
  }
  deps.onReviewed?.(review);
  if (!review.ok) throw new SettleError('review', { problems: review.problems });
  try {
    check(); // wallet guard instructions (Phantom's Lighthouse) are tolerated here, never on the server
  } catch (cause) {
    throw new SettleError('validator', { cause });
  }
  const original = Vtx.deserialize(bytes);
  let signed: VersionedTransaction;
  try {
    signed = await deps.signTransaction(original);
  } catch (cause) {
    throw new SettleError('wallet', { cause });
  }
  if (toBase64(signed.message.serialize()) !== toBase64(original.message.serialize())) throw new SettleError('wallet_modified');
  return { signedTxBase64: toBase64(signed.serialize()), review };
}

// ---- what the verify page and the reveal need ---------------------------------------------------------------------------------------

type Fetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
const defaultFetch: Fetcher = (url) => fetch(url, { cache: 'no-store' });

export interface ProofBundle {
  draw: PackDrawView;
  detail: PackDetailResponse;
  /** The public log up to this draw, or what could be read of it. */
  earlier: EarlierDraw[];
  pool: ProofPool;
  proofDraw: ProofDraw;
}

export function toProof(detail: PackDetailResponse, draw: PackDrawView): { pool: ProofPool; proofDraw: ProofDraw } {
  const pool: ProofPool = {
    mode: detail.pack.mode, cluster: detail.pack.cluster, price: detail.pack.price, operator: detail.pack.operator.wallet,
    odds: detail.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })),
    cards: [...detail.cards].sort((a, b) => a.position - b.position).map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })),
    poolHash: detail.pack.commitment.poolHash ?? '',
    removed: detail.cards.filter((c) => c.status === 'removed').map((c) => c.position),
  };
  const proofDraw: ProofDraw = {
    id: draw.id, packId: draw.packId, drawIndex: draw.drawIndex, flow: draw.flow ?? 'atomic', buyer: draw.buyer, clientSeed: draw.clientSeed, poolHash: draw.poolHash, status: draw.status, tier: draw.tier, cardAsset: draw.card?.asset ?? null,
    vrf: {
      requestId: draw.vrf.requestId, input: draw.vrf.input, proofHex: draw.vrf.proofHex, outputHex: draw.vrf.outputHex, params: draw.vrf.params ?? null, paramsHash: draw.vrf.paramsHash ?? null,
      beacon: draw.vrf.beacon ?? null, publicKey: draw.vrf.publicKey ?? null,
    },
  };
  return { pool, proofDraw };
}

/** The draw, its pack with the whole pool, and the public log of the draws before it (pages of 100, at most ten pages). Null when something is missing. */
export async function fetchProofBundle(drawId: string, fetcher: Fetcher = defaultFetch): Promise<ProofBundle | null> {
  const get = async <T,>(url: string): Promise<T | null> => { const r = await fetcher(url); return r.ok ? ((await r.json()) as T) : null; };
  const draw = await get<PackDrawView>(`/api/packs/draws/${encodeURIComponent(drawId)}`);
  if (!draw) return null;
  const detail = await get<PackDetailResponse>(`/api/packs/${encodeURIComponent(draw.packId)}`);
  if (!detail) return null;
  const earlier: EarlierDraw[] = [];
  let cursor: string | null = draw.drawIndex === null ? null : String(draw.drawIndex);
  for (let page = 0; page < 10 && cursor !== null && (draw.drawIndex ?? 0) > 0; page++) {
    const log: { draws: PackDrawView[]; nextCursor: string | null } | null = await get(`/api/packs/${encodeURIComponent(draw.packId)}/draws?limit=100&cursor=${cursor}`);
    if (!log) break;
    for (const d of log.draws) if (d.drawIndex !== null) earlier.push({ drawIndex: d.drawIndex, status: d.status, cardAsset: d.card?.asset ?? null, paymentSlot: d.paymentSlot ?? (d.vrf.params as { payment?: { slot?: number } } | null | undefined)?.payment?.slot ?? null, paymentSignature: d.txSignature ?? null });
    cursor = log.nextCursor;
  }
  return { draw, detail, earlier, ...(() => { const p = toProof(detail, draw); return { pool: p.pool, proofDraw: p.proofDraw }; })() };
}
