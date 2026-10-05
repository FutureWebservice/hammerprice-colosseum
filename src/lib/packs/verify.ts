/**
 * "Recompute it yourself" for one pack draw. Pure and browser safe: the cryptographic rules need nothing but the public view of the
 * pack and of the draw; the beacon rule reads one block through a `VrfRpc` and is best effort.
 *
 *   1 pool_hash  the pack definition shown (cards, tiers, odds, price, operator) hashes to the committed pool hash
 *   2 params     the draw parameters (pack, pool hash, buyer, seed, index, taken positions) hash to the committed params hash
 *   3 alpha      the VRF input text is the canonical text for that cluster, the subject derived from pack id and draw index, params hash and beacon
 *   4 proof      the RFC 9381 proof verifies under the VRF public key for that input
 *   5 output     the verified output equals the stored output
 *   6 result     the tier and card derived from the output equal the card of the draw
 *   7 taken      the taken positions are justified by the public log (every settled earlier draw is excluded, nothing else is, but removed cards)
 *   8 beacon     the blockhash of the beacon slot is the one in the input (chain read, best effort); for a pay-first draw also: it is the FIRST block after the payment
 *   9 payment    pay-first draws only (chain read, best effort): the payment transaction exists, succeeded, landed in the slot the draw names and carries the draw's memo
 *  10 order      pay-first draws only (public log): every earlier draw (lower index) was paid in the same slot or earlier, so the platform did not choose the order of the draws
 *
 * A PAY FIRST draw (chance packs) is made after the payment was final: its committed parameters hold the payment signature and slot, and the beacon
 * is a block after that slot, so neither the buyer nor the operator could know or steer the input when they paid (rule 2 checks that structure).
 */
import { buildAlpha, fromHex, paramsHashOf, parseAlpha, vrfVerify, type VrfRpc } from '@/lib/vrf';
import { poolHashOf, drawParams, packDrawSubject, type PackCardDef, type PackDefinition } from './commit';
import { selectFromPool } from './draw';

export type PackCheckId = 'pool_hash' | 'params' | 'alpha' | 'proof' | 'output' | 'result' | 'taken' | 'beacon' | 'payment' | 'order';
export type PackCheckStatus = 'pass' | 'fail' | 'skipped' | 'unverifiable';
export interface PackCheck { id: PackCheckId; kind: 'crypto' | 'log' | 'chain'; status: PackCheckStatus; detail?: string }

export const PACK_CRYPTO_CHECKS: readonly PackCheckId[] = ['pool_hash', 'params', 'alpha', 'proof', 'output', 'result'];

export interface ProofPool extends PackDefinition {
  /** The hash the pack page publishes. */
  poolHash: string;
  /** Positions of cards the pack no longer holds (status removed). */
  removed?: readonly number[];
}
export interface ProofDraw {
  id: string;
  packId: string;
  drawIndex: number | null;
  /** 'pay_first': drawn after the payment was final; anything else is the older atomic flow. */
  flow?: 'atomic' | 'pay_first';
  buyer: string;
  clientSeed: string;
  poolHash: string;
  status: string;
  tier: string | null;
  cardAsset: string | null;
  vrf: {
    requestId: string | null;
    input: string | null;
    proofHex: string | null;
    outputHex: string | null;
    params: Record<string, unknown> | null;
    paramsHash: string | null;
    beacon: { slot: number; blockhash: string } | null;
    publicKey: string | null;
  };
}
/** What the public log says about the draws made before this one. */
/** `paymentSlot` is the slot the payment of that draw landed in (from its committed parameters, shown once the draw ended), null when not known. */
export interface EarlierDraw {
  drawIndex: number; status: string; cardAsset: string | null; paymentSlot?: number | null;
  /** The payment's transaction id (public from the payment on); breaks a tie between two payments in one slot (byte order). */
  paymentSignature?: string | null;
}
/** Statuses in which an earlier draw's card is still hidden from the public log (no result yet) but its card is already taken from the pool. */
const HIDDEN_BUT_TAKEN = ['paid', 'drawn', 'delivering'] as const;

const mk = (id: PackCheckId, status: PackCheckStatus, detail?: string): PackCheck => ({ id, kind: id === 'taken' || id === 'order' ? 'log' : id === 'beacon' || id === 'payment' ? 'chain' : 'crypto', status, ...(detail ? { detail } : {}) });
const pass = (id: PackCheckId, detail?: string) => mk(id, 'pass', detail);
const fail = (id: PackCheckId, detail: string) => mk(id, 'fail', detail);
const skip = (id: PackCheckId, detail: string) => mk(id, 'skipped', detail);

