/**
 * "Recompute it yourself": the nine verifier rules of plan part-core 3.8 as pure functions over the public view of a request.
 * Rules 1 to 5 are cryptographic and need nothing but the view (the room chip and the verify page run them offline in the
 * browser). Rules 6 to 9 read the chain through a `VrfRpc` and are best effort: an RPC that cannot answer gives
 * "unverifiable", never a green tick. Browser safe; no Node APIs.
 *
 *   1 params_hash    sha256(canonical params) equals the committed hash
 *   2 alpha          the alpha text is rebuilt from cluster, purpose, request id, params hash and beacon
 *   3 proof          the RFC 9381 proof verifies under the public key for that alpha
 *   4 output         the verified output equals the stored output
 *   5 result         the result derived from the output equals the stored result
 *   6 commit_memo    the commit tx carries the exact commit memo, signed by the VRF key, in the stored slot
 *   7 beacon         the beacon is the first confirmed slot at or after commit + 32 and its blockhash matches
 *   8 reveal_memo    the reveal tx carries the same proof and beacon, after the beacon, not later than reveal-by
 *   9 single_commit  the VRF address has exactly one commit memo for this request id (and at most one reveal)
 */
import { ALPHA_PURPOSE_OF, type VrfRequestView } from './types';
import { buildAlpha } from './alpha';
import { fromHex } from './bytes';
import { paramsHashOf, canonicalJson } from './canonical';
import { lotOrderParams, raffleParams } from './commitment';
import { lotOrderFromOutput, raffleWinnerFromOutput } from './derive';
import { buildCommitMemo, buildRevealMemo, parseMemo } from './memo';
import { vrfVerify } from './prove';
import type { VrfRpc } from './rpc';

export type CheckId = 'params_hash' | 'alpha' | 'proof' | 'output' | 'result' | 'commit_memo' | 'beacon' | 'reveal_memo' | 'single_commit';
export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'unverifiable';
export interface Check { id: CheckId; kind: 'crypto' | 'chain'; status: CheckStatus; detail?: string }

export const CHAIN_CHECK_IDS: readonly CheckId[] = ['commit_memo', 'beacon', 'reveal_memo', 'single_commit'];
/** The beacon is looked for in this window after the commit slot (plan part-core 3.3). */
export const BEACON_OFFSET_SLOTS = 32;
export const BEACON_WINDOW_SLOTS = 64;
const MAX_SIG_PAGES = 30;

const mk = (id: CheckId, status: CheckStatus, detail?: string): Check => ({ id, kind: CHAIN_CHECK_IDS.includes(id) ? 'chain' : 'crypto', status, ...(detail ? { detail } : {}) });
const pass = (id: CheckId, detail?: string) => mk(id, 'pass', detail);
const fail = (id: CheckId, detail: string) => mk(id, 'fail', detail);
const skip = (id: CheckId, detail: string) => mk(id, 'skipped', detail);

const revealByUnix = (v: VrfRequestView): number => Math.floor(Date.parse(v.revealBy) / 1000);
const sameJson = (a: unknown, b: unknown): boolean => { try { return canonicalJson(a) === canonicalJson(b); } catch { return false; } };

