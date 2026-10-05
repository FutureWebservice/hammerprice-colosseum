/**
 * The payment of a pack: ONE transaction in which the buyer pays the pack price in USDC to the pack operator (less the platform fee) and the
 * drawn card moves from the OPERATOR's wallet to the buyer. It is the settlement transaction of an auction with a different memo, so it
 * is built, validated and verified by the very same code (settlement-tx.ts, verify-settled.ts): required signers are exactly
 * {settlement authority (fee payer only), buyer, operator}; the card transfer is authorised by the OWNER (the operator), so no key of
 * ours has authority over any card or any money, and Hammerprice holds neither.
 *
 * What differs: the memo is `hp:pack:<draw id>:<pool hash>` (it ties the transaction to the draw and to the committed pool), and the
 * expected-payment shape is the pack's (`PackExpectedPayment`). `asSettlement` maps one onto the other so the builder and the verifier are
 * shared, byte for byte. Pure and browser safe except the signing helpers at the bottom, which take the SA keypair on the server.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ApiError, PackExpectedPayment, type ExpectedSettlement, type PartyRole } from '@/contracts';
import { PACK_MEMO_RE } from '@/lib/packs/commit';
import { buildSettlementInstructions, buildUnsignedSettlementTx, decodeLegacyTx, MAX_TX_BYTES, WALLET_GUARD_PROGRAMS } from './settlement-tx';
import { verifySettled, type ParsedTx, type VerifyResult } from './verify-settled';

const pk = (s: string) => new PublicKey(s);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const reject = (why: string): never => { throw new ApiError('tx_mismatch', why); };

/**
 * The pack payment as the settlement builder wants it. `seller` is the pack operator; `bidLogHash` is unused by the builder and the
 * verifier (the memo is taken as given), so it carries the draw's pool hash for readability only. The cast is deliberate: ExpectedSettlement's
 * own validator insists on the auction memo, which is exactly what a pack must NOT carry.
 */
export function asSettlement(e: PackExpectedPayment): ExpectedSettlement {
  return {
    settlementId: e.drawId, cluster: e.cluster, buyer: e.buyer, seller: e.operator, asset: e.asset, collection: e.collection, usdcMint: e.usdcMint,
    gross: e.gross, platformFee: e.platformFee, royalty: e.royalty, royaltyRecipient: e.royaltyRecipient, feeWallet: e.feeWallet, feePayer: e.feePayer,
    bidLogHash: PACK_MEMO_RE.exec(e.memo)?.[2] ?? '0'.repeat(64), memo: e.memo, lifetime: 'blockhash', nonceAccount: null,
  };
}

/** The unsigned legacy transaction both parties sign (all signature slots empty). */
export const buildUnsignedPackTx = (e: PackExpectedPayment, recentBlockhash: string): Uint8Array => buildUnsignedSettlementTx(asSettlement(e), recentBlockhash);

function compile(ixs: ReturnType<typeof buildSettlementInstructions>, feePayer: PublicKey, recentBlockhash: string) {
  const t = new Transaction({ feePayer, recentBlockhash });
  t.add(...ixs);
  return t.compileMessage();
}

/**
 * Throws ApiError('tx_mismatch') unless `txBytes` is exactly the pack payment described by `expected`: same instructions in the same order,
 * same accounts and amounts, the pack memo, and exactly the three signers. Guard-program instructions a wallet may prepend are tolerated
 * only when `opts.tolerated` says so (the browser pre-check); the server passes `[]`.
 */
