/**
 * The AI credit purchase transaction, PURE and browser-safe (same shape as settlement-tx.ts; the browser checks it before a wallet signs).
 *
 * One legacy transaction, fee payer = the settlement authority SA (it pays the network fee and the rent of the fee wallet's token account,
 * and has no authority over the buyer's USDC), required signers exactly {SA, buyer}. Instructions, in this order:
 *   ComputeBudget limit, ComputeBudget PRICE (explicit: a wallet that finds none prepends its own and breaks the co-signing, see 1a141e4),
 *   createAssociatedTokenAccountIdempotent(payer SA, fee wallet), USDC transferChecked buyer -> fee wallet, Memo `hp:credits:<purchaseId>`.
 * The USDC mint is the one of the cluster (lib/chain/config.ts usdcMintFor), carried in `expected`; nothing here names a cluster.
 *
 * Deviation from the x402 "exact" scheme, stated on purpose: x402 forbids the fee payer in any instruction account, and the idempotent
 * token-account creation names SA as payer. It is kept (as in the settlement) so there is no race between "does the account exist" and
 * the send. The 402 body is x402-STYLE terms, not an x402-compatible facilitator flow.
 */
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { z } from 'zod';
import { Amount, ApiError, Cluster, Wallet } from '@/contracts';
import { ataAddress, createAtaIdempotentIx, MEMO_PROGRAM_ID, transferCheckedIx } from './ix';
import { COMPUTE_UNIT_PRICE_MICROLAMPORTS, decodeLegacyTx, MAX_TX_BYTES, USDC_DECIMALS, WALLET_GUARD_PROGRAMS } from './settlement-tx';

export const CREDIT_COMPUTE_UNIT_LIMIT = 80_000;
export const creditMemo = (purchaseId: string): string => `hp:credits:${purchaseId}`;

export const ExpectedCredit = z
  .object({
    purchaseId: z.string().uuid(),
    cluster: Cluster,
    buyer: Wallet,
    feePayer: Wallet,
    feeWallet: Wallet,
    usdcMint: Wallet,
    amount: Amount,
    memo: z.string().min(1).max(120),
  })
  .strict()
  .refine((e) => e.memo === creditMemo(e.purchaseId), 'memo does not match the purchase id')
  .refine((e) => e.buyer !== e.feeWallet && e.buyer !== e.feePayer, 'the buyer cannot be the fee wallet or the fee payer')
  .refine((e) => BigInt(e.amount) > 0n, 'amount must be positive');
export type ExpectedCredit = z.infer<typeof ExpectedCredit>;

const pk = (s: string) => new PublicKey(s);

export function buildCreditInstructions(e: ExpectedCredit): TransactionInstruction[] {
  const payer = pk(e.feePayer), buyer = pk(e.buyer), usdc = pk(e.usdcMint), feeWallet = pk(e.feeWallet);
  const buyerAta = ataAddress(usdc, buyer), feeAta = ataAddress(usdc, feeWallet);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: CREDIT_COMPUTE_UNIT_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE_MICROLAMPORTS }),
    createAtaIdempotentIx(payer, feeAta, feeWallet, usdc),
    transferCheckedIx(buyerAta, usdc, feeAta, buyer, BigInt(e.amount), USDC_DECIMALS),
    new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(e.memo, 'utf8') }),
  ];
}

export function buildUnsignedCreditTx(e: ExpectedCredit, recentBlockhash: string): Uint8Array {
  const t = new Transaction({ feePayer: pk(e.feePayer), recentBlockhash });
  t.add(...buildCreditInstructions(ExpectedCredit.parse(e)));
  const bytes = t.serialize({ requireAllSignatures: false, verifySignatures: false });
  if (bytes.length > MAX_TX_BYTES) throw new RangeError(`credit transaction is ${bytes.length} bytes, limit ${MAX_TX_BYTES}`);
  return bytes;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const compile = (ixs: TransactionInstruction[], feePayer: PublicKey, blockhash: string) => {
  const t = new Transaction({ feePayer, recentBlockhash: blockhash });
  t.add(...ixs);
  return t.compileMessage();
};

/**
 * Throws ApiError('tx_mismatch') unless `txBytes` is exactly the purchase described by `expected`: the compiled message must equal the
 * one legal instruction list byte for byte (blockhash aside), so an extra instruction, a different amount, recipient, mint or memo, or a
 * fee payer other than SA all fail. Allow-listed wallet guard instructions are stripped first (browser pre-check only); the signer set
 * is checked on the message as it really is, so a tolerated instruction can never add a signer.
 */
export function assertCreditTx(txBytes: Uint8Array, expected: ExpectedCredit, opts: { tolerated?: string[] } = {}): void {
  const fail = (why: string): never => { throw new ApiError('tx_mismatch', why); };
  const parsed = ExpectedCredit.safeParse(expected);
  if (!parsed.success) return fail('expected purchase is invalid: ' + parsed.error.issues[0]?.message);
  const e = parsed.data;
  if (txBytes.length > MAX_TX_BYTES) return fail('transaction is too large');
  const tx = decodeLegacyTx(txBytes);
  const payer = pk(e.feePayer);
  if (!tx.feePayer?.equals(payer) || !tx.recentBlockhash) return fail('fee payer must be the settlement authority');
  const tolerated = new Set(opts.tolerated ?? WALLET_GUARD_PROGRAMS);
  const actual = compile(tx.instructions.filter((ix) => !tolerated.has(ix.programId.toBase58())), payer, tx.recentBlockhash);
  const wanted = compile(buildCreditInstructions(e), payer, tx.recentBlockhash);
  if (!same(actual.serialize(), wanted.serialize())) return fail('message differs from the expected credit purchase');
  const real = tx.compileMessage();
  const signers = real.accountKeys.slice(0, real.header.numRequiredSignatures).map(String).sort();
  const allowed = [e.feePayer, e.buyer].sort();
  if (signers.length !== allowed.length || signers.some((s, i) => s !== allowed[i])) return fail('signers must be exactly {feePayer, buyer}');
}
