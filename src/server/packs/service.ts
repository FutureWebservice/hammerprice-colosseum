/**
 * Packs (A10.3, changed 2026-10-03 by A13 and A14): a pack operator defines a pack with a pool of REAL cards they own and published odds. The pool and the
 * rules are committed by hash before the first sale; a draw is an ECVRF draw with a public proof. There are two flows, by pack mode:
 *
 *  - `equal_value` (every card the same listed value, nothing to cherry-pick; any operator): the ATOMIC co-sign rail of an auction. The card is
 *    drawn when the purchase opens, and the buyer pays the operator and the card moves to the buyer in ONE transaction. Hammerprice holds neither
 *    money nor cards (the settlement authority pays network fees only).
 *  - `chance` (a THIRD-PARTY operator who owns the cards; the house only as the devnet demo): PAY FIRST, DRAW AFTER (payfirst.ts). The buyer pays the
 *    OPERATOR WALLET directly (plus the platform fee leg); nothing goes to a platform wallet. No card is chosen or revealed anywhere until that payment is
 *    finalized on chain; then the draw runs over an input that contains the payment signature and the first block after it; the OPERATOR signs the delivery
 *    of the drawn card within a deadline. The platform holds no money, so it cannot refund: a draw not delivered in time is `undelivered`, strikes the operator
 *    and pauses the pack. The devnet house demo runs through the same flow, its delivery is signed by the server.
 *
 *   pack:   draft --publish (commits the pool, reads the beacon)--> live <--> paused;  live --pool empty--> sold_out;  any --> closed
 *   atomic: reserved --(both signed, SA added, sent)--> submitted --(confirmed and verified)--> settled
 *           reserved --(window passed)--> expired (card released);  reserved/submitted --(card gone, tx failed)--> failed
 *   pay_first: see the state machine at the top of payfirst.ts
 *
 * Rules that matter (the same discipline as settlement/service.ts, which this mirrors):
 *  - The draw is made under a row lock on the pack, so draw indexes are strictly increasing and a card is reserved by exactly one draw
 *    (a partial unique index backs it). Nothing holds a lock across a network call: chain reads happen before or after.
 *  - The result is fixed by (pool hash, buyer, seed, index, taken positions, beacon) and the VRF key; the server cannot choose it after it
 *    has seen the seed. It is shown to the public only after the purchase ended (views.ts).
 *  - `settled` is written only after the confirmed transaction's token deltas, memo and new owner verified on chain.
 *  - 18+ confirmation is recorded before the draw, the per-wallet daily cap is taken when a purchase opens (and given back when it never became a
 *    sale), there is no stored value: a purchase is one transaction or a payment to the operator plus a delivery.
 */
import { assertNotListed } from '@/server/assets/listed';
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Keypair } from '@solana/web3.js';
import type { db as DbInstance } from '@/db';
import { auditLogs, packDefinitions, packDraws, packPoolCards, packPurchaseCounts, vrfRequests } from '@/db/schema';
import {
  ApiError, PackCreateRequest, PackExpectedPayment, type Cluster, type PackControlRequest, type PackDetailResponse, type PackDrawsResponse, type PackDrawView, type PackOpenRequest,
  type PackDeliveryItem, type PackOpenResponse, type PackPayment, type PackSignResponse, type PackView, type PartyRole, type SignInput,
} from '@/contracts';
import { evaluateAssetReadiness } from '@/lib/chain/asset';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { invalidateBalance } from '@/lib/chain/funds';
import type { ChainPort } from '@/lib/chain/port';
import { assemblePackTx, buildUnsignedPackTx, extractPackSignature, signPackAs, verifyPackSettled } from '@/lib/chain/pack-tx';
import { splitGross } from '@/lib/auction/fees';
import { oddsHashOf, packDrawSubject, packMemo, poolHashOf, type PackDefinition } from '@/lib/packs/commit';
import { makeDraw } from '@/lib/packs/draw';
import { drawView, oddsOf, packView, poolCardViews, sortedCards, type CardRow, type DrawRow, type PackRow, type VrfRow } from './views';
import type { Beacon, ProofResult } from '@/lib/vrf';
import { createPayFirst, PAY_WINDOW_S } from './payfirst';
import { houseDemoAllowed } from './house';

type Db = typeof DbInstance;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const ROUND_S = 60;
/** How long a reserved card waits for its signatures: the house signs by itself, a third-party operator must be online. */
export const HOUSE_WINDOW_S = 300;
export const OPERATOR_WINDOW_S = 900;
const SEND_POLL_TIMEOUT_MS = 20_000;
const SWEEP_BATCH = 50;
const MAX_STRIKE_FREE_ABSENCES = 1;
export const POOL_VRF_PURPOSE = 'pack_draw';

export interface VrfSigner { publicKey: string; prove(alphaText: string): ProofResult }

export interface PackDeps {
  db: Db;
  chainFor: (cluster: Cluster) => ChainPort;
  /** SA: fee payer, rent payer, third signer. No authority over any card or any money. */
  sa: Keypair;
  /** The platform's own devnet demo wallet (platform-owned test cards). The server signs ITS delivery only (the demo); a third-party pack never uses it. */
  houseOperator: Keypair | null;
  /** null when VRF_SECRET_KEY is not set: no pack can be published and no draw made. */
  vrfKey: () => VrfSigner | null;
  /** A recent finalized block (slot and blockhash), read at publish. */
  beacon: (cluster: Cluster) => Promise<Beacon>;
  /** Pay-first: the first block produced after `slot` once it is finalized, or null while it is not. It did not exist when the buyer paid. */
  beaconAfter: (cluster: Cluster, slot: number) => Promise<Beacon | null>;
  usdcMint: (cluster: Cluster) => string;
  feeWallet: string;
  feeBps: number;
  defaultCluster: Cluster;
  now?: () => Date;
  roundS?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  assertCluster?: (cluster: Cluster) => void;
  /** Called right before SA adds its signature (the same daily budget as settlements). */
  spendGuard?: (kind: 'house' | 'third-party') => Promise<void>;
  newId?: () => string;
  /** A14: how long a third-party operator has to deliver a drawn card (seconds, default 24 h). */
  deliveryDeadlineS?: number;
  /** A14: a third-party purchase was just drawn (the operator must deliver) / its deadline is close. Notifications only; never throw into the flow. */
  onDrawn?: (drawId: string) => void;
  onDeliveryDue?: (drawId: string) => void;
  /**
   * Devnet house DEMO only: mints a copy of the drawn replica (`source`) into the buyer's wallet (SA pays) and returns its mint and the mint transaction, or null when it must
   * not (switched off). BEST EFFORT: it may throw (low SOL, RPC error); the draw and the reveal never depend on it. Absent: nothing is minted.
   */
  mintDemoCopy?: (i: { wallet: string; source: string }) => Promise<{ mint: string; signature: string } | null>;
}

