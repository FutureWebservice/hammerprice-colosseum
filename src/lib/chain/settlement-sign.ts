/**
 * The two signing steps of a round, on bytes. Server-side helpers (they take the SA keypair), no I/O.
 *
 * Buyer and seller each sign the SAME unsigned message. The server keeps only signatures, never a daisy-chained
 * transaction: it extracts one party's signature from whatever bytes the party sent back, verifies it against the
 * PREPARED message, and stores it. When both are stored it assembles the wire transaction and adds SA last.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ApiError, type ExpectedSettlement, type PartyRole } from '@/contracts';
import { assertSettlementTx, decodeLegacyTx } from './settlement-tx';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const reject = (why: string): never => { throw new ApiError('tx_mismatch', why); };

/**
 * `signedBytes` is what a wallet returned. It must pass assertSettlementTx, carry the PREPARED message byte for byte (a stale
 * or altered message is `tx_mismatch`), and hold a valid ed25519 signature of `role`'s key over that message (`bad_signature` when it
 * is missing or made by another key). Returns that signature.
 */
export function extractPartySignature(signedBytes: Uint8Array, preparedBytes: Uint8Array, e: ExpectedSettlement, role: PartyRole): Uint8Array {
  assertSettlementTx(signedBytes, e, { tolerated: [] });
  const signed = decodeLegacyTx(signedBytes);
  const message = signed.serializeMessage();
  if (!same(message, decodeLegacyTx(preparedBytes).serializeMessage())) return reject('not the prepared message (stale or altered)');
  const who = new PublicKey(role === 'buyer' ? e.buyer : e.seller);
  const sig = signed.signatures.find((s) => s.publicKey.equals(who))?.signature;
  if (!sig || sig.length !== 64 || !nacl.sign.detached.verify(message, sig, who.toBytes())) throw new ApiError('bad_signature', `the ${role} signature is missing or does not match the prepared message`);
  return new Uint8Array(sig);
}

/** Both party signatures in, SA's added last. Returns the wire bytes and the transaction id (SA's signature, the first slot). */
export function assembleSettlementTx(preparedBytes: Uint8Array, e: ExpectedSettlement, sigs: { buyer: Uint8Array; seller: Uint8Array }, sa: Keypair): { wire: Buffer; signature: string } {
  if (sa.publicKey.toBase58() !== e.feePayer) throw new ApiError('tx_mismatch', 'the settlement authority key is not the fee payer');
  assertSettlementTx(preparedBytes, e, { tolerated: [] });
  const t = Transaction.from(preparedBytes);
  t.addSignature(new PublicKey(e.buyer), Buffer.from(sigs.buyer));
  t.addSignature(new PublicKey(e.seller), Buffer.from(sigs.seller));
  t.partialSign(sa); // the platform signs LAST, after both parties
  if (!t.verifySignatures()) return reject('assembled transaction has an invalid signature');
  return { wire: t.serialize(), signature: bs58.encode(t.signatures[0]!.signature!) };
}

/** What a wallet does, for server-held keys (the house seller): sign the message of `txBytes`, keep the other signatures. */
export function signAs(txBytes: Uint8Array, kp: Keypair): Uint8Array {
  const t = Transaction.from(txBytes);
  t.partialSign(kp);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
}
