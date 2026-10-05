/**
 * The money-critical boundary, PURE and browser-safe (depends only on @solana/web3.js, zod via the contracts, and ix.ts).
 *
 * `buildSettlementInstructions` turns the trusted description of a sale into the ONE legal instruction list.
 * `assertSettlementTx` takes bytes somebody hands us (the browser before it asks a wallet to sign, the server before
 * it stores a signature or adds its own) and requires the compiled message to equal that list byte for byte, blockhash
 * aside. Comparing compiled messages, not per-instruction flags, is deliberate: compilation merges privileges across
 * instructions, so flags differ after a round trip even for an honest transaction.
 *
 * Required signers are exactly {feePayer (SA), buyer, seller}. SA signs only as fee payer and ATA-rent payer; the
 * Core TransferV1 is authorised by the OWNER (the seller), so no key of ours has authority over any asset.
 */
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction, type Message } from '@solana/web3.js';
import { ApiError, ExpectedSettlement } from '@/contracts';
import { ataAddress, coreTransferV1Ix, createAtaIdempotentIx, MEMO_PROGRAM_ID, transferCheckedIx } from './ix';

export const USDC_DECIMALS = 6;
/** Measured 35k (plain asset) to 67k (real vault asset); leaves headroom and keeps the fee bounded. */
export const COMPUTE_UNIT_LIMIT = 150_000;
/**
 * Priority fee in micro-lamports per compute unit. It is IN the canonical message on purpose: a wallet (Phantom) that finds
 * no price instruction prepends its own, which changes the message the buyer signs and breaks the co-signing. With one present
 * the wallet leaves the message alone. 1 micro-lamport x 150k units rounds to a single lamport, so it costs nothing.
 */
export const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;
/** Largest legacy transaction on the wire. */
export const MAX_TX_BYTES = 1232;
/** Wallet guard programs (Phantom's Lighthouse) a wallet may prepend; tolerated by the browser pre-check only. */
export const WALLET_GUARD_PROGRAMS: readonly string[] = ['L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'];

const pk = (s: string) => new PublicKey(s);

/** trusted inputs -> the one legal instruction list. */
export function buildSettlementInstructions(e: ExpectedSettlement): TransactionInstruction[] {
  const payer = pk(e.feePayer), buyer = pk(e.buyer), seller = pk(e.seller), usdc = pk(e.usdcMint), feeWallet = pk(e.feeWallet);
  const buyerAta = ataAddress(usdc, buyer), sellerAta = ataAddress(usdc, seller), feeAta = ataAddress(usdc, feeWallet);
  const fee = BigInt(e.platformFee), royalty = BigInt(e.royalty), net = BigInt(e.gross) - fee - royalty;
  const royaltyTo = e.royaltyRecipient ? pk(e.royaltyRecipient) : null;
  const royaltyAta = royaltyTo ? ataAddress(usdc, royaltyTo) : null;
  return [
    ...(e.lifetime === 'nonce' ? [SystemProgram.nonceAdvance({ noncePubkey: pk(e.nonceAccount!), authorizedPubkey: payer })] : []), // durable nonce: must be first
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
    createAtaIdempotentIx(payer, sellerAta, seller, usdc),
    createAtaIdempotentIx(payer, feeAta, feeWallet, usdc),
    ...(royaltyTo ? [createAtaIdempotentIx(payer, royaltyAta!, royaltyTo, usdc)] : []),
    transferCheckedIx(buyerAta, usdc, sellerAta, buyer, net, USDC_DECIMALS),
    ...(fee > 0n ? [transferCheckedIx(buyerAta, usdc, feeAta, buyer, fee, USDC_DECIMALS)] : []),
    ...(royalty > 0n ? [transferCheckedIx(buyerAta, usdc, royaltyAta!, buyer, royalty, USDC_DECIMALS)] : []),
    coreTransferV1Ix({ asset: pk(e.asset), collection: e.collection ? pk(e.collection) : null, payer, authority: seller, newOwner: buyer }), // authority = the OWNER
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(e.memo, 'utf8') }), // anchors the signed bid log on chain
  ];
}

function compile(ixs: TransactionInstruction[], feePayer: PublicKey, recentBlockhash: string): Message {
  const t = new Transaction({ feePayer, recentBlockhash });
  t.add(...ixs);
  return t.compileMessage();
}

/** The unsigned legacy transaction (all signature slots empty) for `blockhash` (or the nonce value in nonce mode). */
export function buildUnsignedSettlementTx(e: ExpectedSettlement, recentBlockhash: string): Uint8Array {
  const t = new Transaction({ feePayer: pk(e.feePayer), recentBlockhash });
  t.add(...buildSettlementInstructions(e));
  const bytes = t.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > MAX_TX_BYTES) throw new RangeError(`settlement transaction is ${bytes.length} bytes, limit ${MAX_TX_BYTES}`);
  return bytes;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Decodes a legacy transaction and refuses anything that does not re-serialize to the same bytes (trailing junk, v0, lookup tables). */
export function decodeLegacyTx(txBytes: Uint8Array): Transaction {
  let tx: Transaction;
  try {
    tx = Transaction.from(txBytes);
    if (!same(tx.serialize({ requireAllSignatures: false, verifySignatures: false }), txBytes)) throw new Error('not canonical');
  } catch {
    throw new ApiError('tx_mismatch', 'not a legacy transaction in canonical form');
  }
  return tx;
}

/**
 * Throws ApiError('tx_mismatch') unless `txBytes` is exactly the settlement described by `expected`.
 * Instructions of allow-listed guard programs are stripped before the comparison; the signer set is checked on the
 * message as it really is, so a tolerated instruction can never add a signer.
 */
export function assertSettlementTx(txBytes: Uint8Array, expected: ExpectedSettlement, opts: { tolerated?: string[] } = {}): void {
  const fail = (why: string): never => { throw new ApiError('tx_mismatch', why); };
  const parsed = ExpectedSettlement.safeParse(expected);
  if (!parsed.success) return fail('expected settlement is invalid: ' + parsed.error.issues[0]?.message);
  const e = parsed.data;
  if (txBytes.length > MAX_TX_BYTES) return fail('transaction is too large');
  const tx = decodeLegacyTx(txBytes);
  const payer = pk(e.feePayer);
  if (!tx.feePayer?.equals(payer) || !tx.recentBlockhash) return fail('fee payer must be the settlement authority');
  const tolerated = new Set(opts.tolerated ?? WALLET_GUARD_PROGRAMS);
  const actual = compile(tx.instructions.filter((ix) => !tolerated.has(ix.programId.toBase58())), payer, tx.recentBlockhash);
  const wanted = compile(buildSettlementInstructions(e), payer, tx.recentBlockhash);
  if (!same(actual.serialize(), wanted.serialize())) return fail('message differs from the expected settlement');
  const real = tx.compileMessage();
  const signers = real.accountKeys.slice(0, real.header.numRequiredSignatures).map(String).sort();
  const allowed = [e.feePayer, e.buyer, e.seller].sort();
  if (signers.length !== allowed.length || signers.some((s, i) => s !== allowed[i])) return fail('signers must be exactly {feePayer, buyer, seller}');
}