export interface PackActor { id: string; wallet: string }

export interface PackService {
  create(actor: PackActor, req: PackCreateRequest, o?: { isHouse?: boolean }): Promise<PackView>;
  control(packId: string, actorProfileId: string, action: PackControlRequest['action']): Promise<PackView>;
  list(o?: { operatorProfileId?: string }): Promise<PackView[]>;
  detail(packId: string, viewerProfileId?: string | null): Promise<PackDetailResponse>;
  open(buyer: PackActor, packId: string, input: PackOpenRequest): Promise<PackOpenResponse>;
  prepareDraw(drawId: string, actorProfileId: string | null): Promise<PackPayment>;
  signDraw(drawId: string, actorProfileId: string, input: SignInput): Promise<PackSignResponse>;
  getDraw(drawId: string): Promise<PackDrawView>;
  listDraws(packId: string, o?: { cursor?: string; limit?: number }): Promise<PackDrawsResponse>;
  sweep(now?: Date): Promise<{ expired: number; finalized: number; delivered: number }>;
  /** Pay-first: moves up to `limit` unfinished purchases whose retry time has come (lazy kick from reads; never throws). */
  advanceDue(limit?: number): Promise<{ expired: number; delivered: number }>;
  /** House only: commits and publishes a pack the platform's own wallet owns, inside one transaction guarded by `guard`. */
  createHouse(actor: PackActor, req: PackCreateRequest, guard: (tx: Tx) => Promise<boolean>): Promise<PackView | null>;
  /** A14: the sales this operator still has to deliver (the drawn card is shown to the operator only). */
  listDeliveries(operatorProfileId: string): Promise<PackDeliveryItem[]>;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const iso = (d: Date) => d.toISOString();
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const secondsToMidnightUtc = (d: Date) => Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - d.getTime()) / 1000));