export async function verifyPackDraw(pool: ProofPool, draw: ProofDraw, opts: { earlier?: readonly EarlierDraw[]; rpc?: VrfRpc } = {}): Promise<PackCheck[]> {
  const v = draw.vrf;
  if (!v.input || !v.proofHex || !v.outputHex || !v.params || !v.paramsHash || !v.publicKey || draw.drawIndex === null) {
    const why = 'the result is shown only after the draw ended (delivered, or marked as not delivered)';
    return (['pool_hash', 'params', 'alpha', 'proof', 'output', 'result', 'taken', 'beacon', 'payment', 'order'] as const).map((id) => skip(id, why));
  }
  const drawIndex = draw.drawIndex;
  const payFirst = draw.flow === 'pay_first';
  const checks: PackCheck[] = [];

  // 1
  const recomputed = poolHashOf(pool);
  checks.push(recomputed !== pool.poolHash ? fail('pool_hash', 'the pack definition does not hash to the committed pool hash')
    : draw.poolHash !== pool.poolHash ? fail('pool_hash', 'the draw names another pool hash than the pack') : pass('pool_hash'));

  // 2
  let params: ReturnType<typeof drawParams> | null = null;
  try {
    const p = v.params as { buyer: string; index: number; pack: string; poolHash: string; seed: string; taken: number[]; payment?: { signature: string; slot: number }; v: number };
    params = drawParams({ buyer: p.buyer, index: p.index, pack: p.pack, poolHash: p.poolHash, seed: p.seed, taken: p.taken, ...(p.payment ? { payment: p.payment } : {}) });
    const same = paramsHashOf(v.params) === v.paramsHash && paramsHashOf(params) === v.paramsHash;
    const fields = p.pack === draw.packId && p.buyer === draw.buyer && p.seed === draw.clientSeed && p.index === drawIndex && p.poolHash === pool.poolHash && p.v === 1;
    const afterPayment = !payFirst ? p.payment === undefined : !!p.payment && !!v.beacon && v.beacon.slot > p.payment.slot;
    checks.push(!same ? fail('params', 'the parameters do not hash to the committed params hash') : !fields ? fail('params', 'the parameters do not match the pack, buyer, seed and index of the draw')
      : !afterPayment ? fail('params', payFirst ? 'a pay-first draw must commit to its payment and use a beacon block after the payment slot' : 'an atomic draw does not carry a payment') : pass('params'));
  } catch (e) {
    checks.push(fail('params', (e as Error).message));
  }

  // 3
  let alphaOk = false;
  try {
    const a = parseAlpha(v.input);
    const rebuilt = v.beacon ? buildAlpha({ cluster: pool.cluster, purpose: 'pack_pull', subject: packDrawSubject(draw.packId, drawIndex), paramsHash: v.paramsHash, beacon: v.beacon }) : null;
    alphaOk = rebuilt === v.input && (v.requestId === null || v.requestId === a.subject) && a.cluster === pool.cluster && a.purpose === 'pack_pull';
    checks.push(alphaOk ? pass('alpha') : fail('alpha', 'the input text is not the canonical text for this cluster, pack, draw index, params hash and beacon'));
  } catch (e) {
    checks.push(fail('alpha', (e as Error).message));
  }

  // 4, 5
  let output: Uint8Array | null = null;
  try {
    const out = vrfVerify(v.publicKey, v.input, v.proofHex);
    checks.push(pass('proof'));
    checks.push(out === v.outputHex ? pass('output') : fail('output', 'the output of the proof is not the stored output'));
    if (out === v.outputHex) output = fromHex(out, 64);
  } catch (e) {
    checks.push(fail('proof', (e as Error).message), skip('output', 'no valid proof'));
  }

  // 6
  if (!output || !params) checks.push(skip('result', 'needs a valid proof and valid parameters'));
  else {
    const sel = selectFromPool(output, pool.odds, pool.cards, params.taken);
    const asset = sel ? pool.cards[sel.position]?.asset : null;
    checks.push(!sel ? fail('result', 'no card was available') : sel.tier !== draw.tier || asset !== draw.cardAsset
      ? fail('result', `the output selects ${sel.tier} / ${asset ?? 'none'}, the draw says ${draw.tier ?? 'none'} / ${draw.cardAsset ?? 'none'}`)
      : pass('result', `${sel.tier}, position ${sel.position}, roll ${sel.tierRoll} of ${sel.tierTotal}`));
  }

  // 7
  checks.push(checkTaken(pool, draw, params, opts.earlier));

  // 8
  const payment = params?.payment;
  if (!opts.rpc || !v.beacon) checks.push(skip('beacon', 'no chain read requested'));
  else {
    try {
      const hash = await opts.rpc.getBlockhash(v.beacon.slot);
      if (hash === null) checks.push(mk('beacon', 'unverifiable', 'the RPC no longer has this block'));
      else if (hash !== v.beacon.blockhash) checks.push(fail('beacon', 'the blockhash of the beacon slot is another one'));
      else if (payFirst && payment) {
        // the rule leaves the server no choice: the beacon is the FIRST block produced after the payment, so no later (luckier) block can be picked
        const between = await opts.rpc.getBlocks(payment.slot + 1, v.beacon.slot);
        checks.push(between[0] === v.beacon.slot ? pass('beacon', 'the first block after the payment') : fail('beacon', 'a block was produced between the payment and the beacon block'));
      } else checks.push(pass('beacon'));
    } catch (e) {
      checks.push(mk('beacon', 'unverifiable', (e as Error).message));
    }
  }

  // 9
  if (!payFirst) checks.push(skip('payment', draw.flow === 'atomic' && pool.mode === 'chance' ? 'drawn before the payment (an older draw)' : 'the card moved in the same transaction as the payment'));
  else if (!opts.rpc || !payment) checks.push(skip('payment', 'no chain read requested'));
  else {
    try {
      const tx = await opts.rpc.getTx(payment.signature);
      if (!tx) checks.push(mk('payment', 'unverifiable', 'the RPC no longer has this transaction'));
      else {
        const memo = `hp:pack:${draw.id}:${pool.poolHash}`;
        checks.push(tx.failed ? fail('payment', 'the payment transaction failed') : tx.slot !== payment.slot ? fail('payment', 'the payment landed in another slot than the draw names')
          : !tx.memos.includes(memo) ? fail('payment', 'the payment does not carry this draw\'s memo') : !tx.signers.includes(draw.buyer) ? fail('payment', 'the buyer did not sign the payment') : pass('payment'));
      }
    } catch (e) {
      checks.push(mk('payment', 'unverifiable', (e as Error).message));
    }
  }

  // 10
  if (!payFirst || !payment) checks.push(skip('order', 'the card moved in the same transaction as the payment'));
  else if (!opts.earlier) checks.push(skip('order', 'the public log was not loaded'));
  else {
    const before = opts.earlier.filter((d) => d.drawIndex < drawIndex);
    const wrongOrder = before.find((d) => d.paymentSlot !== undefined && d.paymentSlot !== null
      && (d.paymentSlot > payment.slot || (d.paymentSlot === payment.slot && !!d.paymentSignature && d.paymentSignature > payment.signature)));
    const unknown = before.filter((d) => d.paymentSlot === undefined || d.paymentSlot === null);
    if (wrongOrder) checks.push(fail('order', `draw ${wrongOrder.drawIndex + 1} was made before this one but was paid ${wrongOrder.paymentSlot! > payment.slot ? 'in a later slot' : 'in the same slot with a later transaction id'}`));
    else if (unknown.length > 0) checks.push(mk('order', 'unverifiable', `the payment slot of draw ${unknown[0]!.drawIndex + 1} is not public (its payment is not final yet)`));
    else checks.push(pass('order', 'every earlier draw was paid earlier (same slot: a smaller transaction id)'));
  }
  return checks;
}

