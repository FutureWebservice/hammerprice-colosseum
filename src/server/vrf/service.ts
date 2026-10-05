/**
 * Verifiable randomness (FEATURE_VRF): requests, the state machine, the public view.
 *
 *   pending   created (or the commit transaction is on its way)
 *   committed the commit memo is FINAL; nothing the operator does can change the input any more
 *   revealed  beacon, proof and result are final (reveal memo final, in time)
 *   defaulted the reveal missed its deadline: the catalogue order applies, a late reveal is NOT accepted
 *
 * `advance(id)` is idempotent and takes one lease per request (`lease_until`), so any number of callers (the room chip of every viewer, the
 * sweep, the `after()` of the rollover) move a draw along without sending anything twice. Rules that make a transaction safe to repeat:
 * a transaction is built and STORED before it is sent (a crash sends the same bytes again, never a second commit), a stored transaction is
 * only dropped once its blockhash can no longer land AND the chain does not know its signature, and no chain call runs inside a database
 * transaction. Nothing here is called from the snapshot path or the engine: those only read `vrf_requests.status`.
 *
 * Cluster-agnostic: the cluster, the RPC and the keys come from `VrfDeps` (defaultDeps reads the one config); a row of another cluster is
 * never driven. The VRF key signs only the memo transactions of this file.
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { ApiError, type Cluster } from '@/contracts';
import { db, lots, packDraws, vrfRequests } from '@/db';
import { resolveCluster } from '@/lib/chain/config';
import { settlementAuthority } from '@/lib/chain/keys';
import { rateLimit } from '@/lib/http/ratelimit';
import {
  ALPHA_PURPOSE_OF, buildAlpha, buildCommitMemo, buildRevealMemo, commitmentOf, fromHex, lotOrderFromOutput, lotOrderParams, raffleParams, raffleWinnerFromOutput,
  BEACON_OFFSET_SLOTS, BEACON_WINDOW_SLOTS, type VrfPurpose, type VrfRequestView,
} from '@/lib/vrf';
import type { VrfKey } from '@/lib/vrf/key';
import type { Keypair } from '@solana/web3.js';
import { isDrawRevealed } from '@/server/packs/views';
import { applyLotOrder } from './apply-order';
import { blockhashOfTx, buildMemoTx, createRpcChain, type VrfChain } from './chain';
import { vrfKey } from './key';

type Env = Record<string, string | undefined>;
export type VrfRow = typeof vrfRequests.$inferSelect;

export const SUITE = 'ECVRF-EDWARDS25519-SHA512-TAI' as const;
const LEASE_S = 40;
const POLL_MS = 1500;
const MAX_ATTEMPTS = 6;
/** The settlement authority pays these memos; below this balance a draw is not started (the catalogue order applies). */
const MIN_SA_LAMPORTS: Record<Cluster, bigint> = { devnet: 500_000_000n, 'mainnet-beta': 50_000_000n };

export interface VrfDeps {
  chain: VrfChain;
  key: VrfKey;
  /** Fee payer of every memo transaction. Holds no authority over anything a user owns. */
  sa: Keypair;
  cluster: Cluster;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  env: Env;
  /** How long one `advance` may keep polling before it returns (the route's maxDuration bounds it as well). */
  budgetMs: number;
}

const intEnv = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };

/** The deployment's own deps. `feature_off` when there is no key (the feature does not exist then). */
export function defaultDeps(env: Env = process.env): VrfDeps {
  const key = vrfKey(env);
  if (!key) throw new ApiError('feature_off', 'Not found');
  const cluster = resolveCluster(env);
  return {
    chain: createRpcChain(cluster), key, sa: settlementAuthority(env), cluster, env, budgetMs: 40_000,
    now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ---- requests -------------------------------------------------------------------------------------------------

export interface NewRequest { purpose: 'lot_order' | 'raffle'; showId: string; params: unknown; revealWindowS: number }

/** Inserts the request (one per purpose and show, ever) and returns its id; an existing request is returned as it is. */
export async function createRequest(a: NewRequest, d: Pick<VrfDeps, 'key' | 'now' | 'env'>): Promise<{ id: string; created: boolean }> {
  const { paramsHash } = commitmentOf(a.params);
  const revealBy = new Date(Math.floor(d.now().getTime() / 1000 + a.revealWindowS) * 1000); // whole seconds: the commit memo carries them
  const [row] = await db.insert(vrfRequests).values({
    purpose: a.purpose, subjectType: 'show', subjectId: a.showId, cluster: resolveCluster(d.env), publicKey: d.key.publicKey,
    params: a.params as Record<string, unknown>, paramsHash, revealBy,
  }).onConflictDoNothing().returning({ id: vrfRequests.id });
  if (row) return { id: row.id, created: true };
  const [old] = await db.select({ id: vrfRequests.id }).from(vrfRequests)
    .where(and(eq(vrfRequests.purpose, a.purpose), eq(vrfRequests.subjectType, 'show'), eq(vrfRequests.subjectId, a.showId)));
  return { id: old!.id, created: false };
}

/** The draw of a show's lot order: commits to the lots as they are now (their ids and numbers). null when the show has no lots. */
export async function requestLotOrder(showId: string, d: Pick<VrfDeps, 'key' | 'now' | 'env'> & { revealWindowS?: number }): Promise<{ id: string; created: boolean } | null> {
  const rows = await db.select({ id: lots.id, n: lots.lotNumber }).from(lots).where(eq(lots.showId, showId)).orderBy(asc(lots.lotNumber));
  if (rows.length === 0) return null;
  return createRequest({ purpose: 'lot_order', showId, params: lotOrderParams(showId, rows), revealWindowS: d.revealWindowS ?? intEnv(d.env.VRF_REVEAL_WINDOW_HOUSE_S, 120) }, d);
}

export { raffleParams };

// ---- the public view --------------------------------------------------------------------------------------------

/**
 * What the API shows. Beacon, proof and output appear only once the request is `revealed`: before that they are working state of the
 * server (the verifier treats a request without them as "not revealed yet"). Transaction bytes and the lease never appear.
 */
export function toView(r: VrfRow): VrfRequestView {
  const revealed = r.status === 'revealed';
  return {
    id: r.id,
    purpose: r.purpose as VrfPurpose,
    subject: { type: r.subjectType, id: r.subjectId },
    status: r.status as VrfRequestView['status'],
    cluster: r.cluster as Cluster,
    publicKey: r.publicKey,
    params: r.params,
    paramsHash: r.paramsHash,
    alphaText: revealed ? r.alphaText : null,
    beacon: revealed && r.beaconSlot !== null && r.beaconBlockhash ? { slot: r.beaconSlot, blockhash: r.beaconBlockhash } : null,
    commitTx: r.commitSlot !== null ? r.commitSignature : null,
    commitSlot: r.commitSlot,
    revealBy: r.revealBy.toISOString(),
    proofHex: revealed ? r.proofHex : null,
    outputHex: revealed ? r.outputHex : null,
    revealTx: revealed ? r.revealSignature : null,
    result: r.status === 'revealed' || r.status === 'defaulted' ? r.result : null,
  };
}

export async function getRow(id: string): Promise<VrfRow | null> {
  const [r] = await db.select().from(vrfRequests).where(eq(vrfRequests.id, id));
  return r ?? null;
}
/**
 * A pack draw's row holds the proof and the result from the moment the card is reserved, but the buyer may only learn it with the payment
 * (the pack rule: the result after the payment). Until its draw is settled, failed or expired, the public view of such a row is a bare shell.
 * The pool commitment row (subject `pack:<id>`) is public from the start.
 */
export function hideUnpaidDraw(v: VrfRequestView): VrfRequestView {
  return { ...v, params: {}, paramsHash: '0'.repeat(64), alphaText: null, beacon: null, proofHex: null, outputHex: null, revealTx: null, result: null };
}
/** The ONE gate every public exit goes through (getView, advance, any other read): a pack draw's result is a bare shell until its purchase ended. */
export async function gatedView(r: VrfRow): Promise<VrfRequestView> {
  const v = toView(r);
  if (r.subjectType !== 'pack_draw' || r.subjectId.startsWith('pack:')) return v;
  const [d] = await db.select({ status: packDraws.status }).from(packDraws).where(eq(packDraws.id, r.subjectId));
  return !d || isDrawRevealed(d.status) ? v : hideUnpaidDraw(v);
}
export async function getView(id: string): Promise<VrfRequestView | null> {
  const r = await getRow(id);
  return r ? gatedView(r) : null;
}

/** The draws of one show, for the chip and the verify page. */
export async function showDraws(showId: string): Promise<{ lotOrder: { requestId: string; status: VrfRequestView['status'] } | null; raffle: { requestId: string; status: VrfRequestView['status'] } | null }> {
  const rows = await db.select({ id: vrfRequests.id, purpose: vrfRequests.purpose, status: vrfRequests.status }).from(vrfRequests)
    .where(and(eq(vrfRequests.subjectType, 'show'), eq(vrfRequests.subjectId, showId), inArray(vrfRequests.purpose, ['lot_order', 'raffle'])));
  const pick = (p: string) => { const r = rows.find((x) => x.purpose === p); return r ? { requestId: r.id, status: r.status as VrfRequestView['status'] } : null; };
  return { lotOrder: pick('lot_order'), raffle: pick('raffle') };
}

/** Counters of the key page: a commit that is never revealed stays visible as a commit without a reveal. */
export async function keyStats(d: { key: VrfKey; env: Env }): Promise<{ commits: number; reveals: number; defaults: number }> {
  const res = await db.execute(sql`
    select count(*) filter (where commit_slot is not null)::int as commits,
           count(*) filter (where status = 'revealed')::int as reveals,
           count(*) filter (where status = 'defaulted')::int as defaults
    from vrf_requests where public_key = ${d.key.publicKey} and cluster = ${resolveCluster(d.env)}`);
  const row = ((res as unknown as { rows?: Record<string, number>[] }).rows ?? (res as unknown as Record<string, number>[]))[0] ?? {};
  return { commits: Number(row.commits ?? 0), reveals: Number(row.reveals ?? 0), defaults: Number(row.defaults ?? 0) };
}

// ---- the state machine ------------------------------------------------------------------------------------------

type Step = { row: VrfRow; next: 'again' | 'wait' | 'stop' };
const terminal = (r: VrfRow) => r.status !== 'pending' && r.status !== 'committed';
const revealByUnix = (r: VrfRow) => Math.floor(r.revealBy.getTime() / 1000);

/** One lease per request: returns the row when this caller now holds it, null when it is busy, finished or unknown. */
async function acquire(id: string): Promise<VrfRow | null> {
  const [row] = await db.update(vrfRequests).set({ leaseUntil: sql`now() + make_interval(secs => ${LEASE_S})` }).where(and(
    eq(vrfRequests.id, id), inArray(vrfRequests.status, ['pending', 'committed']), or(isNull(vrfRequests.leaseUntil), lt(vrfRequests.leaseUntil, sql`now()`)),
  )).returning();
  return row ?? null;
}
const release = (id: string) => db.update(vrfRequests).set({ leaseUntil: null }).where(eq(vrfRequests.id, id)).then(() => undefined);

/** Writes `set` only while the request is still open (a defaulted request never changes again). */
async function patch(r: VrfRow, set: Partial<typeof vrfRequests.$inferInsert>): Promise<VrfRow | null> {
  const [row] = await db.update(vrfRequests).set(set).where(and(eq(vrfRequests.id, r.id), inArray(vrfRequests.status, ['pending', 'committed']))).returning();
  return row ?? null;
}

/** Whether the settlement authority may pay for one more memo: balance above the floor and the daily cap not reached. */
async function mayWrite(d: VrfDeps): Promise<boolean> {
  const floor = MIN_SA_LAMPORTS[d.cluster];
  if ((await d.chain.lamports(d.sa.publicKey.toBase58())) < floor) { console.warn('vrf: settlement authority balance is below the floor, not starting a draw step'); return false; }
  const cap = intEnv(d.env.SA_VRF_MEMOS_PER_DAY, 200);
  const r = await rateLimit(`vrf:memos:${d.cluster}`, cap, 86400, { nowMs: d.now().getTime() });
  if (!r.ok) console.warn('vrf: the daily memo cap is reached, not starting a draw step');
  return r.ok;
}

/** The deadline passed: record the catalogue order (a pure database update, no chain I/O). A reveal that arrives later is not accepted. */
export async function defaultRequest(r: VrfRow, at: Date): Promise<void> {
  let result: unknown = null;
  if (r.purpose === 'lot_order') {
    const ls = (r.params as { lots: { id: string; n: number }[] }).lots;
    result = { order: [...ls].sort((a, b) => a.n - b.n).map((l) => l.id), applied: false };
  }
  await db.update(vrfRequests).set({ status: 'defaulted', defaultedAt: at, result: result as never })
    .where(and(eq(vrfRequests.id, r.id), inArray(vrfRequests.status, ['pending', 'committed'])));
}

async function stepCommitSend(r: VrfRow, d: VrfDeps): Promise<Step> {
  if (!(await mayWrite(d))) return { row: r, next: 'stop' };
  const memo = buildCommitMemo(r.id, r.paramsHash, revealByUnix(r));
  const tx = buildMemoTx(memo, d.sa, d.key.signer, await d.chain.latestBlockhash());
  const row = await patch(r, { commitTxB64: tx.base64, commitSignature: tx.signature, attempts: r.attempts + 1 }); // stored BEFORE it is sent
  if (!row) return { row: r, next: 'stop' };
  await trySend(d, tx.base64);
  return { row, next: 'wait' };
}

/** A send that fails is not an error of the draw: the state check decides whether the stored transaction is still alive. */
async function trySend(d: VrfDeps, base64: string): Promise<void> {
  try { await d.chain.send(base64); } catch (e) {
    if (e instanceof ApiError) console.warn('vrf: send failed', e.code); else throw e;
  }
}

/** Whether a stored transaction is still in the running: its blockhash can land, or the chain already knows it. */
type Stored = { state: 'final'; slot: number } | { state: 'failed' } | { state: 'landed' } | { state: 'alive' } | { state: 'dead' };
async function stored(d: VrfDeps, base64: string, signature: string): Promise<Stored> {
  const valid = await d.chain.isBlockhashValid(blockhashOfTx(base64)); // asked BEFORE the status: a transaction that lands in between shows up in the status
  const st = await d.chain.status(signature);
  if (st) {
    if (st.err) return { state: 'failed' };
    return st.level === 'finalized' ? { state: 'final', slot: st.slot } : { state: 'landed' }; // on the chain, waiting for finality: nothing to send again
  }
  return valid ? { state: 'alive' } : { state: 'dead' };
}

async function stepCommitCheck(r: VrfRow, d: VrfDeps): Promise<Step> {
  const s = await stored(d, r.commitTxB64!, r.commitSignature!);
  if (s.state === 'final') {
    const row = await patch(r, { status: 'committed', commitSlot: s.slot });
    return row ? { row, next: 'again' } : { row: r, next: 'stop' };
  }
  if (s.state === 'landed') return { row: r, next: 'wait' };
  if (s.state === 'alive') { await trySend(d, r.commitTxB64!); return { row: r, next: 'wait' }; } // not on the chain yet: sending the same bytes again is harmless
  const row = await patch(r, { commitTxB64: null, commitSignature: null }); // can no longer land: the next attempt builds a fresh one
  return row ? { row, next: 'again' } : { row: r, next: 'stop' };
}

/** Beacon known: build the proof and the result, store the reveal transaction, send it. `wait` while the beacon block is not final yet. */
async function stepRevealSend(r: VrfRow, d: VrfDeps): Promise<Step> {
  const commitSlot = r.commitSlot!;
  if ((await d.chain.finalizedSlot()) < commitSlot + BEACON_OFFSET_SLOTS) return { row: r, next: 'wait' };
  const slots = await d.chain.blocks(commitSlot + BEACON_OFFSET_SLOTS, commitSlot + BEACON_WINDOW_SLOTS);
  if (slots.length === 0) return { row: r, next: 'wait' };
  const beacon = { slot: slots[0]!, blockhash: (await d.chain.blockhashOf(slots[0]!)) ?? '' };
  if (!beacon.blockhash) return { row: r, next: 'wait' };
  if (d.key.publicKey !== r.publicKey) { console.error('vrf: the key of this deployment is not the key of the request'); return { row: r, next: 'stop' }; }
  const alphaText = buildAlpha({ cluster: r.cluster as Cluster, purpose: ALPHA_PURPOSE_OF[r.purpose as VrfPurpose], subject: r.id, paramsHash: r.paramsHash, beacon });
  const { proofHex, outputHex } = d.key.prove(alphaText);
  if (!(await mayWrite(d))) return { row: r, next: 'stop' };
  const tx = buildMemoTx(buildRevealMemo(r.id, beacon, proofHex), d.sa, d.key.signer, await d.chain.latestBlockhash());
  const row = await patch(r, {
    alphaText, proofHex, outputHex, beaconSlot: beacon.slot, beaconBlockhash: beacon.blockhash,
    revealTxB64: tx.base64, revealSignature: tx.signature, attempts: r.attempts + 1,
  });
  if (!row) return { row: r, next: 'stop' };
  await trySend(d, tx.base64);
  return { row, next: 'wait' };
}

/** The result a revealed request carries, derived in public from the output (lib/vrf/derive.ts). */
export function resultOf(r: Pick<VrfRow, 'purpose' | 'params' | 'outputHex'>): { order: string[] } | { winnerPaddle: number; entrants: number[] } {
  const output = fromHex(r.outputHex!, 64);
  if (r.purpose === 'raffle') {
    const e = (r.params as { entrants: number[] }).entrants;
    return { winnerPaddle: raffleWinnerFromOutput(output, e), entrants: e };
  }
  const ls = (r.params as { lots: { id: string; n: number }[] }).lots;
  return { order: lotOrderFromOutput(output, [...ls].sort((a, b) => a.n - b.n).map((l) => l.id)) };
}

/** The reveal is final and on time: result and status in one transaction (with the renumbering of a lot order). */
async function applyReveal(r: VrfRow, d: VrfDeps): Promise<VrfRow | null> {
  const result = resultOf(r);
  return db.transaction(async (tx) => {
    if (r.purpose === 'lot_order') await tx.execute(sql`select 1 from shows where id = ${r.subjectId} for no key update`); // the engine's lock: serialises with the tick that may default this draw
    const [row] = await tx.update(vrfRequests).set({ status: 'revealed', revealedAt: d.now(), result: result as never })
      .where(and(eq(vrfRequests.id, r.id), eq(vrfRequests.status, 'committed'))).returning();
    if (!row) return null; // defaulted meanwhile: that decision stands
    if (r.purpose !== 'lot_order') return row;
    const applied = await applyLotOrder(tx, r.subjectId, (result as { order: string[] }).order);
    const [final] = await tx.update(vrfRequests).set({ result: { ...result, applied } as never }).where(eq(vrfRequests.id, r.id)).returning();
    return final!;
  });
}

async function stepRevealCheck(r: VrfRow, d: VrfDeps): Promise<Step> {
  const s = await stored(d, r.revealTxB64!, r.revealSignature!);
  if (s.state === 'final') {
    const t = await d.chain.blockTime(s.slot);
    if (t === null) return { row: r, next: 'wait' };
    if (t > revealByUnix(r)) { await defaultRequest(r, d.now()); return { row: r, next: 'stop' }; } // landed after the deadline: not accepted
    const row = await applyReveal(r, d);
    return row ? { row, next: 'stop' } : { row: r, next: 'stop' };
  }
  if (s.state === 'landed') return { row: r, next: 'wait' };
  if (s.state === 'alive') { await trySend(d, r.revealTxB64!); return { row: r, next: 'wait' }; }
  const row = await patch(r, { revealTxB64: null, revealSignature: null, alphaText: null, proofHex: null, outputHex: null, beaconSlot: null, beaconBlockhash: null });
  return row ? { row, next: 'again' } : { row: r, next: 'stop' };
}

async function step(r: VrfRow, d: VrfDeps): Promise<Step> {
  if (terminal(r)) return { row: r, next: 'stop' };
  if (d.now().getTime() >= r.revealBy.getTime()) { await defaultRequest(r, d.now()); return { row: r, next: 'stop' }; }
  if (r.attempts >= MAX_ATTEMPTS && !r.commitTxB64 && !r.revealTxB64) return { row: r, next: 'stop' }; // gave up: the deadline defaults it
  if (r.status === 'pending') return r.commitTxB64 ? stepCommitCheck(r, d) : stepCommitSend(r, d);
  return r.revealTxB64 ? stepRevealCheck(r, d) : stepRevealSend(r, d);
}

/**
 * Moves a draw along as far as it can go within `budgetMs`. Always returns the current public view; a request that is busy (another
 * caller holds the lease), finished or from another cluster is returned unchanged. `null` for an unknown id.
 */
export async function advance(id: string, d: VrfDeps): Promise<VrfRequestView | null> {
  const first = await getRow(id);
  if (!first) return null;
  if (terminal(first) || first.cluster !== d.cluster) return gatedView(first);
  let row = await acquire(id);
  if (!row) return gatedView(first);
  try {
    let virtual = 0;
    const started = Date.now();
    for (let i = 0; i < 60; i++) {
      const s = await step(row, d);
      row = s.row;
      if (s.next === 'stop') break;
      if (s.next === 'wait') {
        if (virtual >= d.budgetMs || Date.now() - started >= d.budgetMs) break;
        await d.sleep(POLL_MS);
        virtual += POLL_MS;
        row = (await getRow(id)) ?? row;
      }
    }
  } finally {
    await release(id);
  }
  return (await getView(id)) ?? gatedView(row);
}

/**
 * The sweep: draws that nobody is watching still progress, and a draw whose deadline passed is defaulted. At most `limit` per call, oldest first.
 * Returns the number of requests it touched.
 */
export async function sweepRequests(d: VrfDeps, limit = 5): Promise<number> {
  const open = await db.select().from(vrfRequests).where(and(inArray(vrfRequests.status, ['pending', 'committed']), eq(vrfRequests.cluster, d.cluster)))
    .orderBy(asc(vrfRequests.createdAt)).limit(limit);
  for (const r of open) {
    if (d.now().getTime() >= r.revealBy.getTime()) await defaultRequest(r, d.now());
    else await advance(r.id, { ...d, budgetMs: Math.min(d.budgetMs, 15_000) });
  }
  return open.length;
}