export function createPackService(deps: PackDeps): PackService {
  const { db, sa } = deps;
  const now = () => (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const roundS = deps.roundS ?? ROUND_S;
  const guard = deps.assertCluster ?? (() => undefined);
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const houseWallet = () => deps.houseOperator?.publicKey.toBase58() ?? null;
  /** Wallets that belong to the platform: none of them may be the operator of a third-party pack (a customer's payment must never reach one). */
  const platformWallets = () => [sa.publicKey.toBase58(), deps.feeWallet, houseWallet()].filter((w): w is string => !!w);
  const windowS = (p: Pick<PackRow, 'isHouse'>) => (p.isHouse ? HOUSE_WINDOW_S : OPERATOR_WINDOW_S);

  // ---- loading --------------------------------------------------------------------------------------------------------------

  async function loadPack(x: Db | Tx, id: string, lock = false): Promise<PackRow> {
    const q = x.select().from(packDefinitions).where(eq(packDefinitions.id, id));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new ApiError('not_found', 'no such pack');
    return row;
  }
  const loadCards = (x: Db | Tx, packId: string) => x.select().from(packPoolCards).where(eq(packPoolCards.packId, packId)).orderBy(asc(packPoolCards.position));
  async function loadDraw(x: Db | Tx, id: string, lock = false): Promise<DrawRow> {
    const q = x.select().from(packDraws).where(eq(packDraws.id, id));
    const [row] = await (lock ? q.for('update') : q);
    if (!row) throw new ApiError('not_found', 'no such draw');
    return row;
  }
  async function vrfOf(x: Db | Tx, d: Pick<DrawRow, 'vrfRequestId'>): Promise<VrfRow | null> {
    if (!d.vrfRequestId) return null;
    return (await x.select().from(vrfRequests).where(eq(vrfRequests.id, d.vrfRequestId)))[0] ?? null;
  }
  const poolRow = async (x: Db | Tx, packId: string): Promise<VrfRow | null> =>
    (await x.select().from(vrfRequests).where(and(eq(vrfRequests.purpose, POOL_VRF_PURPOSE), eq(vrfRequests.subjectType, 'pack_draw'), eq(vrfRequests.subjectId, `pack:${packId}`))))[0] ?? null;

  const definitionOf = (p: PackRow, cards: CardRow[]): PackDefinition => ({
    mode: p.mode as PackDefinition['mode'], cluster: p.cluster as Cluster, price: p.price.toString(), operator: p.operatorWallet,
    odds: oddsOf(p).map((o) => ({ tier: o.tier, bps: o.bps })),
    cards: sortedCards(cards).map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue === null ? null : c.listedValue.toString() })),
  });

  async function drawViewOf(d: DrawRow): Promise<PackDrawView> {
    const [pack, vrf, card] = await Promise.all([
      loadPack(db, d.packId),
      vrfOf(db, d),
      d.cardId ? db.select().from(packPoolCards).where(eq(packPoolCards.id, d.cardId)).then((r) => r[0] ?? null) : Promise.resolve(null),
    ]);
    return drawView(d, pack, vrf, card, { expiresAt: d.flow === 'pay_first' ? new Date(d.createdAt.getTime() + PAY_WINDOW_S * 1000) : null });
  }

  const audit = (x: Db | Tx, action: string, target: string, detail: Record<string, unknown>) => x.insert(auditLogs).values({ actorWallet: null, action, target, detail });

  // pay_first needs takeDaily (below) and the loaders above; it is created on first use so the order of these declarations does not matter
  let pf: ReturnType<typeof createPayFirst> | undefined;
  const pfOf = () => (pf ??= createPayFirst({
    db, deps, now, sleep, roundS, poolPurpose: POOL_VRF_PURPOSE, houseKey: () => deps.houseOperator, guard, loadPack, loadCards, loadDraw, definitionOf, drawViewOf, audit, takeDaily, platformWallets,
  }));
  const payFirst: ReturnType<typeof createPayFirst> = {
    open: (...a) => pfOf().open(...a), prepare: (...a) => pfOf().prepare(...a), sign: (...a) => pfOf().sign(...a), advance: (...a) => pfOf().advance(...a),
    advanceOpen: (...a) => pfOf().advanceOpen(...a), assertHouseOperates: (...a) => pfOf().assertHouseOperates(...a), payExpected: (...a) => pfOf().payExpected(...a),
    assertOperatorMaySell: (...a) => pfOf().assertOperatorMaySell(...a), operatorBlocked: (...a) => pfOf().operatorBlocked(...a), operatorRecords: (...a) => pfOf().operatorRecords(...a),
    settleOverdue: (...a) => pfOf().settleOverdue(...a), listDeliveries: (...a) => pfOf().listDeliveries(...a),
  };

  /** The public view of one pack with its operator's delivery record (A14). */
  async function viewOf(p: PackRow, cards: CardRow[]): Promise<PackView> {
    const rec = p.isHouse ? null : (await payFirst.operatorRecords([p.operatorProfileId], p.cluster)).get(p.operatorProfileId) ?? null;
    return packView(p, cards, deps.vrfKey()?.publicKey ?? null, rec);
  }

  // ---- chain readiness of cards ---------------------------------------------------------------------------------------------

  /** Every card must still be a Core asset the operator owns and a plain transfer can move. Reads in small parallel batches. */
  async function assertCardsReady(cluster: Cluster, operator: string, assets: string[]): Promise<void> {
    const chain = deps.chainFor(cluster);
    for (let i = 0; i < assets.length; i += 8) {
      const batch = assets.slice(i, i + 8);
      const done = await Promise.all(batch.map(async (a) => ({ a, r: evaluateAssetReadiness(await chain.readAsset(a), { seller: operator }) })));
      const bad = done.find((x) => !x.r.eligible);
      if (bad) throw new ApiError('asset_not_ready', `card ${bad.a} cannot be sold in a pack (${bad.r.reasons.join(', ')})`);
    }
  }

  // ---- create / publish / control -------------------------------------------------------------------------------------------

  const draftRows = (actor: PackActor, req: PackCreateRequest, cluster: Cluster, isHouse: boolean) => ({
    pack: {
      operatorProfileId: actor.id, operatorWallet: actor.wallet, isHouse, name: req.name, description: req.description ?? null, imageUrl: req.imageUrl ?? null, mode: req.mode, cluster,
      price: BigInt(req.price), odds: req.odds, perWalletDailyCap: req.perWalletDailyCap ?? 5,
    },
    cards: req.cards.map((c, position) => ({ asset: c.asset, tier: c.tier, name: c.name, imageUrl: c.imageUrl ?? null, listedValue: c.listedValue === undefined ? null : BigInt(c.listedValue), attributes: c.attributes ?? null, position })),
  });

  function assertPlayable(req: PackCreateRequest) {
    // Every tier that carries odds needs at least one card, or a published weight would point at nothing.
    for (const o of req.odds) if (!req.cards.some((c) => c.tier === o.tier)) throw new ApiError('validation', `tier ${o.tier} has odds but no card in the pool`);
  }

  /**
   * Who may operate what (A14). A THIRD PARTY may run chance packs (the buyer pays them directly and they deliver) and equal-value packs, but never with a platform wallet
   * as the operator. The HOUSE may run a pack only where `houseDemoAllowed` says so (the devnet demo with test cards): on any other network the platform must not receive a
   * customer's money for a pack.
   */
  function assertMayOperate(actor: PackActor, isHouse: boolean, cluster: Cluster) {
    if (isHouse) {
      if (!houseDemoAllowed(cluster)) throw new ApiError('forbidden', 'Hammerprice does not run packs that take your payment on this network. Chance packs here are run by independent pack operators, who are paid directly.');
      if (houseWallet() !== actor.wallet) throw new ApiError('forbidden', 'only the house wallet can operate a house pack');
    } else if (platformWallets().includes(actor.wallet)) {
      throw new ApiError('forbidden', 'a platform wallet cannot operate a pack of a third party');
    }
  }

  async function create(actor: PackActor, req0: PackCreateRequest, o: { isHouse?: boolean } = {}): Promise<PackView> {
    const req = PackCreateRequest.parse(req0);
    const cluster = deps.defaultCluster;
    assertMayOperate(actor, !!o.isHouse, cluster);
    assertPlayable(req);
    guard(cluster);
    await assertCardsReady(cluster, actor.wallet, req.cards.map((c) => c.asset));
    const rows = draftRows(actor, req, cluster, !!o.isHouse);
    const pack = await db.transaction(async (tx) => {
      await assertNotListed(tx, req.cards.map((c) => c.asset)); // not in a room, not in another pack
      const [p] = await tx.insert(packDefinitions).values(rows.pack).returning();
      await tx.insert(packPoolCards).values(rows.cards.map((c) => ({ ...c, packId: p!.id })));
      return p!;
    });
    return viewOf(pack, await loadCards(db, pack.id));
  }

  /** Commits the pool: hashes, beacon, status live. One transaction; the chain reads and the beacon come first. */
  async function commit(x: Tx, p: PackRow, cards: CardRow[], beacon: Beacon, key: VrfSigner): Promise<PackRow> {
    const def = definitionOf(p, cards);
    const poolHash = poolHashOf(def), oddsHash = oddsHashOf(def.odds), at = now();
    await x.insert(vrfRequests).values({
      purpose: POOL_VRF_PURPOSE, subjectType: 'pack_draw', subjectId: `pack:${p.id}`, cluster: p.cluster, publicKey: key.publicKey,
      params: { oddsHash, pack: p.id, poolHash, v: 1 }, paramsHash: poolHash, status: 'revealed', revealBy: at, beaconSlot: beacon.slot, beaconBlockhash: beacon.blockhash, revealedAt: at,
    });
    const [u] = await x.update(packDefinitions).set({ poolHash, oddsHash, committedAt: at, status: 'live', updatedAt: at }).where(and(eq(packDefinitions.id, p.id), eq(packDefinitions.status, 'draft'))).returning();
    if (!u) throw new ApiError('wrong_state', 'the pack is not a draft');
    await audit(x, 'pack.committed', p.id, { poolHash, oddsHash, cards: cards.length, beacon });
    return u;
  }

  async function publish(p: PackRow): Promise<PackView> {
    if (p.status !== 'draft') throw new ApiError('wrong_state', `the pack is ${p.status}`);
    assertMayOperate({ id: p.operatorProfileId, wallet: p.operatorWallet }, p.isHouse, p.cluster as Cluster);
    const key = deps.vrfKey();
    if (!key) throw new ApiError('paused', 'Packs are paused: the randomness key is not set up on this server.');
    guard(p.cluster as Cluster);
    const cards = await loadCards(db, p.id);
    if (cards.length === 0) throw new ApiError('validation', 'the pool is empty');
    await assertCardsReady(p.cluster as Cluster, p.operatorWallet, cards.map((c) => c.asset));
    const beacon = await deps.beacon(p.cluster as Cluster);
    const live = await db.transaction(async (tx) => {
      const locked = await loadPack(tx, p.id, true);
      if (locked.status !== 'draft') throw new ApiError('wrong_state', `the pack is ${locked.status}`);
      return commit(tx, locked, await loadCards(tx, p.id), beacon, key);
    });
    return viewOf(live, await loadCards(db, p.id));
  }

  async function control(packId: string, actorProfileId: string, action: PackControlRequest['action']): Promise<PackView> {
    const p = await loadPack(db, packId);
    if (p.operatorProfileId !== actorProfileId) throw new ApiError('not_seller', 'this pack is not yours');
    if (action === 'publish') return publish(p);
    const next: Record<string, { from: string[]; to: string }> = {
      pause: { from: ['live'], to: 'paused' },
      resume: { from: ['paused'], to: 'live' },
      close: { from: ['draft', 'live', 'paused', 'sold_out'], to: 'closed' },
    };
    const rule = next[action]!;
    if (!rule.from.includes(p.status)) throw new ApiError('wrong_state', `the pack is ${p.status}`);
    if (action === 'resume') {
      const left = (await loadCards(db, p.id)).filter((c) => c.status === 'available' || c.status === 'reserved').length;
      if (left === 0) throw new ApiError('wrong_state', 'the pool is empty');
      // A14: a pack paused because the operator did not deliver (or moved a card) only resumes once the sales that can still be delivered are delivered
      if (!p.isHouse) await payFirst.assertOperatorMaySell(p).catch((e) => { throw e instanceof ApiError && e.code === 'paused' ? new ApiError('wrong_state', e.message) : e; });
    }
    const [u] = await db.update(packDefinitions).set({ status: rule.to, updatedAt: now() }).where(and(eq(packDefinitions.id, packId), inArray(packDefinitions.status, rule.from))).returning();
    if (!u) throw new ApiError('wrong_state', 'the pack changed, reload');
    await audit(db, `pack.${action}`, packId, {});
    return viewOf(u, await loadCards(db, packId));
  }

  async function createHouse(actor: PackActor, req0: PackCreateRequest, guardTx: (tx: Tx) => Promise<boolean>): Promise<PackView | null> {
    const req = PackCreateRequest.parse(req0);
    const cluster = deps.defaultCluster;
    assertMayOperate(actor, true, cluster);
    assertPlayable(req);
    const key = deps.vrfKey();
    if (!key) return null;
    guard(cluster);
    await assertCardsReady(cluster, actor.wallet, req.cards.map((c) => c.asset));
    const beacon = await deps.beacon(cluster);
    const rows = draftRows(actor, req, cluster, true);
    const live = await db.transaction(async (tx) => {
      if (!(await guardTx(tx))) return null;
      await assertNotListed(tx, req.cards.map((c) => c.asset));
      const [p] = await tx.insert(packDefinitions).values(rows.pack).returning();
      const cards = await tx.insert(packPoolCards).values(rows.cards.map((c) => ({ ...c, packId: p!.id }))).returning();
      return { pack: await commit(tx, p!, cards, beacon, key) };
    });
    return live ? viewOf(live.pack, await loadCards(db, live.pack.id)) : null;
  }

  // ---- reads ----------------------------------------------------------------------------------------------------------------

  async function list(o: { operatorProfileId?: string } = {}): Promise<PackView[]> {
    const packs = o.operatorProfileId
      ? await db.select().from(packDefinitions).where(and(eq(packDefinitions.operatorProfileId, o.operatorProfileId), eq(packDefinitions.cluster, deps.defaultCluster))).orderBy(desc(packDefinitions.createdAt)).limit(100)
      : await db.select().from(packDefinitions).where(and(inArray(packDefinitions.status, ['live', 'paused', 'sold_out']), eq(packDefinitions.cluster, deps.defaultCluster))).orderBy(desc(packDefinitions.isHouse), desc(packDefinitions.createdAt)).limit(50);
    if (packs.length === 0) return [];
    const cards = await db.select().from(packPoolCards).where(inArray(packPoolCards.packId, packs.map((p) => p.id)));
    const key = deps.vrfKey()?.publicKey ?? null;
    const records = await payFirst.operatorRecords([...new Set(packs.filter((p) => !p.isHouse).map((p) => p.operatorProfileId))], deps.defaultCluster);
    return packs.map((p) => packView(p, cards, key, records.get(p.operatorProfileId) ?? null));
  }

  async function detail(packId: string, viewerProfileId: string | null = null): Promise<PackDetailResponse> {
    const p = await loadPack(db, packId);
    const isOperator = !!viewerProfileId && p.operatorProfileId === viewerProfileId;
    if (p.status === 'draft' && !isOperator) throw new ApiError('not_found', 'no such pack');
    if (!p.isHouse && p.mode === 'chance') await payFirst.settleOverdue(p.operatorProfileId, 10).catch(() => undefined); // an overdue delivery is marked (and the pack paused) before a buyer reads the page
    const fresh = await loadPack(db, packId);
    const cards = await loadCards(db, packId);
    return { pack: await viewOf(fresh, cards), cards: poolCardViews(cards) };
  }

  async function getDraw(drawId: string): Promise<PackDrawView> {
    let d = await loadDraw(db, drawId);
    if (d.flow === 'pay_first') d = await payFirst.advance(drawId); // a read carries a purchase forward (payment final, draw, delivery); it never fails because the chain is slow
    else if (d.status === 'submitted') {
      try { d = await finalize(drawId); } catch (e) { if (!(e instanceof ApiError && e.code === 'rpc_unavailable')) throw e; } // a read never fails because the chain is slow
    } else if (d.status === 'reserved' && dueAt(d, await loadPack(db, d.packId)) <= now()) {
      await expireOne(drawId);
      d = await loadDraw(db, drawId);
    }
    return drawViewOf(d);
  }

  async function listDraws(packId: string, o: { cursor?: string; limit?: number } = {}): Promise<PackDrawsResponse> {
    const p = await loadPack(db, packId);
    if (p.status === 'draft') throw new ApiError('not_found', 'no such pack');
    const limit = Math.min(100, Math.max(1, o.limit ?? 30));
    const before = o.cursor !== undefined && /^\d{1,9}$/.test(o.cursor) ? Number(o.cursor) : null;
    // A pay_first purchase that is not drawn yet has no index and is not in the public log (it is not a draw until its payment is final).
    const rows = await db.select().from(packDraws).where(before === null ? and(eq(packDraws.packId, packId), isNotNull(packDraws.drawIndex)) : and(eq(packDraws.packId, packId), lt(packDraws.drawIndex, before))).orderBy(desc(packDraws.drawIndex)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const cards = await loadCards(db, packId);
    const vrfs = page.length ? await db.select().from(vrfRequests).where(inArray(vrfRequests.id, page.map((d) => d.vrfRequestId).filter((x): x is string => !!x))) : [];
    const draws = page.map((d) => drawView(d, p, vrfs.find((v) => v.id === d.vrfRequestId) ?? null, cards.find((c) => c.id === d.cardId) ?? null));
    return { draws, nextCursor: rows.length > limit ? String(page[page.length - 1]!.drawIndex) : null };
  }

  // ---- open: the draw -------------------------------------------------------------------------------------------------------

  const dueAt = (d: Pick<DrawRow, 'createdAt'>, p: Pick<PackRow, 'isHouse'>) => new Date(d.createdAt.getTime() + windowS(p) * 1000);

  /** One count per wallet, pack and UTC day, taken before the draw and given back if the draw never happened. */
  async function takeDaily(wallet: string, p: PackRow): Promise<() => Promise<void>> {
    const day = dayOf(now());
    const [row] = await db.insert(packPurchaseCounts).values({ wallet, packId: p.id, day, count: 1 })
      .onConflictDoUpdate({ target: [packPurchaseCounts.wallet, packPurchaseCounts.packId, packPurchaseCounts.day], set: { count: sql`${packPurchaseCounts.count} + 1` }, setWhere: sql`${packPurchaseCounts.count} < ${p.perWalletDailyCap}` })
      .returning({ count: packPurchaseCounts.count });
    if (!row) throw new ApiError('rate_limited', `At most ${p.perWalletDailyCap} packs per day from this pack`, { retryAfterS: secondsToMidnightUtc(now()) });
    return async () => { await db.update(packPurchaseCounts).set({ count: sql`greatest(${packPurchaseCounts.count} - 1, 0)` }).where(and(eq(packPurchaseCounts.wallet, wallet), eq(packPurchaseCounts.packId, p.id), eq(packPurchaseCounts.day, day))); };
  }

  async function open(buyer: PackActor, packId: string, input: PackOpenRequest): Promise<PackOpenResponse> {
    const p0 = await loadPack(db, packId);
    guard(p0.cluster as Cluster);
    const key = deps.vrfKey();
    if (!key) throw new ApiError('paused', 'Packs are paused: the randomness key is not set up on this server.');
    if (p0.cluster !== deps.defaultCluster) throw new ApiError('wrong_state', 'this pack belongs to another network');
    if (p0.status !== 'live') throw new ApiError('wrong_state', p0.status === 'paused' ? 'this pack is paused' : p0.status === 'sold_out' ? 'this pack is sold out' : 'this pack is not for sale');
    if (p0.operatorProfileId === buyer.id) throw new ApiError('forbidden', 'you cannot buy your own pack');
    if (p0.mode === 'chance') {
      // PAY FIRST: nothing is drawn, reserved or revealed until the payment is final. The buyer pays the operator directly (payfirst.ts).
      return payFirst.open(buyer, p0, input);
    }
    if (p0.isHouse && !houseDemoAllowed(p0.cluster)) throw new ApiError('wrong_state', 'this pack is no longer sold: Hammerprice does not run a pack that takes your payment on this network. Nothing was charged.');
    const beaconRow = await poolRow(db, packId);
    if (!beaconRow?.beaconSlot || !beaconRow.beaconBlockhash) throw new ApiError('vrf_pending', 'the pack has no randomness anchor yet');

    // Idempotent: the same seed is the same request; a buyer with a draw still waiting gets that one back.
    const mine = await db.select().from(packDraws).where(and(eq(packDraws.packId, packId), eq(packDraws.buyerProfileId, buyer.id))).orderBy(desc(packDraws.createdAt)).limit(20);
    const same = mine.find((d) => d.clientSeed === input.clientSeed);
    if (same && (same.status === 'reserved' || same.status === 'submitted')) return { draw: await drawViewOf(same), payment: await prepareDraw(same.id, buyer.id) };
    if (same) throw new ApiError('wrong_state', 'this seed was already used, start again');
    const waiting = mine.find((d) => d.status === 'reserved' && dueAt(d, p0) > now());
    if (waiting) return { draw: await drawViewOf(waiting), payment: await prepareDraw(waiting.id, buyer.id) };

    const chain = deps.chainFor(p0.cluster as Cluster);
    if ((await chain.getUsdcBalance(buyer.wallet)) < p0.price) throw new ApiError('insufficient_usdc', 'you do not hold enough USDC for this pack');
    const giveBack = await takeDaily(buyer.wallet, p0);

    let drawn: { draw: DrawRow; card: CardRow } | null = null;
    try {
      drawn = await db.transaction(async (tx) => {
        const p = await loadPack(tx, packId, true);
        if (p.status !== 'live') throw new ApiError('wrong_state', 'this pack is not for sale');
        const cards = await loadCards(tx, packId);
        const taken = cards.filter((c) => c.status !== 'available').map((c) => c.position);
        const def = definitionOf(p, cards);
        const [last] = await tx.select({ n: sql<number>`coalesce(max(${packDraws.drawIndex}), -1)::int` }).from(packDraws).where(eq(packDraws.packId, packId));
        const index = (last?.n ?? -1) + 1;
        const drawId = newId(), requestId = packDrawSubject(packId, index); // not random: a server-chosen id could be ground until the output suits
        const made = makeDraw({
          cluster: p.cluster as Cluster, packId, poolHash: p.poolHash!, def, buyer: buyer.wallet, seed: input.clientSeed, index, taken,
          beacon: { slot: beaconRow.beaconSlot!, blockhash: beaconRow.beaconBlockhash! }, prove: (a) => key.prove(a),
        });
        if (!made.selection) {
          await tx.update(packDefinitions).set({ status: 'sold_out', updatedAt: now() }).where(eq(packDefinitions.id, packId));
          return null;
        }
        const card = sortedCards(cards)[made.selection.position]!;
        const at = now();
        await tx.insert(vrfRequests).values({
          id: requestId, purpose: POOL_VRF_PURPOSE, subjectType: 'pack_draw', subjectId: drawId, cluster: p.cluster, publicKey: key.publicKey, params: made.params, paramsHash: made.paramsHash,
          status: 'revealed', revealBy: at, alphaText: made.alphaText, proofHex: made.proof.proofHex, outputHex: made.proof.outputHex, beaconSlot: beaconRow.beaconSlot, beaconBlockhash: beaconRow.beaconBlockhash,
          result: { tier: made.selection.tier, position: made.selection.position, asset: card.asset }, revealedAt: at,
        });
        const [draw] = await tx.insert(packDraws).values({
          id: drawId, packId, buyerProfileId: buyer.id, buyerWallet: buyer.wallet, cluster: p.cluster, drawIndex: index, ageConfirmedAt: at, clientSeed: input.clientSeed, vrfRequestId: requestId,
          vrfInput: made.alphaText, proofHex: made.proof.proofHex, outputHex: made.proof.outputHex, tier: made.selection.tier, cardId: card.id, asset: card.asset, price: p.price, status: 'reserved',
          settlementRef: packMemo(drawId, p.poolHash!), createdAt: at,
        }).returning();
        await tx.update(packPoolCards).set({ status: 'reserved' }).where(eq(packPoolCards.id, card.id));
        return { draw: draw!, card };
      });
    } catch (e) {
      await giveBack().catch(() => undefined); // the draw did not happen: the day's count is not spent
      throw e;
    }
    if (!drawn) { await giveBack().catch(() => undefined); throw new ApiError('wrong_state', 'this pack is sold out'); }

    // After the lock: is the drawn card really still the operator's? If not, the draw ends, the card leaves the pool, nobody paid anything.
    try {
      await assertCardsReady(p0.cluster as Cluster, p0.operatorWallet, [drawn.card.asset]);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'asset_not_ready') {
        await failDraw(drawn.draw.id, 'asset_not_ready', e.message, 'removed');
        await db.update(packDefinitions).set({ status: 'paused', updatedAt: now() }).where(and(eq(packDefinitions.id, packId), eq(packDefinitions.status, 'live')));
        await audit(db, 'pack.paused', packId, { reason: 'asset_not_ready', asset: drawn.card.asset });
        await giveBack().catch(() => undefined); // not the buyer's doing: the day's count is not spent
        throw new ApiError('asset_not_ready', 'The drawn card is no longer available. The pack was paused. Nothing was charged.');
      }
      throw e;
    }
    return { draw: await drawViewOf(drawn.draw), payment: await prepareDraw(drawn.draw.id, buyer.id) };
  }

  // ---- ending a draw --------------------------------------------------------------------------------------------------------

  const dropSignatures = { buyerSignature: null, operatorSignature: null } as const;

  /** Ends the draw as failed or expired and gives the card back (`removed` when the operator no longer holds it). */
  async function endDraw(x: Tx, d: DrawRow, status: 'failed' | 'expired', code: string, detail: string, cardStatus: 'available' | 'removed' = 'available') {
    await x.update(packDraws).set({ status, failureCode: code, ...dropSignatures, roundExpiresAt: null, preparedMessage: null }).where(eq(packDraws.id, d.id));
    if (d.cardId) await x.update(packPoolCards).set({ status: cardStatus }).where(and(eq(packPoolCards.id, d.cardId), eq(packPoolCards.status, 'reserved')));
    // A pack that was sold out only because of this reservation sells again.
    if (cardStatus === 'available') await x.update(packDefinitions).set({ status: 'live', updatedAt: now() }).where(and(eq(packDefinitions.id, d.packId), eq(packDefinitions.status, 'sold_out')));
    await audit(x, `pack.draw.${status}`, d.id, { code, detail: detail.slice(0, 300) });
  }
  async function failDraw(id: string, code: string, detail: string, cardStatus: 'available' | 'removed' = 'available') {
    await db.transaction(async (tx) => {
      const d = await loadDraw(tx, id, true);
      if (d.status === 'reserved' || d.status === 'submitted') await endDraw(tx, d, 'failed', code, detail, cardStatus);
    });
  }

  /** Who did not act? The party whose signature was missing in the last round that had one; nobody signed means the buyer. */
  const absent = (d: DrawRow): 'buyer_absent' | 'operator_absent' =>
    d.buyerSignature && !d.operatorSignature ? 'operator_absent' : d.operatorSignature && !d.buyerSignature ? 'buyer_absent' : d.failureCode === 'operator_absent' ? 'operator_absent' : 'buyer_absent';
  /** What a round that ended with one signature leaves behind before the signatures go: who was missing. Kept in failure_code until the draw ends. */
  const carry = (d: Pick<DrawRow, 'buyerSignature' | 'operatorSignature' | 'failureCode'>): string | null =>
    d.buyerSignature && !d.operatorSignature ? 'operator_absent' : d.operatorSignature && !d.buyerSignature ? 'buyer_absent' : d.failureCode;

  async function expireOne(id: string, at = now()): Promise<boolean> {
    return db.transaction(async (tx) => {
      const d = await loadDraw(tx, id, true);
      if (d.status !== 'reserved') return false;
      const p = await loadPack(tx, d.packId);
      if (dueAt(d, p) > at) return false;
      const who = absent(d);
      await endDraw(tx, d, 'expired', who, `${who === 'operator_absent' ? 'the operator' : 'the buyer'} did not complete the purchase`);
      if (who === 'operator_absent' && !p.isHouse) { // an operator who leaves buyers waiting stops selling until they resume
        await tx.update(packDefinitions).set({ status: 'paused', updatedAt: now() }).where(and(eq(packDefinitions.id, p.id), eq(packDefinitions.status, 'live')));
        await audit(tx, 'pack.paused', p.id, { reason: 'operator_absent', tolerated: MAX_STRIKE_FREE_ABSENCES });
      }
      return true;
    });
  }

  // ---- prepare --------------------------------------------------------------------------------------------------------------

  const isLive = (d: DrawRow, at: Date) => d.status === 'reserved' && !!d.preparedMessage && !!d.roundExpiresAt && d.roundExpiresAt > at;

  async function expectedFor(d: DrawRow, p: PackRow): Promise<PackExpectedPayment> {
    const [card] = d.cardId ? await db.select().from(packPoolCards).where(eq(packPoolCards.id, d.cardId)) : [];
    if (!card) throw new ApiError('wrong_state', 'the draw has no card');
    const split = splitGross(d.price, deps.feeBps);
    return PackExpectedPayment.parse({
      drawId: d.id, cluster: d.cluster, buyer: d.buyerWallet, operator: p.operatorWallet, asset: card.asset, collection: null,
      usdcMint: deps.usdcMint(d.cluster as Cluster), gross: d.price.toString(), platformFee: split.platform.toString(), royalty: '0', royaltyRecipient: null,
      feeWallet: deps.feeWallet, feePayer: sa.publicKey.toBase58(), memo: d.settlementRef ?? packMemo(d.id, p.poolHash ?? ''),
    });
  }

  async function paymentOf(d: DrawRow, p: PackRow): Promise<PackPayment> {
    return { txBase64: d.preparedMessage!, expected: await roundExpected(d, p), lastValidBlockHeight: d.lastValidHeight ?? 0, roundExpiresAt: iso(d.roundExpiresAt!), buyerSigned: !!d.buyerSignature, operatorSigned: !!d.operatorSignature };
  }

  async function prepareDraw(id: string, actorProfileId: string | null): Promise<PackPayment> {
    let d = await loadDraw(db, id);
    if (d.flow === 'pay_first') return payFirst.prepare(id, actorProfileId);
    const p = await loadPack(db, d.packId);
    if (actorProfileId !== null && actorProfileId !== d.buyerProfileId && actorProfileId !== p.operatorProfileId) throw new ApiError('not_party', 'you are not the buyer or the operator of this draw');
    if (d.status === 'submitted') d = await finalize(id);
    if (d.status !== 'reserved') throw new ApiError('wrong_state', `the purchase is ${d.status}`);
    if (dueAt(d, p) <= now()) { await expireOne(id); throw new ApiError('wrong_state', 'the time for this purchase has run out'); }
    guard(d.cluster as Cluster);
    if (isLive(d, now())) return paymentOf(d, p);

    const chain = deps.chainFor(d.cluster as Cluster);
    if ((await chain.getUsdcBalance(d.buyerWallet)) < d.price) throw new ApiError('insufficient_usdc', 'the buyer does not hold enough USDC');
    const cardAsset = d.asset!;
    const info = await chain.readAsset(cardAsset);
    const readiness = evaluateAssetReadiness(info, { seller: p.operatorWallet });
    if (!readiness.eligible) {
      await failDraw(id, 'asset_not_ready', readiness.reasons.join(','), 'removed');
      await db.update(packDefinitions).set({ status: 'paused', updatedAt: now() }).where(and(eq(packDefinitions.id, p.id), eq(packDefinitions.status, 'live')));
      throw new ApiError('asset_not_ready', `the card can no longer be transferred (${readiness.reasons.join(', ')})`);
    }
    const [bh, height] = await Promise.all([chain.getLatestBlockhash(), chain.getBlockHeight()]);
    const validS = Math.floor((bh.lastValidBlockHeight - height) * 0.4);
    if (validS < 10) throw new ApiError('rpc_unavailable', 'the latest blockhash is too old, try again');
    const lengthS = Math.min(roundS, validS);

    const expected = PackExpectedPayment.parse({ ...(await expectedFor(d, p)), collection: info?.collection ?? null });
    const txBytes = buildUnsignedPackTx(expected, bh.blockhash);
    const txBase64 = b64(txBytes);
    let houseSig: string | null = null;
    if (deps.houseOperator && p.operatorWallet === houseWallet()) houseSig = b64(extractPackSignature(signPackAs(txBytes, deps.houseOperator), txBytes, expected, 'seller'));

    return db.transaction(async (tx) => {
      const cur = await loadDraw(tx, id, true);
      if (cur.status !== 'reserved') throw new ApiError('wrong_state', `the purchase is ${cur.status}`);
      if (isLive(cur, now())) return paymentOf(cur, p);
      const at = now();
      const [u] = await tx.update(packDraws).set({
        attempt: cur.preparedMessage ? cur.attempt + 1 : cur.attempt, preparedMessage: txBase64, preparedBlockhash: bh.blockhash, lastValidHeight: bh.lastValidBlockHeight,
        roundExpiresAt: new Date(at.getTime() + lengthS * 1000), buyerSignature: null, operatorSignature: houseSig, failureCode: carry(cur),
      }).where(eq(packDraws.id, id)).returning();
      return { txBase64, expected, lastValidBlockHeight: bh.lastValidBlockHeight, roundExpiresAt: iso(u!.roundExpiresAt!), buyerSigned: false, operatorSigned: !!houseSig };
    });
  }

  // ---- sign -----------------------------------------------------------------------------------------------------------------

  /** The expected payment of a stored round, rebuilt from the same inputs plus the collection read at prepare (it is in the prepared message). */
  async function roundExpected(d: DrawRow, p: PackRow): Promise<PackExpectedPayment> {
    const base = await expectedFor(d, p);
    const { Transaction } = await import('@solana/web3.js');
    const t = Transaction.from(unb64(d.preparedMessage!));
    const core = t.instructions.find((ix) => ix.programId.toBase58() === 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
    const col = core?.keys[1]?.pubkey.toBase58() ?? null;
    return PackExpectedPayment.parse({ ...base, collection: col === 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d' ? null : col });
  }

  async function signDraw(id: string, actorProfileId: string, input: SignInput): Promise<PackSignResponse> {
    let d = await loadDraw(db, id);
    if (d.flow === 'pay_first') return payFirst.sign(id, actorProfileId, input);
    const p = await loadPack(db, d.packId);
    const role: PartyRole = input.role;
    if (actorProfileId !== (role === 'buyer' ? d.buyerProfileId : p.operatorProfileId)) throw new ApiError('not_party', `you are not the ${role === 'buyer' ? 'buyer' : 'operator'} of this purchase`);
    if (d.status === 'submitted' || d.status === 'settled') return { step: d.status, draw: await drawViewOf(d) };
    if (d.status !== 'reserved') throw new ApiError('wrong_state', `the purchase is ${d.status}`);
    guard(d.cluster as Cluster);
    if (!isLive(d, now())) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');

    const prepared = unb64(d.preparedMessage!);
    const sig = extractPackSignature(unb64(input.signedTxBase64), prepared, await roundExpected(d, p), role);
    const stored = await db.transaction(async (tx) => {
      const cur = await loadDraw(tx, id, true);
      if (cur.status !== 'reserved') return cur;
      if (!isLive(cur, now()) || cur.preparedMessage !== d.preparedMessage) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');
      const [u] = await tx.update(packDraws).set(role === 'buyer' ? { buyerSignature: b64(sig) } : { operatorSignature: b64(sig) }).where(eq(packDraws.id, id)).returning();
      return u!;
    });
    d = stored;
    if (!(d.buyerSignature && d.operatorSignature)) return { step: 'awaiting_counterparty', draw: await drawViewOf(d) };
    return sendRound(id, p);
  }

  async function sendRound(id: string, p: PackRow): Promise<PackSignResponse> {
    const d = await loadDraw(db, id);
    guard(d.cluster as Cluster);
    const chain = deps.chainFor(d.cluster as Cluster);
    if (d.status !== 'reserved') return { step: d.status === 'settled' ? 'settled' : 'submitted', draw: await drawViewOf(d) };
    if (!d.buyerSignature || !d.operatorSignature || !d.preparedMessage) throw new ApiError('wrong_state', 'both parties must sign first');
    if (!isLive(d, now()) || (await chain.getBlockHeight()) > (d.lastValidHeight ?? 0)) {
      await db.update(packDraws).set({ ...dropSignatures, roundExpiresAt: now() }).where(and(eq(packDraws.id, id), eq(packDraws.status, 'reserved')));
      throw new ApiError('round_expired', 'the signing round ended before the transaction could be sent');
    }
    const e = await roundExpected(d, p);
    const { wire, signature } = assemblePackTx(unb64(d.preparedMessage), e, { buyer: unb64(d.buyerSignature), operator: unb64(d.operatorSignature) }, sa);
    const wire64 = b64(wire);
    const sim = await chain.simulate(wire64);
    if (sim.err) {
      const winner = await loadDraw(db, id);
      if (winner.status !== 'reserved') return { step: winner.status === 'settled' ? 'settled' : 'submitted', draw: await drawViewOf(winner) };
      const text = `${JSON.stringify(sim.err)} ${sim.logs.join(' ')}`;
      console.warn('pack simulation failed', id, text.slice(0, 600));
      throw new ApiError(/insufficient funds|InsufficientFunds|custom program error: 0x1\b/i.test(text) ? 'insufficient_usdc' : 'simulation_failed', `the network rejected the transaction in simulation: ${JSON.stringify(sim.err).slice(0, 120)}`);
    }
    // Sponsorship is spent only for a transaction that passed simulation: failing attempts cost the budget nothing.
    await deps.spendGuard?.(p.operatorWallet === houseWallet() ? 'house' : 'third-party');
    let claimed: DrawRow | undefined;
    try {
      [claimed] = await db.update(packDraws).set({ status: 'submitted', txSignature: signature, failureCode: null })
        .where(and(eq(packDraws.id, id), eq(packDraws.status, 'reserved'), sql`${packDraws.txSignature} is null`)).returning();
    } catch {
      throw new ApiError('wrong_state', 'this transaction is already recorded');
    }
    if (!claimed) { const now2 = await loadDraw(db, id); return { step: now2.status === 'settled' ? 'settled' : 'submitted', draw: await drawViewOf(now2) }; }
    try {
      const sent = await chain.send(wire64);
      if (sent !== signature) throw new ApiError('simulation_failed', 'the node returned a different signature');
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'blockhash_expired' || err.code === 'simulation_failed')) {
        await db.update(packDraws).set({ status: 'reserved', txSignature: null, ...dropSignatures, roundExpiresAt: now(), failureCode: err.code === 'blockhash_expired' ? 'round_expired' : 'simulation_failed' }).where(and(eq(packDraws.id, id), eq(packDraws.status, 'submitted')));
        throw err.code === 'blockhash_expired' ? new ApiError('round_expired', 'the signing round ended before the transaction could be sent') : err;
      }
      // outcome unknown (RPC down mid-send): it may have landed; stay submitted, finalize decides from the chain
    }
    const deadline = Date.now() + SEND_POLL_TIMEOUT_MS;
    let res = await finalize(id);
    while (res.status === 'submitted' && Date.now() < deadline) { await sleep(deps.pollMs ?? 1000); res = await finalize(id); }
    return { step: res.status === 'settled' ? 'settled' : 'submitted', draw: await drawViewOf(res) };
  }

  // ---- finalize -------------------------------------------------------------------------------------------------------------

  async function finalize(id: string): Promise<DrawRow> {
    const d = await loadDraw(db, id);
    if (d.status === 'reserved' && dueAt(d, await loadPack(db, d.packId)) <= now()) { await expireOne(id); return loadDraw(db, id); }
    if (d.status !== 'submitted' || !d.txSignature) return d;
    const p = await loadPack(db, d.packId);
    const chain = deps.chainFor(d.cluster as Cluster);
    const st = await chain.getSignatureStatus(d.txSignature);
    const reopen = (code: string) => db.update(packDraws).set({ status: 'reserved', txSignature: null, ...dropSignatures, roundExpiresAt: now(), failureCode: code }).where(and(eq(packDraws.id, id), eq(packDraws.status, 'submitted')));
    if (!st) {
      if ((await chain.getBlockHeight()) > (d.lastValidHeight ?? 0)) await reopen('round_expired'); // the transaction never landed and cannot any more: a new round may start
      return loadDraw(db, id);
    }
    if (!st.confirmed) return d;
    if (st.err) { await reopen('tx_failed'); return loadDraw(db, id); }
    const e = await roundExpected(d, p);
    const [parsed, asset] = await Promise.all([chain.getTransaction(d.txSignature), chain.readAsset(e.asset)]);
    if (!parsed) return d;
    const verdict = verifyPackSettled(parsed, e, asset?.owner ?? null);
    if (!verdict.ok) { await failDraw(id, verdict.code, verdict.detail); return loadDraw(db, id); }
    await db.transaction(async (tx) => {
      const cur = await loadDraw(tx, id, true);
      if (cur.status !== 'submitted') return;
      await tx.update(packDraws).set({ status: 'settled', settledAt: now(), failureCode: null, ...dropSignatures, roundExpiresAt: null }).where(eq(packDraws.id, id));
      if (cur.cardId) await tx.update(packPoolCards).set({ status: 'drawn' }).where(eq(packPoolCards.id, cur.cardId));
      const left = (await loadCards(tx, cur.packId)).filter((c) => c.status === 'available' || c.status === 'reserved').length;
      if (left === 0) await tx.update(packDefinitions).set({ status: 'sold_out', updatedAt: now() }).where(and(eq(packDefinitions.id, cur.packId), eq(packDefinitions.status, 'live')));
      await audit(tx, 'pack.draw.settled', id, { txSignature: d.txSignature, explorer: explorerTxUrl(d.txSignature!, d.cluster as Cluster) });
    });
    invalidateBalance(d.buyerWallet);
    invalidateBalance(p.operatorWallet);
    return loadDraw(db, id);
  }

  // ---- the sweep ------------------------------------------------------------------------------------------------------------

  // Known limit: one pass handles at most SWEEP_BATCH rows per kind so a cron call fits a serverless time limit; the next run takes the rest.
  async function sweep(at: Date = now()): Promise<{ expired: number; finalized: number; delivered: number }> {
    const pf = await payFirst.advanceOpen({ limit: SWEEP_BATCH, force: true }); // pay_first: expire the unpaid, finalize, draw, deliver
    const submitted = await db.select({ id: packDraws.id }).from(packDraws).where(eq(packDraws.status, 'submitted')).limit(SWEEP_BATCH);
    let finalized = 0;
    for (const s of submitted) if ((await finalize(s.id).catch(() => null))?.status === 'settled') finalized++;
    const open = await db.select().from(packDraws).where(and(eq(packDraws.status, 'reserved'), eq(packDraws.flow, 'atomic'))).limit(SWEEP_BATCH);
    let expired = 0;
    for (const d of open) if (await expireOne(d.id, at)) expired++;
    // signatures of ended rounds do not outlive the round; who was missing is kept in failure_code
    await db.update(packDraws).set({
      failureCode: sql`case when ${packDraws.buyerSignature} is not null and ${packDraws.operatorSignature} is null then 'operator_absent' when ${packDraws.operatorSignature} is not null and ${packDraws.buyerSignature} is null then 'buyer_absent' else ${packDraws.failureCode} end`,
      ...dropSignatures,
    }).where(and(eq(packDraws.status, 'reserved'), lt(packDraws.roundExpiresAt, at), sql`(${packDraws.buyerSignature} is not null or ${packDraws.operatorSignature} is not null)`));
    return { expired: expired + pf.expired, finalized, delivered: pf.delivered };
  }

  async function advanceDue(limit = 5) {
    try { return await payFirst.advanceOpen({ limit, force: false }); } catch { return { expired: 0, delivered: 0 }; }
  }

  return { create, control, list, detail, open, prepareDraw, signDraw, getDraw, listDraws, sweep, advanceDue, createHouse, listDeliveries: (...a) => payFirst.listDeliveries(...a) };
}
