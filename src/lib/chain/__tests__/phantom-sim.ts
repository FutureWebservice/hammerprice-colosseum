/**
 * What the real Phantom does to a transaction before it signs (seen on devnet, 2026-10-02): when the transaction carries no
 * ComputeBudget setComputeUnitPrice instruction, it PREPENDS one. That changes the message, so a co-signed settlement whose
 * canonical message has no price instruction gets a buyer signature over a different message than the seller's and the
 * settlement authority's. With a price instruction already present the wallet leaves the message alone.
 *
 * Pure (web3.js only) so the mock wallet and a unit test on the settlement builder share it.
 */
import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';

/** A fee Phantom would pick; any value shows the effect. */
export const PHANTOM_PRICE_MICROLAMPORTS = 374_008;

const isPrice = (programId: string, data: Uint8Array) => programId === ComputeBudgetProgram.programId.toBase58() && data[0] === 3;

/** Returns the bytes the wallet signs: the input unchanged, or (no price instruction) the input with one prepended and every signature dropped. */
export function phantomPrepare(txBytes: Uint8Array): { bytes: Uint8Array; addedPrice: boolean } {
  const tx = Transaction.from(txBytes);
  if (tx.instructions.some((ix) => isPrice(ix.programId.toBase58(), ix.data))) return { bytes: txBytes, addedPrice: false };
  const changed = new Transaction({ feePayer: tx.feePayer ?? undefined, recentBlockhash: tx.recentBlockhash ?? undefined });
  changed.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PHANTOM_PRICE_MICROLAMPORTS }), ...tx.instructions);
  return { bytes: changed.serialize({ requireAllSignatures: false, verifySignatures: false }), addedPrice: true };
}
