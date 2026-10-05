/**
 * PAY FIRST, DRAW AFTER (chance packs, run by a third-party operator; the devnet house demo). Two transactions, and none of them contains a card before the payment is finalized:
 *
 *   1. PAYMENT   buyer -> operator wallet and the fee wallet, memo `hp:pack:<draw id>:<pool hash>`. Signers exactly {fee payer, buyer}.
 *                The settlement authority pays the network fee only. There is no card, no asset address and no tier anywhere in these bytes: at this
 *                point no card has been chosen.
 *   2. DELIVERY  the card, operator -> buyer (Core TransferV1, authorised by the OWNER = the operator), memo `hp:pack-card:<draw id>`.
 *                Signers exactly {fee payer, operator}. Made after the draw; the operator signs it (the house demo: the server with the house key).
 *
 * The payment goes to the OPERATOR wallet and the fee wallet only; the platform receives nothing but its fee leg (A14). The delivery (2) is signed by
 * the OPERATOR in their wallet (the settlement authority pays the fee) for a third-party pack; only the devnet house demo has the server sign it with
 * the house key. There is no refund: the platform holds no customer money. Pure and browser safe except the signing helpers, which take the keypairs as arguments
 * (nothing here reads a key). Every builder has a validator that compares the compiled message byte for byte, like settlement-tx.ts.
 */
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ApiError, PackPayExpected, type ExpectedSettlement } from '@/contracts';
import { PACK_DELIVERY_MEMO_RE, PACK_MEMO_RE } from '@/lib/packs/commit';
import { ataAddress, coreTransferV1Ix, createAtaIdempotentIx, MEMO_PROGRAM_ID, transferCheckedIx } from './ix';
import { COMPUTE_UNIT_LIMIT, COMPUTE_UNIT_PRICE_MICROLAMPORTS, decodeLegacyTx, MAX_TX_BYTES, USDC_DECIMALS, WALLET_GUARD_PROGRAMS } from './settlement-tx';
import { verifyLegs, type ParsedTx, type VerifyResult } from './verify-settled';

const pk = (s: string) => new PublicKey(s);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const reject = (why: string): never => { throw new ApiError('tx_mismatch', why); };

const header = (): TransactionInstruction[] => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
];
const memoIx = (memo: string) => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(memo, 'utf8') });

function compile(ixs: TransactionInstruction[], feePayer: PublicKey, recentBlockhash: string) {
  const t = new Transaction({ feePayer, recentBlockhash });
  t.add(...ixs);
  return t.compileMessage();
}

function checkSigners(tx: Transaction, allowed: string[]) {
  const real = tx.compileMessage();
  const signers = real.accountKeys.slice(0, real.header.numRequiredSignatures).map(String).sort();
  const want = [...allowed].sort();
  if (signers.length !== want.length || signers.some((x, i) => x !== want[i])) reject('signers must be exactly {feePayer, the one party of this transaction}');
}

// ---- 1. the payment ------------------------------------------------------------------------------------------------------------------

/** The legs and memo of the payment as the shared verifier wants them. `asset` is never read for a payment (there is no card in it). */
const asLegs = (e: PackPayExpected): ExpectedSettlement => ({
  settlementId: e.drawId, cluster: e.cluster, buyer: e.buyer, seller: e.operator, asset: e.usdcMint, collection: null, usdcMint: e.usdcMint, gross: e.gross,
  platformFee: e.platformFee, royalty: '0', royaltyRecipient: null, feeWallet: e.feeWallet, feePayer: e.feePayer, bidLogHash: '0'.repeat(64), memo: e.memo, lifetime: 'blockhash', nonceAccount: null,
});

/** trusted inputs -> the one legal instruction list of the payment. */
export function buildPayInstructions(e: PackPayExpected): TransactionInstruction[] {
  const payer = pk(e.feePayer), buyer = pk(e.buyer), operator = pk(e.operator), usdc = pk(e.usdcMint), feeWallet = pk(e.feeWallet);
  const buyerAta = ataAddress(usdc, buyer), opAta = ataAddress(usdc, operator), feeAta = ataAddress(usdc, feeWallet);
  const fee = BigInt(e.platformFee), net = BigInt(e.gross) - fee;
  return [
    ...header(),
    createAtaIdempotentIx(payer, opAta, operator, usdc),
    createAtaIdempotentIx(payer, feeAta, feeWallet, usdc),
    transferCheckedIx(buyerAta, usdc, opAta, buyer, net, USDC_DECIMALS),
    ...(fee > 0n ? [transferCheckedIx(buyerAta, usdc, feeAta, buyer, fee, USDC_DECIMALS)] : []),
    memoIx(e.memo),
  ];
}

export function buildUnsignedPayTx(e: PackPayExpected, recentBlockhash: string): Uint8Array {
  const t = new Transaction({ feePayer: pk(e.feePayer), recentBlockhash });
  t.add(...buildPayInstructions(e));
  const bytes = t.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > MAX_TX_BYTES) throw new RangeError(`payment transaction is ${bytes.length} bytes, limit ${MAX_TX_BYTES}`);
  return bytes;
}

