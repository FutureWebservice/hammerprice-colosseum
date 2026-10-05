/**
 * After the purchase landed: did what we asked for happen? Reads a `getTransaction` (jsonParsed) result and checks, for the USDC mint
 * OF THE CLUSTER, that the buyer lost exactly `amount`, the fee wallet gained exactly `amount`, nobody else's USDC moved, and that there
 * is exactly one memo equal to the expected one. Credits are booked only when this says ok.
 */
import { tokenDeltas, type ParsedTx } from './verify-settled';
import type { ExpectedCredit } from './credit-tx';

export type CreditVerify = { ok: true } | { ok: false; code: 'tx_failed' | 'delta_mismatch' | 'memo_mismatch'; detail: string };

export function verifyCreditPaid(tx: ParsedTx | null, e: ExpectedCredit): CreditVerify {
  if (!tx?.meta) return { ok: false, code: 'tx_failed', detail: 'transaction not found' };
  if (tx.meta.err !== null) return { ok: false, code: 'tx_failed', detail: JSON.stringify(tx.meta.err).slice(0, 200) };
  const amount = BigInt(e.amount);
  const want = new Map<string, bigint>([[e.buyer, -amount], [e.feeWallet, amount]]);
  const got = tokenDeltas(tx.meta, e.usdcMint);
  for (const who of new Set([...want.keys(), ...got.keys()])) {
    const w = want.get(who) ?? 0n, g = got.get(who) ?? 0n;
    if (w !== g) return { ok: false, code: 'delta_mismatch', detail: `${who}: expected ${w}, got ${g}` };
  }
  const memos = (tx.transaction.message.instructions ?? []).filter((i) => i.program === 'spl-memo').map((i) => i.parsed);
  if (memos.length !== 1 || memos[0] !== e.memo) return { ok: false, code: 'memo_mismatch', detail: 'credit memo missing or different' };
  return { ok: true };
}
