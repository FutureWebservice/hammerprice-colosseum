/**
 * The two signing steps of a credit purchase, on bytes (server side; takes the SA keypair, no I/O).
 * The buyer signs the prepared message in the browser; the server extracts that one signature, checks it against the PREPARED message
 * (not whatever came back), and only then adds SA's signature last.
 */
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ApiError } from '@/contracts';
import { assertCreditTx, type ExpectedCredit } from './credit-tx';
import { decodeLegacyTx } from './settlement-tx';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** `signedBytes` is what a wallet returned: exactly the expected purchase, carrying the prepared message byte for byte and the buyer's valid signature over it. */
export function extractBuyerSignature(signedBytes: Uint8Array, preparedBytes: Uint8Array, e: ExpectedCredit): Uint8Array {
  assertCreditTx(signedBytes, e, { tolerated: [] });
  const signed = decodeLegacyTx(signedBytes);
  const message = signed.serializeMessage();
  if (!same(message, decodeLegacyTx(preparedBytes).serializeMessage())) throw new ApiError('tx_mismatch', 'not the prepared message (stale or altered)');
  const who = new PublicKey(e.buyer);
  const sig = signed.signatures.find((s) => s.publicKey.equals(who))?.signature;
  if (!sig || sig.length !== 64 || !nacl.sign.detached.verify(message, sig, who.toBytes())) throw new ApiError('bad_signature', 'the buyer signature is missing or does not match the prepared message');
  return new Uint8Array(sig);
}

/** The buyer signature in, SA's added last. Returns the wire bytes and the transaction id (SA's signature, the first slot). */
export function assembleCreditTx(preparedBytes: Uint8Array, e: ExpectedCredit, buyerSig: Uint8Array, sa: Keypair): { wire: Buffer; signature: string } {
  if (sa.publicKey.toBase58() !== e.feePayer) throw new ApiError('tx_mismatch', 'the settlement authority key is not the fee payer');
  assertCreditTx(preparedBytes, e, { tolerated: [] });
  const t = Transaction.from(preparedBytes);
  t.addSignature(new PublicKey(e.buyer), Buffer.from(buyerSig));
  t.partialSign(sa);
  if (!t.verifySignatures()) throw new ApiError('tx_mismatch', 'assembled transaction has an invalid signature');
  return { wire: t.serialize(), signature: bs58.encode(t.signatures[0]!.signature!) };
}