export function assertPackTx(txBytes: Uint8Array, expected: PackExpectedPayment, opts: { tolerated?: string[] } = {}): void {
  const parsed = PackExpectedPayment.safeParse(expected);
  if (!parsed.success) return reject('expected payment is invalid: ' + parsed.error.issues[0]?.message);
  const e = parsed.data;
  if (BigInt(e.platformFee) + BigInt(e.royalty) > BigInt(e.gross)) return reject('fee plus royalty exceed the price');
  if ((e.royalty !== '0') !== (e.royaltyRecipient !== null)) return reject('royaltyRecipient is required exactly when royalty > 0');
  if (!PACK_MEMO_RE.test(e.memo) || PACK_MEMO_RE.exec(e.memo)![1] !== e.drawId) return reject('memo must be hp:pack:<draw id>:<pool hash>');
  if (txBytes.length > MAX_TX_BYTES) return reject('transaction is too large');
  const tx = decodeLegacyTx(txBytes);
  const payer = pk(e.feePayer);
  if (!tx.feePayer?.equals(payer) || !tx.recentBlockhash) return reject('fee payer must be the settlement authority');
  const tolerated = new Set(opts.tolerated ?? WALLET_GUARD_PROGRAMS);
  const actual = compile(tx.instructions.filter((ix) => !tolerated.has(ix.programId.toBase58())), payer, tx.recentBlockhash);
  const wanted = compile(buildSettlementInstructions(asSettlement(e)), payer, tx.recentBlockhash);
  if (!same(actual.serialize(), wanted.serialize())) return reject('message differs from the expected pack payment');
  const real = tx.compileMessage();
  const signers = real.accountKeys.slice(0, real.header.numRequiredSignatures).map(String).sort();
  const allowed = [e.feePayer, e.buyer, e.operator].sort();
  if (signers.length !== allowed.length || signers.some((s, i) => s !== allowed[i])) return reject('signers must be exactly {feePayer, buyer, operator}');
}

/** After the transaction landed: token deltas per owner, the memo, and that the card now belongs to the buyer. */
export const verifyPackSettled = (tx: ParsedTx | null, e: PackExpectedPayment, assetOwnerNow: string | null): VerifyResult => verifySettled(tx, asSettlement(e), assetOwnerNow);

// ---- signing (server side; the SA keypair is passed in, nothing here reads a key) ------------------------------------------------

/**
 * `signedBytes` is what a wallet returned. It must pass assertPackTx, carry the PREPARED message byte for byte, and hold a valid ed25519
 * signature of `role`'s key over it (`bad_signature` otherwise). `role` 'seller' is the pack operator. Returns that signature.
 */
export function extractPackSignature(signedBytes: Uint8Array, preparedBytes: Uint8Array, e: PackExpectedPayment, role: PartyRole): Uint8Array {
  assertPackTx(signedBytes, e, { tolerated: [] });
  const signed = decodeLegacyTx(signedBytes);
  const message = signed.serializeMessage();
  if (!same(message, decodeLegacyTx(preparedBytes).serializeMessage())) return reject('not the prepared message (stale or altered)');
  const who = pk(role === 'buyer' ? e.buyer : e.operator);
  const sig = signed.signatures.find((s) => s.publicKey.equals(who))?.signature;
  if (!sig || sig.length !== 64 || !nacl.sign.detached.verify(message, sig, who.toBytes())) throw new ApiError('bad_signature', `the ${role === 'buyer' ? 'buyer' : 'operator'} signature is missing or does not match the prepared message`);
  return new Uint8Array(sig);
}

/** Both signatures in, SA's added last. Returns the wire bytes and the transaction id (SA's signature, the first slot). */
export function assemblePackTx(preparedBytes: Uint8Array, e: PackExpectedPayment, sigs: { buyer: Uint8Array; operator: Uint8Array }, sa: Keypair): { wire: Buffer; signature: string } {
  if (sa.publicKey.toBase58() !== e.feePayer) throw new ApiError('tx_mismatch', 'the settlement authority key is not the fee payer');
  assertPackTx(preparedBytes, e, { tolerated: [] });
  const t = Transaction.from(preparedBytes);
  t.addSignature(pk(e.buyer), Buffer.from(sigs.buyer));
  t.addSignature(pk(e.operator), Buffer.from(sigs.operator));
  t.partialSign(sa);
  if (!t.verifySignatures()) return reject('assembled transaction has an invalid signature');
  return { wire: t.serialize(), signature: bs58.encode(t.signatures[0]!.signature!) };
}

/** What a wallet does, for a server-held key (the house operator): sign the message of `txBytes`, keep the other signatures. */
export function signPackAs(txBytes: Uint8Array, kp: Keypair): Uint8Array {
  const t = Transaction.from(txBytes);
  t.partialSign(kp);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
}