/** Throws tx_mismatch unless `txBytes` is exactly the pay-first payment described by `expected` (same instructions, accounts, amounts, memo; signers {fee payer, buyer}). */
export function assertPayTx(txBytes: Uint8Array, expected: PackPayExpected, opts: { tolerated?: string[] } = {}): void {
  const parsed = PackPayExpected.safeParse(expected);
  if (!parsed.success) return reject('expected payment is invalid: ' + parsed.error.issues[0]?.message);
  const e = parsed.data;
  if (BigInt(e.gross) === 0n || BigInt(e.platformFee) > BigInt(e.gross)) return reject('the fee exceeds the price');
  if (e.buyer === e.operator) return reject('buyer and operator are the same wallet');
  if (!PACK_MEMO_RE.test(e.memo) || PACK_MEMO_RE.exec(e.memo)![1] !== e.drawId) return reject('memo must be hp:pack:<draw id>:<pool hash>');
  if (txBytes.length > MAX_TX_BYTES) return reject('transaction is too large');
  const tx = decodeLegacyTx(txBytes);
  const payer = pk(e.feePayer);
  if (!tx.feePayer?.equals(payer) || !tx.recentBlockhash) return reject('fee payer must be the settlement authority');
  const tolerated = new Set(opts.tolerated ?? WALLET_GUARD_PROGRAMS);
  const actual = compile(tx.instructions.filter((ix) => !tolerated.has(ix.programId.toBase58())), payer, tx.recentBlockhash);
  const wanted = compile(buildPayInstructions(e), payer, tx.recentBlockhash);
  if (!same(actual.serialize(), wanted.serialize())) return reject('message differs from the expected pack payment');
  checkSigners(tx, [e.feePayer, e.buyer]);
}

/** After the payment landed: the buyer paid the price, the operator and the fee wallet received exactly their shares, and the memo names this draw. */
export const verifyPackPaid = (tx: ParsedTx | null, e: PackPayExpected): VerifyResult => verifyLegs(tx, asLegs(e));

/** The buyer's signature over the prepared payment (the only signature a wallet adds). */
export function extractPaySignature(signedBytes: Uint8Array, preparedBytes: Uint8Array, e: PackPayExpected): Uint8Array {
  assertPayTx(signedBytes, e, { tolerated: [] });
  const signed = decodeLegacyTx(signedBytes);
  const message = signed.serializeMessage();
  if (!same(message, decodeLegacyTx(preparedBytes).serializeMessage())) return reject('not the prepared message (stale or altered)');
  const who = pk(e.buyer);
  const sig = signed.signatures.find((s) => s.publicKey.equals(who))?.signature;
  if (!sig || sig.length !== 64 || !nacl.sign.detached.verify(message, sig, who.toBytes())) throw new ApiError('bad_signature', 'the buyer signature is missing or does not match the prepared message');
  return new Uint8Array(sig);
}

/** The buyer's signature in, SA's added last. Returns the wire bytes and the transaction id (SA's signature, the first slot). */
export function assemblePayTx(preparedBytes: Uint8Array, e: PackPayExpected, buyerSignature: Uint8Array, sa: Keypair): { wire: Buffer; signature: string } {
  if (sa.publicKey.toBase58() !== e.feePayer) throw new ApiError('tx_mismatch', 'the settlement authority key is not the fee payer');
  assertPayTx(preparedBytes, e, { tolerated: [] });
  const t = Transaction.from(preparedBytes);
  t.addSignature(pk(e.buyer), Buffer.from(buyerSignature));
  t.partialSign(sa);
  if (!t.verifySignatures()) return reject('assembled transaction has an invalid signature');
  return { wire: t.serialize(), signature: bs58.encode(t.signatures[0]!.signature!) };
}

// ---- 2. delivery (signed by the operator; the devnet house demo: by the server) ---------------------------------------------------------------------------------------

export interface PackDeliveryExpected { drawId: string; operator: string; buyer: string; asset: string; collection: string | null; feePayer: string; memo: string }
export type PackServerTx = { kind: 'delivery'; e: PackDeliveryExpected };

export function buildServerInstructions(x: PackServerTx): TransactionInstruction[] {
  const e = x.e;
  return [...header(), coreTransferV1Ix({ asset: pk(e.asset), collection: e.collection ? pk(e.collection) : null, payer: pk(e.feePayer), authority: pk(e.operator), newOwner: pk(e.buyer) }), memoIx(e.memo)];
}

function checkServerExpected(x: PackServerTx): void {
  const re = PACK_DELIVERY_MEMO_RE;
  if (!re.test(x.e.memo) || re.exec(x.e.memo)![1] !== x.e.drawId) reject('memo must name the draw (delivery)');
  if (x.e.buyer === x.e.operator) reject('buyer and operator are the same wallet');
}

export function buildUnsignedServerTx(x: PackServerTx, recentBlockhash: string): Uint8Array {
  checkServerExpected(x);
  const t = new Transaction({ feePayer: pk(x.e.feePayer), recentBlockhash });
  t.add(...buildServerInstructions(x));
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
}