function checkTaken(pool: ProofPool, draw: ProofDraw, params: ReturnType<typeof drawParams> | null, earlier: readonly EarlierDraw[] | undefined): PackCheck {
  if (!params) return skip('taken', 'needs valid parameters');
  if (!earlier) return skip('taken', 'the public log was not loaded');
  const positionOf = (asset: string | null) => (asset === null ? -1 : pool.cards.findIndex((c: PackCardDef) => c.asset === asset));
  const taken = new Set(params.taken);
  const removed = new Set(pool.removed ?? []);
  const index = draw.drawIndex ?? 0;
  const before = earlier.filter((d) => d.drawIndex < index);
  const needed = before.length === index;
  if (!needed) return mk('taken', 'unverifiable', 'the log does not hold every earlier draw');
  const justified = new Set<number>([...removed]);
  for (const d of before) { const p = positionOf(d.cardAsset); if (p >= 0) justified.add(p); }
  const stray = params.taken.filter((p) => p >= pool.cards.length || !justified.has(p));
  // An earlier draw that is paid but not delivered yet shows no card in the public log, though its card is already taken from the pool. That is not a
  // mismatch: as many stray positions as there are such draws are "not public yet", more than that is a real mismatch.
  const hidden = before.filter((d) => d.cardAsset === null && (HIDDEN_BUT_TAKEN as readonly string[]).includes(d.status)).length;
  if (stray.length > hidden) return fail('taken', `position ${stray[0]} is excluded but no earlier draw holds that card`);
  if (stray.length > 0) return mk('taken', 'unverifiable', `${stray.length} excluded position(s) belong to earlier draws that are paid but not delivered yet, so their cards are not public`);
  for (const d of before) {
    const p = positionOf(d.cardAsset);
    if (d.status === 'settled' && p >= 0 && !taken.has(p)) return fail('taken', `the card of delivered draw ${d.drawIndex} was not excluded`);
  }
  return pass('taken', `${params.taken.length} position(s) excluded`);
}

/** The only condition under which a screen may say "proven". */
export const isPackProven = (checks: readonly PackCheck[]): boolean => PACK_CRYPTO_CHECKS.every((id) => checks.find((c) => c.id === id)?.status === 'pass');
