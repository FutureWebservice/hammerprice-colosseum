/**
 * After the transaction landed: did what we asked for actually happen? Reads a `getTransaction` (jsonParsed) result and
 * checks the token balance deltas per owner, the memo, and that the card now belongs to the buyer. `settled` is written
 * only when this says ok; a transaction that confirmed with different effects is `failed`, never `settled` on a guess.
 */
import type { ExpectedSettlement } from '@/contracts';

export interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }
export interface ParsedTx {
  slot?: number;
  meta: { err: unknown | null; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { message: { instructions?: { program?: string; programId?: string; parsed?: unknown }[] } };
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'tx_failed' | 'delta_mismatch' | 'memo_mismatch' | 'owner_mismatch'; detail: string };

/** Sum of balance change per token-account owner for one mint. */
export function tokenDeltas(meta: NonNullable<ParsedTx['meta']>, mint: string): Map<string, bigint> {
  const d = new Map<string, bigint>();
  const add = (list: TokenBalance[] | undefined, sign: 1n | -1n) => {
    for (const b of list ?? []) if (b.mint === mint && b.owner) d.set(b.owner, (d.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  add(meta.postTokenBalances, 1n);
  add(meta.preTokenBalances, -1n);
  return d;
}

/** The money and the memo of a landed transaction (everything `verifySettled` checks except where the card went). */
export function verifyLegs(tx: ParsedTx | null, e: ExpectedSettlement): VerifyResult {
  if (!tx?.meta) return { ok: false, code: 'tx_failed', detail: 'transaction not found' };
  if (tx.meta.err !== null) return { ok: false, code: 'tx_failed', detail: JSON.stringify(tx.meta.err).slice(0, 200) };
  const fee = BigInt(e.platformFee), royalty = BigInt(e.royalty), gross = BigInt(e.gross);
  const want = new Map<string, bigint>([[e.buyer, -gross]]);
  const credit = (who: string, n: bigint) => want.set(who, (want.get(who) ?? 0n) + n);
  credit(e.seller, gross - fee - royalty);
  credit(e.feeWallet, fee);
  if (e.royaltyRecipient) credit(e.royaltyRecipient, royalty);
  const got = tokenDeltas(tx.meta, e.usdcMint);
  for (const who of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(who) ?? 0n, g = got.get(who) ?? 0n;
    if (w !== g) return { ok: false, code: 'delta_mismatch', detail: `${who}: expected ${w}, got ${g}` };
  }
  const memos = (tx.transaction.message.instructions ?? []).filter((i) => i.program === 'spl-memo').map((i) => i.parsed);
  if (memos.length !== 1 || memos[0] !== e.memo) return { ok: false, code: 'memo_mismatch', detail: 'settlement memo missing or different' };
  return { ok: true };
}

export function verifySettled(tx: ParsedTx | null, e: ExpectedSettlement, assetOwnerNow: string | null): VerifyResult {
  const legs = verifyLegs(tx, e);
  if (!legs.ok) return legs;
  if (assetOwnerNow !== e.buyer) return { ok: false, code: 'owner_mismatch', detail: `asset owner is ${assetOwnerNow ?? 'unknown'}, not the buyer` };
  return { ok: true };
}