/** Throws tx_mismatch unless `txBytes` is exactly the delivery described by `x`, signers exactly {fee payer, operator}. No wallet guard is tolerated unless `opts.tolerated` says so (the operator's browser does, the server never). */
export function assertServerTx(txBytes: Uint8Array, x: PackServerTx, opts: { tolerated?: string[] } = {}): void {
  checkServerExpected(x);
  if (txBytes.length > MAX_TX_BYTES) return reject('transaction is too large');
  const tx = decodeLegacyTx(txBytes);
  const payer = pk(x.e.feePayer);
  if (!tx.feePayer?.equals(payer) || !tx.recentBlockhash) return reject('fee payer must be the settlement authority');
  const tolerated = new Set(opts.tolerated ?? []);
  if (!same(compile(tx.instructions.filter((ix) => !tolerated.has(ix.programId.toBase58())), payer, tx.recentBlockhash).serialize(), compile(buildServerInstructions(x), payer, tx.recentBlockhash).serialize())) return reject(`message differs from the expected ${x.kind}`);
  checkSigners(tx, [x.e.feePayer, x.e.operator]);
}

/** Signs a server transaction with both server keys (settlement authority = fee payer, house = operator). Validated before and after. Returns the wire bytes and the transaction id. */
export function signServerTx(unsigned: Uint8Array, x: PackServerTx, sa: Keypair, operator: Keypair): { wire: Buffer; signature: string } {
  if (sa.publicKey.toBase58() !== x.e.feePayer) throw new ApiError('tx_mismatch', 'the settlement authority key is not the fee payer');
  if (operator.publicKey.toBase58() !== x.e.operator) throw new ApiError('tx_mismatch', 'the house key is not the operator of this pack');
  assertServerTx(unsigned, x);
  const t = Transaction.from(unsigned);
  t.partialSign(sa, operator);
  if (!t.verifySignatures()) return reject('assembled transaction has an invalid signature');
  return { wire: t.serialize(), signature: bs58.encode(t.signatures[0]!.signature!) };
}

/**
 * The operator's signature over the prepared delivery message (the only signature their wallet adds). The signed bytes must be exactly the delivery of
 * this draw (no wallet guard tolerated here, the browser tolerates it before signing) and carry the same message as the prepared bytes.
 */
export function extractServerPartySignature(signedBytes: Uint8Array, preparedBytes: Uint8Array, x: PackServerTx, who: string): Uint8Array {
  assertServerTx(signedBytes, x);
  const signed = decodeLegacyTx(signedBytes);
  const message = signed.serializeMessage();
  if (!same(message, decodeLegacyTx(preparedBytes).serializeMessage())) return reject('not the prepared message (stale or altered)');
  const key = pk(who);
  const sig = signed.signatures.find((s) => s.publicKey.equals(key))?.signature;
  if (!sig || sig.length !== 64 || !nacl.sign.detached.verify(message, sig, key.toBytes())) throw new ApiError('bad_signature', 'the operator signature is missing or does not match the prepared message');
  return new Uint8Array(sig);
}

/** The operator's signature in, the settlement authority's (fee payer) added last. Returns the wire bytes and the transaction id. */
export function assembleServerTx(preparedBytes: Uint8Array, x: PackServerTx, operatorSignature: Uint8Array, sa: Keypair): { wire: Buffer; signature: string } {
  if (sa.publicKey.toBase58() !== x.e.feePayer) throw new ApiError('tx_mismatch', 'the settlement authority key is not the fee payer');
  assertServerTx(preparedBytes, x);
  const t = Transaction.from(preparedBytes);
  t.addSignature(pk(x.e.operator), Buffer.from(operatorSignature));
  t.partialSign(sa);
  if (!t.verifySignatures()) return reject('assembled transaction has an invalid signature');
  return { wire: t.serialize(), signature: bs58.encode(t.signatures[0]!.signature!) };
}

const memosOf = (tx: ParsedTx) => (tx.transaction.message.instructions ?? []).filter((i) => i.program === 'spl-memo').map((i) => i.parsed);

/** After the delivery landed: it succeeded, carries exactly the delivery memo of this draw, and the card is now the buyer's. */
export function verifyDelivered(tx: ParsedTx | null, e: PackDeliveryExpected, assetOwnerNow: string | null): VerifyResult {
  if (!tx?.meta) return { ok: false, code: 'tx_failed', detail: 'transaction not found' };
  if (tx.meta.err !== null) return { ok: false, code: 'tx_failed', detail: JSON.stringify(tx.meta.err).slice(0, 200) };
  const m = memosOf(tx);
  if (m.length !== 1 || m[0] !== e.memo) return { ok: false, code: 'memo_mismatch', detail: 'delivery memo missing or different' };
  if (assetOwnerNow !== e.buyer) return { ok: false, code: 'owner_mismatch', detail: `asset owner is ${assetOwnerNow ?? 'unknown'}, not the buyer` };
  return { ok: true };
}