/** What the output must produce for this view, or a reason it cannot be checked. */
export function deriveResult(view: Pick<VrfRequestView, 'purpose' | 'params'>, output: Uint8Array): { ok: true; expected: Record<string, unknown> } | { ok: false; reason: string } {
  try {
    if (view.purpose === 'lot_order') {
      const p = view.params as { lots: { id: string; n: number }[]; show: string };
      const canon = lotOrderParams(p.show, p.lots);
      if (!sameJson(canon, view.params)) return { ok: false, reason: 'params are not in canonical form' };
      return { ok: true, expected: { order: lotOrderFromOutput(output, canon.lots.map((l) => l.id)) } };
    }
    if (view.purpose === 'raffle') {
      const p = view.params as { entrants: number[]; show: string };
      const canon = raffleParams(p.show, p.entrants);
      if (!sameJson(canon, view.params)) return { ok: false, reason: 'params are not in canonical form' };
      return { ok: true, expected: { winnerPaddle: raffleWinnerFromOutput(output, canon.entrants), entrants: canon.entrants } };
    }
    return { ok: true, expected: {} }; // pack_epoch: the epoch output is the result; each pull derives its own values
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Rules 1 to 5. Synchronous, no network. */
export function verifyCrypto(view: VrfRequestView): Check[] {
  const out: Check[] = [];
  let hash = false;
  try {
    hash = paramsHashOf(view.params) === view.paramsHash;
  } catch { /* not canonicalisable: fail below */ }
  out.push(hash ? pass('params_hash') : fail('params_hash', 'the stored parameters do not hash to the committed value'));

  const rest = (status: 'skipped', why: string) => (['alpha', 'proof', 'output', 'result'] as const).map((id) => mk(id, status, why));
  if (view.status === 'defaulted') return [...out, ...rest('skipped', 'not revealed in time: the catalogue order applies')];
  const complete = view.alphaText && view.beacon && view.proofHex && view.outputHex;
  if (!complete) {
    return [...out, ...(view.status === 'revealed' ? (['alpha', 'proof', 'output', 'result'] as const).map((id) => fail(id, 'the proof package is incomplete')) : rest('skipped', 'not revealed yet'))];
  }

  let alphaOk = false;
  try {
    alphaOk = buildAlpha({ cluster: view.cluster, purpose: ALPHA_PURPOSE_OF[view.purpose], subject: view.id, paramsHash: view.paramsHash, beacon: view.beacon! }) === view.alphaText;
  } catch { /* malformed field */ }
  out.push(alphaOk ? pass('alpha') : fail('alpha', 'the input text does not match request, parameters and beacon'));

  let beta: string | null = null;
  try { beta = vrfVerify(view.publicKey, view.alphaText!, view.proofHex!); } catch (e) { out.push(fail('proof', (e as Error).message)); }
  if (beta === null) return [...out, mk('output', 'skipped', 'needs a valid proof'), mk('result', 'skipped', 'needs a valid proof')];
  out.push(pass('proof'));
  out.push(beta === view.outputHex ? pass('output') : fail('output', 'the stored output differs from the verified one'));

  const d = deriveResult(view, fromHex(beta, 64));
  if (!d.ok) out.push(fail('result', d.reason));
  else if (view.result === null || typeof view.result !== 'object') out.push(fail('result', 'no result stored'));
  else {
    const r = view.result as Record<string, unknown>;
    const same = Object.entries(d.expected).every(([k, v]) => sameJson(r[k], v));
    out.push(same ? pass('result') : fail('result', 'the stored result is not what the output derives'));
  }
  return out;
}

/** Rules 6 to 9. Any RPC failure becomes "unverifiable" for that rule only. */
export async function verifyChain(view: VrfRequestView, rpc: VrfRpc): Promise<Check[]> {
  const guard = async (id: CheckId, f: () => Promise<Check>): Promise<Check> => {
    try { return await f(); } catch (e) { return mk(id, 'unverifiable', `RPC: ${(e as Error).message}`); }
  };
  const byUnix = revealByUnix(view);
  const revealed = view.status === 'revealed';

  const commitMemo = guard('commit_memo', async () => {
    if (!view.commitTx || view.commitSlot === null) return skip('commit_memo', 'no commit yet');
    const tx = await rpc.getTx(view.commitTx);
    if (!tx) return mk('commit_memo', 'unverifiable', 'the RPC does not have this transaction');
    if (tx.failed) return fail('commit_memo', 'the commit transaction failed');
    if (tx.slot !== view.commitSlot) return fail('commit_memo', 'the commit slot differs from the chain');
    if (!tx.signers.includes(view.publicKey)) return fail('commit_memo', 'the commit is not signed by the VRF key');
    let want: string;
    try { want = buildCommitMemo(view.id, view.paramsHash, byUnix); } catch (e) { return fail('commit_memo', (e as Error).message); }
    return tx.memos.includes(want) ? pass('commit_memo') : fail('commit_memo', 'the commit memo does not hold this request, hash and deadline');
  });

  const beacon = guard('beacon', async () => {
    if (!revealed || !view.beacon || view.commitSlot === null) return skip('beacon', 'not revealed yet');
    const slots = await rpc.getBlocks(view.commitSlot + BEACON_OFFSET_SLOTS, view.commitSlot + BEACON_WINDOW_SLOTS);
    if (slots.length === 0) return mk('beacon', 'unverifiable', 'the RPC returned no confirmed slot in the window');
    if (slots[0] !== view.beacon.slot) return fail('beacon', 'the beacon slot is not the first confirmed slot after the commit');
    const h = await rpc.getBlockhash(view.beacon.slot);
    if (h === null) return mk('beacon', 'unverifiable', 'the RPC no longer has this block');
    return h === view.beacon.blockhash ? pass('beacon') : fail('beacon', 'the blockhash differs from the chain');
  });

  const revealMemo = guard('reveal_memo', async () => {
    if (!revealed || !view.beacon || !view.proofHex) return skip('reveal_memo', 'not revealed yet');
    if (!view.revealTx) return fail('reveal_memo', 'no reveal transaction stored');
    const tx = await rpc.getTx(view.revealTx);
    if (!tx) return mk('reveal_memo', 'unverifiable', 'the RPC does not have this transaction');
    if (tx.failed) return fail('reveal_memo', 'the reveal transaction failed');
    if (!tx.signers.includes(view.publicKey)) return fail('reveal_memo', 'the reveal is not signed by the VRF key');
    let want: string;
    try { want = buildRevealMemo(view.id, view.beacon, view.proofHex); } catch (e) { return fail('reveal_memo', (e as Error).message); }
    if (!tx.memos.includes(want)) return fail('reveal_memo', 'the reveal memo does not hold this proof and beacon');
    if (tx.slot <= view.beacon.slot) return fail('reveal_memo', 'the reveal is not after the beacon block');
    if (tx.blockTime === null) return mk('reveal_memo', 'unverifiable', 'the RPC has no block time for the reveal');
    return tx.blockTime <= byUnix ? pass('reveal_memo') : fail('reveal_memo', 'the reveal was written after the deadline');
  });

  const single = guard('single_commit', async () => {
    if (!view.commitTx) return skip('single_commit', 'no commit yet');
    let commits = 0, reveals = 0, before: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_SIG_PAGES) return mk('single_commit', 'unverifiable', 'the key has too many transactions to scan here');
      const sigs = await rpc.getSignatures(view.publicKey, before);
      for (const s of sigs) {
        if (s.failed) continue;
        for (const m of s.memos) {
          const p = parseMemo(m);
          if (p?.kind === 'commit' && p.requestId === view.id) commits++;
          if (p?.kind === 'reveal' && p.requestId === view.id) reveals++;
        }
      }
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1]!.signature;
    }
    if (commits !== 1) return fail('single_commit', `${commits} commit memos found, expected exactly one`);
    return reveals > 1 ? fail('single_commit', `${reveals} reveal memos found, expected at most one`) : pass('single_commit');
  });

  return Promise.all([commitMemo, beacon, revealMemo, single]);
}

/** All nine checks in rule order. Without `rpc` the four chain checks are "skipped". */
export async function verifyRequest(view: VrfRequestView, opts: { rpc?: VrfRpc } = {}): Promise<Check[]> {
  const crypto = verifyCrypto(view);
  const chain = opts.rpc ? await verifyChain(view, opts.rpc) : CHAIN_CHECK_IDS.map((id) => skip(id, 'no RPC given'));
  return [...crypto, ...chain];
}

/** True only when every cryptographic rule passed on this machine. The only state that may show "proven" in the UI. */
export const isLocallyProven = (checks: readonly Check[]): boolean => {
  const c = checks.filter((x) => x.kind === 'crypto');
  return c.length === 5 && c.every((x) => x.status === 'pass');
};
export const hasFailure = (checks: readonly Check[]): boolean => checks.some((c) => c.status === 'fail');
