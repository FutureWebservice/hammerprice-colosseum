/**
 * PAY FIRST, DRAW AFTER, the flow of every CHANCE pack. The customer pays the OPERATOR DIRECTLY before anything is drawn
 * (nothing goes to a platform wallet: the platform only adds its fee leg and pays the network fee), so a buyer cannot abandon and re-roll until the rare
 * card shows, and unpaid attempts reserve nothing that could shape later draws. The operator is a third party who owns the cards; the devnet house demo
 * runs through the SAME flow (operator = the house wallet, its delivery is signed by the server, test USDC).
 *
 *   awaiting_payment  the purchase exists, the payment message is ready. NO card, NO draw, NO vrf row, NO asset anywhere (api, bytes, logs).
 *   confirming        the buyer signed, the platform added its fee-payer signature and sent the payment (buyer -> operator); we wait for it to be FINALIZED.
 *   paid              the payment is finalized and verified (legs and memo). Only now does a card get chosen.
 *   drawn             ECVRF draw done: the input contains the payment signature, its slot and the first block produced after it. The card is reserved.
 *   delivering        the card moves operator -> buyer in a second transaction that the OPERATOR signs in their wallet before `deliver_by` (24 h after the draw
 *                     by default); the settlement authority is only the fee payer. (House demo: the server signs it with the house key.)
 *   settled           the delivery is finalized and the card is the buyer's.            (terminal; "delivered")
 *   undelivered       the operator did not deliver in time, or moved the card away. The platform holds no money, so there is NO refund: the operator gets a
 *                     strike, the pack pauses, and the buyer keeps the payment signature and the proof to claim against the operator. A late delivery still
 *                     works unless the card is gone (`asset_moved`, `asset_not_transferable`, `pool_empty`).
 *   expired / failed  nothing was paid (window passed, or the payment transaction failed). (terminal)
 *
 * Rules:
 *  - Every step is one compare-and-set on `status` (`cas`), so concurrent callers (the buyer's poll, the sweep) cannot both act.
 *  - A delivery transaction is CLAIMED in the row (status and signature) before it is sent, and only the stored bytes are ever re-sent. A new one is built
 *    only after the old one can no longer land. A finalized delivery that does not verify is held for review, never sent again.
 *  - A card that left the operator wallet is NOT replaced by a second draw (that would let an operator re-roll): undelivered, strike, pause.
 *  - The platform never refunds and never sends money: no refund state, no refund transaction, no float (static test).
 *  - Lock order is pack, then draw.
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Keypair } from '@solana/web3.js';
import type { db as DbInstance } from '@/db';
import { packDefinitions, packDraws, packPoolCards, packPurchaseCounts, profiles, vrfRequests } from '@/db/schema';
import { ApiError, PackPayExpected, type Cluster, type PackDeliveryItem, type PackDrawView, type PackOpenRequest, type PackOpenResponse, type PackOperatorRecord, type PackPayment, type PackSignResponse, type SignInput } from '@/contracts';
import { evaluateAssetReadiness } from '@/lib/chain/asset';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { invalidateBalance } from '@/lib/chain/funds';
import type { ChainPort } from '@/lib/chain/port';
import {
  assemblePayTx, assembleServerTx, buildUnsignedPayTx, buildUnsignedServerTx, extractPaySignature, extractServerPartySignature, verifyDelivered, verifyPackPaid,
  type PackDeliveryExpected,
} from '@/lib/chain/pack-pay-tx';
import { splitGross } from '@/lib/auction/fees';
import { packDeliveryMemo, packDrawSubject, packMemo, type PackDefinition } from '@/lib/packs/commit';
import { makeDraw } from '@/lib/packs/draw';
import type { Beacon } from '@/lib/vrf';
import type { PackDeps } from './service';
import { houseDemoAllowed } from './house';
import { sortedCards, type CardRow, type DrawRow, type PackRow } from './views';

type Db = typeof DbInstance;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A buyer has this long to sign the payment of an opened purchase (the house packs' window, as before). */
export const PAY_WINDOW_S = 300;
/** THIRD-PARTY packs (A14): the operator must deliver within this long after the draw (config: PACK_DELIVERY_DEADLINE_S, read in instance.ts). */
export const DEFAULT_DELIVERY_DEADLINE_S = 86_400;
/** The operator is reminded (Telegram, if linked) when this little time is left. */
const REMIND_BEFORE_S = 6 * 3600;
/** How often a read re-checks that the operator still holds a drawn card (and for how long a late, still deliverable card is left alone). */
const WATCH_S = 60;
const WATCH_LATE_S = 600;
/** The 20th strike bans (the same number as settlements). */
import { MAX_STRIKES } from '@/lib/auth/strikes';
export { MAX_STRIKES };
/** Why a draw is `undelivered`. These can still be delivered late: */
export const LATE_REASONS = ['deadline'] as const;
/** ... and these never can (the card is gone, or never was drawn): */
const VOID_REASONS: readonly string[] = ['asset_moved', 'asset_not_transferable', 'pool_empty'];
/** Reasons that count against the operator's public record (an empty pool is the platform's race, not a missed delivery). */
const RECORD_REASONS = ['deadline', 'asset_moved', 'asset_not_transferable'] as const;
/** Blocks past the last valid height before a sent transaction counts as dead (a transaction cannot land after its blockhash expired; the margin covers a lagging node). */
export const EXPIRY_MARGIN_BLOCKS = 30;
const BACKOFF_S = [5, 15, 45, 120, 300, 900];
const SEND_POLL_TIMEOUT_MS = 20_000;
const MAX_HOPS = 8;

/** Every state in which a pay_first purchase still needs something done to it. */
export const PAY_FIRST_OPEN = ['awaiting_payment', 'confirming', 'paid', 'drawn', 'delivering'] as const;
/** The states in which a buyer has paid or is paying and must not start a second purchase of the same pack. */
const PAID_OR_PAYING = ['confirming', 'paid', 'drawn', 'delivering'] as const;

export interface PayFirstEnv {
  db: Db;
  deps: PackDeps;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  roundS: number;
  poolPurpose: string;
  houseKey: () => Keypair | null;
  guard: (cluster: Cluster) => void;
  loadPack: (x: Db | Tx, id: string, lock?: boolean) => Promise<PackRow>;
  loadCards: (x: Db | Tx, packId: string) => Promise<CardRow[]>;
  loadDraw: (x: Db | Tx, id: string, lock?: boolean) => Promise<DrawRow>;
  definitionOf: (p: PackRow, cards: CardRow[]) => PackDefinition;
  drawViewOf: (d: DrawRow) => Promise<PackDrawView>;
  audit: (x: Db | Tx, action: string, target: string, detail: Record<string, unknown>) => Promise<unknown>;
  takeDaily: (wallet: string, p: PackRow) => Promise<() => Promise<void>>;
  /** The platform's own wallets (settlement authority, fee wallet, house wallet): no third-party pack may name one as its operator. */
  platformWallets: () => string[];
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const iso = (d: Date) => d.toISOString();
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const backoff = (attempts: number) => BACKOFF_S[Math.min(Math.max(attempts, 0), BACKOFF_S.length - 1)]!;

export function createPayFirst(env: PayFirstEnv) {
  const { db, deps } = env;
  const { now } = env;
  const sa = deps.sa;
  const chainOf = (d: Pick<DrawRow, 'cluster'>): ChainPort => deps.chainFor(d.cluster as Cluster);
  const dueAt = (d: Pick<DrawRow, 'createdAt'>) => new Date(d.createdAt.getTime() + PAY_WINDOW_S * 1000);
  const later = (s: number) => new Date(now().getTime() + s * 1000);
  const ready = (d: DrawRow) => !d.nextAttemptAt || d.nextAttemptAt <= now();

  /** One compare-and-set on the status (and optionally on other conditions): the row after the change, or undefined when somebody else got there first. */
  async function cas(x: Db | Tx, id: string, from: readonly string[], set: Partial<typeof packDraws.$inferInsert>, extra?: ReturnType<typeof sql>): Promise<DrawRow | undefined> {
    const [row] = await x.update(packDraws).set(set).where(and(eq(packDraws.id, id), inArray(packDraws.status, [...from]), ...(extra ? [extra] : []))).returning();
    return row;
  }
  const mark = (id: string, status: string, action: string, detail: Record<string, unknown> = {}) => env.audit(db, `pack.draw.${status}`, id, { action, ...detail });

  // ---- who may take a payment ---------------------------------------------------------------------------------------------------

  /** The house key, when this pack is the house's and the key is here. The house demo delivers with it (devnet). */
  function assertHouseOperates(p: Pick<PackRow, 'operatorWallet' | 'isHouse'>): Keypair {
    const k = env.houseKey();
    if (!p.isHouse || !k || p.operatorWallet !== k.publicKey.toBase58()) throw new ApiError('paused', 'Packs are paused: the house wallet that delivers the cards is not set up on this server.');
    return k;
  }

  const strikeWindowS = () => deps.deliveryDeadlineS ?? DEFAULT_DELIVERY_DEADLINE_S;
  const deadlineS = () => deps.deliveryDeadlineS ?? DEFAULT_DELIVERY_DEADLINE_S;
  const deliverByOf = (d: Pick<DrawRow, 'deliverBy' | 'drawnAt' | 'paidAt' | 'createdAt'>): Date => d.deliverBy ?? new Date((d.drawnAt ?? d.paidAt ?? d.createdAt).getTime() + deadlineS() * 1000);

  /** Draws the operator still owes a card that CAN still be delivered (the deadline passed, the card is still there): they block every sale of that operator. */
  async function operatorBlocked(operatorProfileId: string, x: Db | Tx = db): Promise<boolean> {
    const [r] = await x.select({ n: sql<number>`count(*)::int` }).from(packDraws).innerJoin(packDefinitions, eq(packDefinitions.id, packDraws.packId))
      .where(and(eq(packDefinitions.operatorProfileId, operatorProfileId), eq(packDraws.status, 'undelivered'), inArray(packDraws.undeliveredReason, [...LATE_REASONS])));
    return (r?.n ?? 0) > 0;
  }

  /** A third-party operator may sell only while not suspended and while no overdue delivery of theirs is open. */
  async function assertOperatorMaySell(p: Pick<PackRow, 'operatorProfileId' | 'operatorWallet'>): Promise<void> {
    if (env.platformWallets().includes(p.operatorWallet)) throw new ApiError('paused', 'This pack is not for sale: its operator wallet is a platform wallet, and a platform wallet never receives a customer payment for a pack.');
    const [pr] = await db.select({ banned: profiles.isBanned }).from(profiles).where(eq(profiles.id, p.operatorProfileId));
    if (pr?.banned) throw new ApiError('paused', 'This pack is not for sale: its operator is suspended. Nothing was charged.');
    if (await operatorBlocked(p.operatorProfileId)) throw new ApiError('paused', 'This pack is paused until its operator delivers the sales that are still open. Nothing was charged.');
  }

  /**
   * The gate every step that TAKES a payment goes through (open, prepare, the buyer's signature). Third party: the operator wallet receives the money, it must
   * not be a platform wallet, not suspended, and not overdue. House: a devnet demo only; on any other network the platform never receives a customer's money.
   */
  async function assertMayTakePayment(p: PackRow): Promise<void> {
    if (p.isHouse) {
      if (!houseDemoAllowed(p.cluster)) throw new ApiError('wrong_state', 'This pack is no longer sold: Hammerprice does not run a pack that takes your payment on this network. Nothing was charged.');
      assertHouseOperates(p);
      return;
    }
    await assertOperatorMaySell(p);
  }

  // ---- expected shapes ----------------------------------------------------------------------------------------------------------

  const payExpected = (d: DrawRow, p: PackRow): PackPayExpected => PackPayExpected.parse({
    drawId: d.id, cluster: d.cluster, buyer: d.buyerWallet, operator: p.operatorWallet, usdcMint: deps.usdcMint(d.cluster as Cluster), gross: d.price.toString(),
    platformFee: splitGross(d.price, deps.feeBps).platform.toString(), feeWallet: deps.feeWallet, feePayer: sa.publicKey.toBase58(), memo: d.settlementRef ?? packMemo(d.id, p.poolHash ?? ''),
  });
  const deliveryExpected = (d: DrawRow, p: PackRow, collection: string | null): PackDeliveryExpected => ({
    drawId: d.id, operator: p.operatorWallet, buyer: d.buyerWallet, asset: d.asset!, collection, feePayer: sa.publicKey.toBase58(), memo: packDeliveryMemo(d.id),
  });

  const isLive = (d: DrawRow, at: Date) => d.status === 'awaiting_payment' && !!d.preparedMessage && !!d.roundExpiresAt && d.roundExpiresAt > at;
  const paymentOf = (d: DrawRow, p: PackPayExpected): PackPayment => ({
    txBase64: d.preparedMessage!, expected: p, lastValidBlockHeight: d.lastValidHeight ?? 0, roundExpiresAt: iso(d.roundExpiresAt ?? now()), buyerSigned: !!d.buyerSignature, operatorSigned: false,
  });

  /** Cards still free minus the paid purchases that will take one (not counting `selfId`; a demo pack takes none): a buyer is not asked to pay for a pack that cannot deliver. */
  async function assertStock(x: Db | Tx, packId: string, selfId: string | null) {
    const free = (await env.loadCards(x, packId)).filter((c) => c.status === 'available').length;
    if ((await env.loadPack(x, packId)).isHouse) { if (free <= 0) throw new ApiError('wrong_state', 'this pack is sold out. Nothing was charged.'); return; } // a demo draw takes no card: the pool never runs down
    const [owed] = await x.select({ n: sql<number>`count(*)::int` }).from(packDraws).where(and(eq(packDraws.packId, packId), inArray(packDraws.status, ['confirming', 'paid']), ...(selfId ? [ne(packDraws.id, selfId)] : [])));
    if (free - (owed?.n ?? 0) <= 0) throw new ApiError('wrong_state', 'this pack is sold out. Nothing was charged.');
  }

  // ---- open ---------------------------------------------------------------------------------------------------------------------

  /**
   * Opens a purchase. Nothing is drawn and no card is reserved: this row is only "this wallet wants to pay this price for this pack". The daily cap is taken
   * now (so parallel opens cannot exceed it) and given back when the purchase expires or fails.
   */
  async function open(buyer: { id: string; wallet: string }, p0: PackRow, input: PackOpenRequest): Promise<PackOpenResponse> {
    await assertMayTakePayment(p0);
    const mine = await db.select().from(packDraws).where(and(eq(packDraws.packId, p0.id), eq(packDraws.buyerProfileId, buyer.id))).orderBy(desc(packDraws.createdAt)).limit(20);
    const same = mine.find((d) => d.clientSeed === input.clientSeed);
    const resume = async (d: DrawRow) => ({ draw: await env.drawViewOf(d), payment: await prepare(d.id, buyer.id) });
    if (same && (PAY_FIRST_OPEN as readonly string[]).includes(same.status)) return resume(same);
    if (same) throw new ApiError('wrong_state', 'this seed was already used, start again');
    const busyMsg = 'you already have a purchase of this pack in progress, wait until it is delivered';
    if (mine.some((d) => (PAID_OR_PAYING as readonly string[]).includes(d.status))) throw new ApiError('wrong_state', busyMsg);
    const waiting = mine.find((d) => d.status === 'awaiting_payment' && dueAt(d) > now());
    if (waiting) return resume(waiting);

    const chain = deps.chainFor(p0.cluster as Cluster);
    if ((await chain.getUsdcBalance(buyer.wallet)) < p0.price) throw new ApiError('insufficient_usdc', 'you do not hold enough USDC for this pack');
    const giveBack = await env.takeDaily(buyer.wallet, p0);
    let draw: DrawRow;
    let existing: DrawRow | undefined;
    try {
      draw = await db.transaction(async (tx) => {
        const p = await env.loadPack(tx, p0.id, true);
        if (p.status !== 'live') throw new ApiError('wrong_state', 'this pack is not for sale');
        await assertStock(tx, p.id, null);
        // the pack row is locked: these checks and the insert below are one step, so two parallel opens of one wallet cannot both get through
        const busy = await tx.select().from(packDraws).where(and(eq(packDraws.packId, p.id), eq(packDraws.buyerProfileId, buyer.id), inArray(packDraws.status, ['awaiting_payment', ...PAID_OR_PAYING])));
        if (busy.some((d) => (PAID_OR_PAYING as readonly string[]).includes(d.status))) throw new ApiError('wrong_state', busyMsg);
        const waitingNow = busy.find((d) => d.status === 'awaiting_payment' && dueAt(d) > now());
        if (waitingNow) { existing = waitingNow; return waitingNow; } // a parallel open of this wallet got here first: that purchase is the one
        const dupe = (await tx.select({ id: packDraws.id }).from(packDraws).where(and(eq(packDraws.packId, p.id), eq(packDraws.buyerProfileId, buyer.id), eq(packDraws.clientSeed, input.clientSeed))))[0];
        if (dupe) throw new ApiError('wrong_state', 'this seed was already used, start again');
        const id = (deps.newId ?? (() => crypto.randomUUID()))();
        const [row] = await tx.insert(packDraws).values({
          id, packId: p.id, buyerProfileId: buyer.id, buyerWallet: buyer.wallet, cluster: p.cluster, drawIndex: null, ageConfirmedAt: now(), clientSeed: input.clientSeed, price: p.price,
          status: 'awaiting_payment', flow: 'pay_first', settlementRef: packMemo(id, p.poolHash!), createdAt: now(),
        }).returning();
        await env.audit(tx, 'pack.draw.awaiting_payment', id, { flow: 'pay_first' });
        return row!;
      });
    } catch (e) {
      await giveBack().catch(() => undefined);
      throw e;
    }
    if (existing) await giveBack().catch(() => undefined); // the count of this wallet was already taken by the purchase that is returned
    return { draw: await env.drawViewOf(draw), payment: await prepare(draw.id, buyer.id) };
  }

  // ---- prepare (the payment message, or the operator's delivery) -------------------------------------------------------------------

  async function prepare(id: string, actorProfileId: string | null): Promise<PackPayment> {
    let d = await env.loadDraw(db, id);
    const p = await env.loadPack(db, d.packId);
    if ((d.status === 'drawn' || d.status === 'undelivered') && actorProfileId === p.operatorProfileId) return prepareDelivery(id, p, actorProfileId);
    if (actorProfileId !== null && actorProfileId !== d.buyerProfileId) throw new ApiError('not_party', 'only the buyer pays for this purchase');
    if (d.status !== 'awaiting_payment') d = await advance(id);
    if (d.status !== 'awaiting_payment') throw new ApiError('wrong_state', `the purchase is ${d.status}`);
    if (dueAt(d) <= now()) { await advance(id); throw new ApiError('wrong_state', 'the time for this purchase has run out'); }
    env.guard(d.cluster as Cluster);
    await assertMayTakePayment(p);
    const expected = payExpected(d, p);
    if (isLive(d, now())) return paymentOf(d, expected);

    const chain = chainOf(d);
    if ((await chain.getUsdcBalance(d.buyerWallet)) < d.price) throw new ApiError('insufficient_usdc', 'the buyer does not hold enough USDC');
    const [bh, height] = await Promise.all([chain.getLatestBlockhash(), chain.getBlockHeight()]);
    const validS = Math.floor((bh.lastValidBlockHeight - height) * 0.4);
    if (validS < 10) throw new ApiError('rpc_unavailable', 'the latest blockhash is too old, try again');
    const txBase64 = b64(buildUnsignedPayTx(expected, bh.blockhash));
    const lengthS = Math.min(env.roundS, validS);
    return db.transaction(async (tx) => {
      const cur = await env.loadDraw(tx, id, true);
      if (cur.status !== 'awaiting_payment') throw new ApiError('wrong_state', `the purchase is ${cur.status}`);
      if (isLive(cur, now())) return paymentOf(cur, expected);
      const [u] = await tx.update(packDraws).set({
        attempt: cur.preparedMessage ? cur.attempt + 1 : cur.attempt, preparedMessage: txBase64, preparedBlockhash: bh.blockhash, lastValidHeight: bh.lastValidBlockHeight,
        roundExpiresAt: new Date(now().getTime() + lengthS * 1000), buyerSignature: null, operatorSignature: null,
      }).where(eq(packDraws.id, id)).returning();
      return paymentOf(u!, expected);
    });
  }

  // ---- the operator's delivery (third-party packs) ------------------------------------------------------------------------------

  type PackServerTx = { kind: 'delivery'; e: PackDeliveryExpected };
  const deliverable = (d: DrawRow) => (d.status === 'drawn' || d.status === 'undelivered') && !VOID_REASONS.includes(d.undeliveredReason ?? '');
  const deliveryTx = (d: DrawRow, p: PackRow, collection: string | null): PackServerTx => ({ kind: 'delivery', e: deliveryExpected(d, p, collection) });
  const deliveryToSign = (d: DrawRow, x: PackServerTx) => ({ kind: 'delivery' as const, ...x.e, cluster: d.cluster as Cluster });
  const backTo = (d: Pick<DrawRow, 'undeliveredAt'>) => (d.undeliveredAt ? 'undelivered' : 'drawn');
  const isLiveDelivery = (d: DrawRow, at: Date) => (d.status === 'drawn' || d.status === 'undelivered') && !!d.preparedMessage && !!d.roundExpiresAt && d.roundExpiresAt > at;

  /** Only the operator of the pack asks for the delivery to sign; the card is theirs to move, nobody else can ask. */
  async function prepareDelivery(id: string, p: PackRow, actorProfileId: string | null): Promise<PackPayment> {
    if (actorProfileId === null || actorProfileId !== p.operatorProfileId) throw new ApiError('not_party', 'only the operator of this pack delivers its cards');
    const d = await advance(id, { force: true });
    if (!deliverable(d)) throw new ApiError('wrong_state', d.status === 'undelivered' ? 'this card can no longer be delivered' : `the sale is ${d.status}`);
    env.guard(d.cluster as Cluster);
    const chain = chainOf(d);
    const info = await chain.readAsset(d.asset!);
    const x = deliveryTx(d, p, info?.collection ?? null);
    const live = (cur: DrawRow): PackPayment => ({ txBase64: cur.preparedMessage!, expected: deliveryToSign(d, x), lastValidBlockHeight: cur.lastValidHeight ?? 0, roundExpiresAt: iso(cur.roundExpiresAt!), buyerSigned: false, operatorSigned: false });
    if (isLiveDelivery(d, now())) return live(d);
    const [bh, height] = await Promise.all([chain.getLatestBlockhash(), chain.getBlockHeight()]);
    const validS = Math.floor((bh.lastValidBlockHeight - height) * 0.4);
    if (validS < 10) throw new ApiError('rpc_unavailable', 'the latest blockhash is too old, try again');
    const txBase64 = b64(buildUnsignedServerTx(x, bh.blockhash));
    const lengthS = Math.min(env.roundS, validS);
    return db.transaction(async (tx) => {
      const cur = await env.loadDraw(tx, id, true);
      if (!deliverable(cur)) throw new ApiError('wrong_state', `the sale is ${cur.status}`);
      if (isLiveDelivery(cur, now())) return live(cur);
      const [u] = await tx.update(packDraws).set({
        attempt: cur.preparedMessage ? cur.attempt + 1 : cur.attempt, preparedMessage: txBase64, preparedBlockhash: bh.blockhash, lastValidHeight: bh.lastValidBlockHeight,
        roundExpiresAt: new Date(now().getTime() + lengthS * 1000), buyerSignature: null, operatorSignature: null,
      }).where(eq(packDraws.id, id)).returning();
      return live(u!);
    });
  }

  /** A failure on the platform's side while the operator tried to deliver is written on the row: it is not the operator's fault and never earns a strike. */
  const platformFault = (id: string) => db.update(packDraws).set({ failureCode: 'delivery_platform_fault' }).where(and(eq(packDraws.id, id), inArray(packDraws.status, ['drawn', 'undelivered']))).then(() => undefined);

  /** The operator's signature over the prepared delivery: validated, the fee payer signature added last, simulated, claimed in the row, sent, followed to finalized. */
  async function signDelivery(id: string, p: PackRow, actorProfileId: string, input: SignInput): Promise<PackSignResponse> {
    if (input.role !== 'seller' || actorProfileId !== p.operatorProfileId) throw new ApiError('not_party', 'only the operator of this pack signs its deliveries');
    let d = await env.loadDraw(db, id);
    if (d.status === 'settled') return { step: 'settled', draw: await env.drawViewOf(d) };
    if (d.status === 'delivering') return { step: 'submitted', draw: await env.drawViewOf(d) };
    if (!deliverable(d)) throw new ApiError('wrong_state', d.status === 'undelivered' ? 'this card can no longer be delivered' : `the sale is ${d.status}`);
    env.guard(d.cluster as Cluster);
    if (!isLiveDelivery(d, now())) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');
    const chain = chainOf(d);
    const info = await chain.readAsset(d.asset!);
    if (!info) throw new ApiError('rpc_unavailable', 'the card could not be read, try again'); // an unreadable card is not a moved card: nobody is struck on a guess
    const readiness = evaluateAssetReadiness(info, { seller: p.operatorWallet });
    if (!readiness.eligible) {
      await markUndelivered(d, moved(info, p) ? 'asset_moved' : 'asset_not_transferable');
      throw new ApiError('asset_not_ready', 'the drawn card is no longer in your wallet or cannot be moved. The sale is marked as not delivered.');
    }
    const x = deliveryTx(d, p, info?.collection ?? null);
    const sig = extractServerPartySignature(unb64(input.signedTxBase64), unb64(d.preparedMessage!), x, p.operatorWallet);
    if ((await chain.getBlockHeight()) > (d.lastValidHeight ?? 0)) throw new ApiError('round_expired', 'the signing round ended before the delivery could be sent');
    const { wire, signature } = assembleServerTx(unb64(d.preparedMessage!), x, sig, sa);
    const wire64 = b64(wire);
    const sim = await chain.simulate(wire64);
    if (sim.err) {
      console.warn('pack delivery simulation failed', id, `${JSON.stringify(sim.err)} ${sim.logs.join(' ')}`.slice(0, 600));
      await platformFault(id);
      throw new ApiError('simulation_failed', `the network rejected the delivery in simulation: ${JSON.stringify(sim.err).slice(0, 120)}`);
    }
    try { await deps.spendGuard?.('third-party'); } catch (e) { await platformFault(id); throw e; }
    let claimed: DrawRow | undefined;
    try {
      claimed = await cas(db, id, ['drawn', 'undelivered'], {
        status: 'delivering', deliverySignature: signature, serverTx: wire64, serverLastValid: d.lastValidHeight, deliveryAttempts: d.deliveryAttempts + 1, failureCode: null, nextAttemptAt: null,
        preparedMessage: null, roundExpiresAt: null, operatorSignature: null,
      }, and(sql`${packDraws.deliverySignature} is null`, eq(packDraws.preparedMessage, d.preparedMessage!)));
    } catch {
      throw new ApiError('wrong_state', 'this transaction is already recorded');
    }
    if (!claimed) return { step: 'submitted', draw: await env.drawViewOf(await env.loadDraw(db, id)) };
    await mark(id, 'delivering', 'delivery_sent', { txSignature: signature, by: 'operator' });
    const back = backTo(d);
    await send(chain, wire64, signature, async (code) => {
      await cas(db, id, ['delivering'], { status: back, deliverySignature: null, serverTx: null, serverLastValid: null, failureCode: code, nextAttemptAt: null });
    });
    const deadline = now().getTime() + SEND_POLL_TIMEOUT_MS;
    d = await advance(id);
    while (d.status === 'delivering' && now().getTime() < deadline) { await env.sleep(deps.pollMs ?? 1000); d = await advance(id, { force: true }); }
    return { step: d.status === 'settled' ? 'settled' : 'submitted', draw: await env.drawViewOf(d) };
  }

  /** Is the card no longer the operator's (moved, sold, burnt), as against still theirs but not movable (frozen, a veto plugin)? */
  const moved = (info: { owner: string | null; burnt?: boolean } | null, p: Pick<PackRow, 'operatorWallet'>) => !info || !!info.burnt || (info.owner !== null && info.owner !== p.operatorWallet);

  // ---- sign (the buyer's signature sends the payment) ---------------------------------------------------------------------------

  async function sign(id: string, actorProfileId: string, input: SignInput): Promise<PackSignResponse> {
    let d = await env.loadDraw(db, id);
    const p = await env.loadPack(db, d.packId);
    if (input.role === 'seller') return signDelivery(id, p, actorProfileId, input);
    if (input.role !== 'buyer' || actorProfileId !== d.buyerProfileId) throw new ApiError('not_party', 'only the buyer signs the payment of this purchase');
    if (d.status === 'settled' || d.status === 'demo_revealed') return { step: 'settled', draw: await env.drawViewOf(d) };
    if (d.status !== 'awaiting_payment') return { step: 'submitted', draw: await env.drawViewOf(d) };
    env.guard(d.cluster as Cluster);
    await assertMayTakePayment(p);
    if (p.status !== 'live') throw new ApiError('wrong_state', 'this pack is not for sale right now. Nothing was charged.');
    if (!isLive(d, now())) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');
    await assertStock(db, d.packId, d.id); // nothing is taken for a card that is no longer there

    const sig = extractPaySignature(unb64(input.signedTxBase64), unb64(d.preparedMessage!), payExpected(d, p));
    const stored = await db.transaction(async (tx) => {
      const cur = await env.loadDraw(tx, id, true);
      if (cur.status !== 'awaiting_payment') return cur;
      if (!isLive(cur, now()) || cur.preparedMessage !== d.preparedMessage) throw new ApiError('round_expired', 'the signing round has ended; ask for a new one');
      const [u] = await tx.update(packDraws).set({ buyerSignature: b64(sig) }).where(eq(packDraws.id, id)).returning();
      return u!;
    });
    d = stored;
    if (d.status !== 'awaiting_payment') return { step: 'submitted', draw: await env.drawViewOf(d) };
    return sendPayment(d, p);
  }

  async function sendPayment(d0: DrawRow, p: PackRow): Promise<PackSignResponse> {
    const id = d0.id, chain = chainOf(d0), expected = payExpected(d0, p);
    if (!d0.buyerSignature || !d0.preparedMessage) throw new ApiError('wrong_state', 'the buyer must sign first');
    if (!isLive(d0, now()) || (await chain.getBlockHeight()) > (d0.lastValidHeight ?? 0)) {
      await db.update(packDraws).set({ buyerSignature: null, roundExpiresAt: now() }).where(and(eq(packDraws.id, id), eq(packDraws.status, 'awaiting_payment')));
      throw new ApiError('round_expired', 'the signing round ended before the payment could be sent');
    }
    const { wire, signature } = assemblePayTx(unb64(d0.preparedMessage), expected, unb64(d0.buyerSignature), sa);
    const wire64 = b64(wire);
    const sim = await chain.simulate(wire64);
    if (sim.err) {
      const winner = await env.loadDraw(db, id);
      if (winner.status !== 'awaiting_payment') return { step: winner.status === 'settled' || winner.status === 'demo_revealed' ? 'settled' : 'submitted', draw: await env.drawViewOf(winner) };
      const text = `${JSON.stringify(sim.err)} ${sim.logs.join(' ')}`;
      console.warn('pack payment simulation failed', id, text.slice(0, 600));
      throw new ApiError(/insufficient funds|InsufficientFunds|custom program error: 0x1\b/i.test(text) ? 'insufficient_usdc' : 'simulation_failed', `the network rejected the payment in simulation: ${JSON.stringify(sim.err).slice(0, 120)}`);
    }
    await deps.spendGuard?.(p.isHouse ? 'house' : 'third-party');
    let claimed: DrawRow | undefined;
    try {
      // The pack row is locked: the stock check and the claim are one step, so two buyers cannot both send a payment for the last card. Nothing has been sent yet,
      // so the loser is turned away BEFORE any money moves (a third-party pack has no refund to fall back on).
      claimed = await db.transaction(async (tx) => {
        const locked = await env.loadPack(tx, d0.packId, true);
        if (locked.status !== 'live') throw new ApiError('wrong_state', 'this pack is not for sale right now. Nothing was charged.');
        await assertStock(tx, d0.packId, id);
        return cas(tx, id, ['awaiting_payment'], { status: 'confirming', txSignature: signature, failureCode: null, nextAttemptAt: null }, sql`${packDraws.txSignature} is null`);
      });
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError('wrong_state', 'this transaction is already recorded'); // the unique index: one transaction id belongs to one purchase
    }
    if (!claimed) return { step: 'submitted', draw: await env.drawViewOf(await env.loadDraw(db, id)) };
    await mark(id, 'confirming', 'payment_sent', { txSignature: signature, explorer: explorerTxUrl(signature, d0.cluster as Cluster) });
    await send(chain, wire64, signature, async (code) => {
      // the node refused it for good: it can never land, so the purchase goes back to waiting for a signature
      await cas(db, id, ['confirming'], { status: 'awaiting_payment', txSignature: null, buyerSignature: null, roundExpiresAt: now(), failureCode: code === 'blockhash_expired' ? 'round_expired' : 'simulation_failed' });
    });
    const deadline = now().getTime() + SEND_POLL_TIMEOUT_MS;
    // follow the purchase while the PLATFORM has something to do; a third-party draw then waits for the operator (no point polling for a day)
    const following = (s: string) => s === 'confirming' || s === 'paid' || s === 'delivering' || (s === 'drawn' && p.isHouse); // the house demo delivers by itself; a third-party draw then waits for its operator
    let cur = await advance(id);
    while (following(cur.status) && now().getTime() < deadline) { await env.sleep(deps.pollMs ?? 1000); cur = await advance(id, { force: true }); }
    return { step: cur.status === 'settled' || cur.status === 'demo_revealed' ? 'settled' : 'submitted', draw: await env.drawViewOf(cur) };
  }

  /** Sends bytes; a definite refusal calls `onRefused`, an unknown outcome (the node died while accepting) is left to the chain to decide. */
  async function send(chain: ChainPort, wire64: string, signature: string, onRefused: (code: string) => Promise<unknown>): Promise<boolean> {
    try {
      const sent = await chain.send(wire64);
      if (sent !== signature) throw new ApiError('simulation_failed', 'the node returned a different signature');
      return true;
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'blockhash_expired' || err.code === 'simulation_failed')) { await onRefused(err.code); return false; }
      return true; // outcome unknown: it may have landed
    }
  }

  // ---- the state machine --------------------------------------------------------------------------------------------------------

  /**
   * Moves one purchase forward as far as it can go right now (a few hops: for example a finalized payment is drawn and, for the house demo, its delivery sent in
   * one go). Safe to call from anywhere, any number of times: every hop is a compare-and-set. `force` ignores the back-off of the steps that only LOOK at the chain
   * (the buyer's live polling and the sweep); a step that SENDS something new (the house demo delivery) always keeps its own back-off.
   */
  async function advance(id: string, o: { force?: boolean } = {}): Promise<DrawRow> {
    let d = await env.loadDraw(db, id);
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      if (d.flow !== 'pay_first') return d;
      const before = d.status;
      if (!o.force && !ready(d) && d.status !== 'awaiting_payment') return d;
      try {
        if (d.status === 'awaiting_payment') await expireUnpaid(d);
        else if (d.status === 'confirming') await confirmPayment(d);
        else if (d.status === 'paid') await runDraw(d);
        else if (d.status === 'drawn' || d.status === 'delivering' || d.status === 'undelivered') await deliver(d);
        else return d;
      } catch (e) {
        // A chain that does not answer, a missing key or a refused transaction must not break a read or lose a step: the row keeps its state and the next call
        // retries it (a code that is not about the chain is logged, so an operator sees a stuck purchase). Only an unexpected error (a database failure) propagates.
        if (e instanceof ApiError) {
          if (e.code !== 'rpc_unavailable' && e.code !== 'paused') console.warn('pack purchase step failed', id, d.status, e.code);
          return env.loadDraw(db, id);
        }
        throw e;
      }
      d = await env.loadDraw(db, id);
      if (d.status === before) return d;
      // a server transaction was just sent: give the chain a moment (the next call follows it) instead of asking about it in the same breath
      if (!o.force && before === 'drawn' && d.status === 'delivering') return d;
    }
    return d;
  }

  async function retryLater(d: DrawRow, extra: Partial<typeof packDraws.$inferInsert> = {}, attempts = 0) {
    await db.update(packDraws).set({ nextAttemptAt: later(backoff(attempts)), ...extra }).where(eq(packDraws.id, d.id));
  }

  /** The count of a purchase that never became a delivered card is given back (the cap limits what a wallet gets, not what it tried). */
  async function releaseDaily(d: DrawRow) {
    await db.update(packPurchaseCounts).set({ count: sql`greatest(${packPurchaseCounts.count} - 1, 0)` })
      .where(and(eq(packPurchaseCounts.wallet, d.buyerWallet), eq(packPurchaseCounts.packId, d.packId), eq(packPurchaseCounts.day, dayOf(d.createdAt))));
  }

  async function expireUnpaid(d: DrawRow) {
    if (dueAt(d) > now()) return;
    const u = await cas(db, d.id, ['awaiting_payment'], { status: 'expired', failureCode: 'payment_window', preparedMessage: null, roundExpiresAt: null, buyerSignature: null }, sql`${packDraws.txSignature} is null`);
    if (!u) return;
    await releaseDaily(d);
    await mark(d.id, 'expired', 'window_passed', { code: 'payment_window' });
  }

  /** The payment was sent: wait for it to be FINALIZED, then check legs and memo; only then is the purchase `paid`. */
  async function confirmPayment(d: DrawRow) {
    const p = await env.loadPack(db, d.packId);
    const chain = chainOf(d);
    const st = await chain.getSignatureStatus(d.txSignature!);
    const reopen = async (code: string) => {
      // the transaction can no longer land and moved no money: the buyer may sign again, or the window ends it
      const u = await cas(db, d.id, ['confirming'], { status: 'awaiting_payment', txSignature: null, buyerSignature: null, roundExpiresAt: now(), failureCode: code });
      if (u) await mark(d.id, 'awaiting_payment', 'payment_not_landed', { code });
    };
    if (!st) {
      if ((await chain.getBlockHeight()) > (d.lastValidHeight ?? 0) + EXPIRY_MARGIN_BLOCKS) { await reopen('round_expired'); return; }
      if (d.buyerSignature && d.preparedMessage) { // not seen yet and still valid: the same bytes again (same signature id), in case the first send never left
        try {
          const { wire, signature } = assemblePayTx(unb64(d.preparedMessage), payExpected(d, p), unb64(d.buyerSignature), sa);
          if (signature === d.txSignature) await chain.send(b64(wire));
        } catch { /* not sendable any more: the height check above ends it */ }
      }
      return;
    }
    if (st.err) { await reopen('tx_failed'); return; }
    if (!(st.finalized ?? false)) return; // confirmed is not enough: nothing is drawn before the payment is final
    const parsed = await chain.getTransaction(d.txSignature!);
    if (!parsed) return;
    const verdict = verifyPackPaid(parsed, payExpected(d, p));
    if (!verdict.ok) {
      // Cannot happen with a transaction we built and validated; if it ever does, money may have moved in a way we did not intend: stop, keep the evidence, tell ops.
      const u = await cas(db, d.id, ['confirming'], { status: 'failed', failureCode: verdict.code });
      if (u) { await env.audit(db, 'pack.payment.mismatch', d.id, { code: verdict.code, detail: verdict.detail.slice(0, 300), txSignature: d.txSignature }); await releaseDaily(d); }
      return;
    }
    const slot = parsed.slot;
    if (!slot || slot < 1) return; // a node that does not say where the transaction landed: try again
    const u = await cas(db, d.id, ['confirming'], { status: 'paid', paidAt: now(), paymentSlot: slot, failureCode: null, nextAttemptAt: null, preparedMessage: null, roundExpiresAt: null, buyerSignature: null });
    if (u) { await mark(d.id, 'paid', 'payment_finalized', { txSignature: d.txSignature, slot }); invalidateBalance(d.buyerWallet); invalidateBalance(p.operatorWallet); }
  }

  /** The draw, after the payment is final: the input holds the payment signature, its slot and the first block after it. */
  async function runDraw(d: DrawRow) {
    const key = deps.vrfKey();
    if (!key) { await retryLater(d, {}, 0); return; } // the draw key is not here right now: wait
    // Purchases are drawn in the ORDER OF THEIR PAYMENTS (slot, then transaction id in byte order): the server can not pick which buyer gets which index and so which
    // cards are already taken for whom. The verify page checks that order from the public log. A purchase whose payment is still being confirmed may land in an
    // earlier slot, so nobody is drawn while one of the pack is confirming (it ends in seconds, or reopens once it can no longer land).
    const [confirming] = await db.select({ n: sql<number>`count(*)::int` }).from(packDraws).where(and(eq(packDraws.packId, d.packId), eq(packDraws.status, 'confirming'), ne(packDraws.id, d.id)));
    if ((confirming?.n ?? 0) > 0) { await retryLater(d, {}, 0); return; }
    const [ahead] = await db.select({ n: sql<number>`count(*)::int` }).from(packDraws).where(and(
      eq(packDraws.packId, d.packId), eq(packDraws.status, 'paid'), ne(packDraws.id, d.id),
      sql`(${packDraws.paymentSlot} < ${d.paymentSlot!} or (${packDraws.paymentSlot} = ${d.paymentSlot!} and ${packDraws.txSignature} collate "C" < ${d.txSignature!}::text collate "C"))`));
    if ((ahead?.n ?? 0) > 0) { await retryLater(d, {}, 0); return; }
    const beacon: Beacon | null = await deps.beaconAfter(d.cluster as Cluster, d.paymentSlot!).catch(() => null);
    if (!beacon || beacon.slot <= d.paymentSlot!) { await retryLater(d, {}, 0); return; } // that block is not final yet
    const payment = { signature: d.txSignature!, slot: d.paymentSlot! };
    const drawn = await db.transaction(async (tx) => {
      const pk = await env.loadPack(tx, d.packId, true);
      const cur = await env.loadDraw(tx, d.id, true);
      if (cur.status !== 'paid') return false;
      const cards = await env.loadCards(tx, pk.id);
      const taken = cards.filter((c) => c.status !== 'available').map((c) => c.position);
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${packDraws.drawIndex}), -1)::int` }).from(packDraws).where(and(eq(packDraws.packId, pk.id), isNotNull(packDraws.drawIndex)));
      const index = (last?.n ?? -1) + 1;
      const requestId = packDrawSubject(pk.id, index); // derived from public values: the server cannot try many ids for one outcome
      const made = makeDraw({
        cluster: pk.cluster as Cluster, packId: pk.id, poolHash: pk.poolHash!, def: env.definitionOf(pk, cards), buyer: cur.buyerWallet, seed: cur.clientSeed, index, taken, beacon, payment, prove: (a) => key.prove(a),
      });
      if (!made.selection) {
        await cas(tx, cur.id, ['paid'], { status: 'undelivered', undeliveredAt: now(), undeliveredReason: 'pool_empty', nextAttemptAt: null }); // no refund exists: the buyer keeps the evidence
        await tx.update(packDefinitions).set({ status: 'sold_out', updatedAt: now() }).where(and(eq(packDefinitions.id, pk.id), eq(packDefinitions.status, 'live')));
        await env.audit(tx, 'pack.draw.undelivered', cur.id, { action: 'marked_undelivered', reason: 'pool_empty' });
        return false;
      }
      const card = sortedCards(cards)[made.selection.position]!;
      const at = now();
      // DEMO (devnet house pack): the payment and the draw are real, the pool is not used up: no card is reserved (the demo draws again from the same pool), no deadline and no
      // strike apply, and the draw is terminal at once (`demo_revealed`). The buyer still gets a card: a COPY of the drawn replica is minted into their wallet right after (mintDemoCopy).
      const demo = pk.isHouse;
      await tx.insert(vrfRequests).values({
        id: requestId, purpose: env.poolPurpose, subjectType: 'pack_draw', subjectId: cur.id, cluster: pk.cluster, publicKey: key.publicKey, params: made.params, paramsHash: made.paramsHash,
        status: 'revealed', revealBy: at, alphaText: made.alphaText, proofHex: made.proof.proofHex, outputHex: made.proof.outputHex, beaconSlot: beacon.slot, beaconBlockhash: beacon.blockhash,
        result: { tier: made.selection.tier, position: made.selection.position, asset: card.asset }, revealedAt: at,
      });
      await tx.update(packDraws).set({
        status: demo ? 'demo_revealed' : 'drawn', drawIndex: index, vrfRequestId: requestId, vrfInput: made.alphaText, proofHex: made.proof.proofHex, outputHex: made.proof.outputHex, tier: made.selection.tier, cardId: card.id, asset: card.asset,
        drawnAt: at, nextAttemptAt: null, ...(demo ? { settledAt: at, deliverBy: null } : { deliverBy: new Date(at.getTime() + deadlineS() * 1000) }),
      }).where(eq(packDraws.id, cur.id));
      if (!demo) await tx.update(packPoolCards).set({ status: 'reserved' }).where(eq(packPoolCards.id, card.id));
      await env.audit(tx, demo ? 'pack.draw.demo_revealed' : 'pack.draw.drawn', cur.id, { action: demo ? 'demo_revealed' : 'drawn', index, beacon, ...(demo ? { poolCardMoved: false } : {}) });
      return demo ? 'demo' : 'drawn';
    });
    if (drawn === 'drawn') { try { deps.onDrawn?.(d.id); } catch { /* a notification never breaks a draw */ } }
    if (drawn === 'demo') await mintDemoCopy(d);
  }

  /**
   * DEMO (devnet): mints a copy of the drawn replica into the buyer's wallet, so the card is really theirs like a pack card is. BEST EFFORT: a low SOL balance, an RPC error or a missing
   * card is logged and the draw stays as it is. ONCE per draw: the claim is `delivery_attempts` going from 0 to 1 (only a demo draw uses it, and nothing retries), so a second call,
   * a retried poll or a concurrent one finds the claim taken and mints nothing. The mint transaction is kept in `delivery_signature` and shown with the result (explorer link).
   */
  async function mintDemoCopy(d: DrawRow) {
    try {
      if (!deps.mintDemoCopy || !houseDemoAllowed(d.cluster)) return; // devnet only: on any other network nothing is ever minted
      const claimed = await cas(db, d.id, ['demo_revealed'], { deliveryAttempts: 1 }, sql`${packDraws.deliveryAttempts} = 0 and ${packDraws.deliverySignature} is null`);
      if (!claimed?.asset) return;
      const minted = await deps.mintDemoCopy({ wallet: claimed.buyerWallet, source: claimed.asset });
      if (!minted) return;
      await db.update(packDraws).set({ deliverySignature: minted.signature }).where(eq(packDraws.id, d.id));
      await mark(d.id, 'demo_minted', 'demo_minted', { mint: minted.mint, txSignature: minted.signature, explorer: explorerTxUrl(minted.signature, d.cluster as Cluster) });
    } catch (e) {
      console.warn('demo card copy was not minted', d.id, (e as Error).message);
    }
  }

  /** A drawn card waits for its operator. (A house draw made before demos ended without delivery is closed as a demo: nothing is delivered, no copy is minted.) */
  async function deliver(d: DrawRow) {
    const p = await env.loadPack(db, d.packId);
    if (d.status === 'delivering') { await followDelivery(d, p); return; }
    if (p.isHouse && d.status === 'drawn') { await endDemo(d); return; }
    await watchOperator(d, p);
  }

  /** An old house draw that was drawn and reserved its card: it ends as a demo draw, the card goes back to the pool, nothing is sent and no copy is minted. */
  async function endDemo(d: DrawRow) {
    await db.transaction(async (tx) => {
      const cur = await cas(tx, d.id, ['drawn'], { status: 'demo_revealed', settledAt: now(), deliverBy: null, nextAttemptAt: null });
      if (!cur) return;
      if (cur.cardId) await tx.update(packPoolCards).set({ status: 'available' }).where(and(eq(packPoolCards.id, cur.cardId), eq(packPoolCards.status, 'reserved')));
      await env.audit(tx, 'pack.draw.demo_revealed', d.id, { action: 'demo_revealed', poolCardMoved: false, from: 'drawn' });
    });
  }

  /** Follows the delivery transaction that was sent (by the house demo, or signed by the operator) to finalized. */
  async function followDelivery(d: DrawRow, p: PackRow) {
    const chain = chainOf(d);
    const reopen = async (code: string) => {
      // it can no longer land: back to waiting for the operator (the house demo sends a new one after a back-off)
      const u = await cas(db, d.id, ['delivering'], { status: backTo(d), deliverySignature: null, serverTx: null, serverLastValid: null, failureCode: code, nextAttemptAt: p.isHouse ? later(backoff(d.deliveryAttempts)) : null });
      if (u) await mark(d.id, backTo(d), 'delivery_not_landed', { code, attempts: d.deliveryAttempts });
    };
    const st = await chain.getSignatureStatus(d.deliverySignature!);
    if (!st) {
      if ((await chain.getBlockHeight()) > (d.serverLastValid ?? 0) + EXPIRY_MARGIN_BLOCKS) { await reopen('delivery_expired'); return; }
      if (d.serverTx) await chain.send(d.serverTx).catch(() => undefined); // the stored bytes again, same signature id
      return;
    }
    if (st.err) { await reopen('delivery_tx_failed'); return; }
    if (!(st.finalized ?? false)) return;
    const [parsed, asset] = await Promise.all([chain.getTransaction(d.deliverySignature!), chain.readAsset(d.asset!)]);
    if (!parsed) return;
    const verdict = verifyDelivered(parsed, deliveryExpected(d, p, asset?.collection ?? null), asset?.owner ?? null);
    if (!verdict.ok) {
      // A finalized transaction without an error that does not verify is never sent again (it may have moved the card): hold it, tell ops, look again later.
      await env.audit(db, 'pack.delivery.mismatch', d.id, { code: verdict.code, detail: verdict.detail.slice(0, 300), txSignature: d.deliverySignature });
      await db.update(packDraws).set({ nextAttemptAt: later(300), failureCode: verdict.code }).where(and(eq(packDraws.id, d.id), eq(packDraws.status, 'delivering')));
      return;
    }
    await settle(d, 'delivered', { txSignature: d.deliverySignature });
  }

  /**
   * THIRD PARTY: a drawn card waits for its operator. Every look at it checks three things: the buyer does not already hold it (delivered outside the
   * platform: settled), the operator still holds it and can move it (otherwise the draw is VOIDED: undelivered, strike, pause), and the deadline.
   * The card is the one the draw chose; nothing else is ever delivered, and the platform signs and pays nothing for the operator.
   */
  async function watchOperator(d: DrawRow, p: PackRow) {
    const chain = chainOf(d);
    const info = await chain.readAsset(d.asset!);
    if (info?.owner === d.buyerWallet) { await settle(d, 'delivered_externally', {}); return; }
    if (!info) return; // not readable right now: look again later, never void on a guess
    const readiness = evaluateAssetReadiness(info, { seller: p.operatorWallet });
    if (!readiness.eligible) {
      if (!(d.status === 'undelivered' && VOID_REASONS.includes(d.undeliveredReason ?? ''))) await markUndelivered(d, moved(info, p) ? 'asset_moved' : 'asset_not_transferable');
      return;
    }
    if (d.status === 'drawn') {
      const left = deliverByOf(d).getTime() - now().getTime();
      if (left <= 0) { await markUndelivered(d, 'deadline'); return; }
      if (left <= REMIND_BEFORE_S * 1000) { try { deps.onDeliveryDue?.(d.id); } catch { /* never breaks a read */ } }
    }
    if (!p.isHouse) await db.update(packDraws).set({ nextAttemptAt: later(d.status === 'drawn' ? WATCH_S : WATCH_LATE_S) }).where(eq(packDraws.id, d.id)); // look again in a minute, not on every read
  }

  /**
   * One strike per operator per delivery deadline (an operator who is offline for a day with five open sales has one incident, not five), a ban at three. The
   * house demo and bots are never struck. Called inside the transaction that marks the draw, with the operator's lock.
   */
  async function strikeOperator(tx: Tx, p: PackRow, d: DrawRow, reason: string): Promise<boolean> {
    if (p.isHouse) return false;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'pack-strike:' + p.operatorProfileId}))`);
    const [op] = await tx.select({ id: profiles.id, isBot: profiles.isBot, wallet: profiles.walletAddress }).from(profiles).where(eq(profiles.id, p.operatorProfileId));
    if (!op || op.isBot || op.wallet === deps.houseOperator?.publicKey.toBase58()) return false;
    const since = new Date(now().getTime() - strikeWindowS() * 1000);
    const [recent] = await tx.select({ n: sql<number>`count(*)::int` }).from(packDraws).innerJoin(packDefinitions, eq(packDefinitions.id, packDraws.packId))
      .where(and(eq(packDefinitions.operatorProfileId, p.operatorProfileId), isNotNull(packDraws.strikeAt), sql`${packDraws.strikeAt} > ${since}`));
    if ((recent?.n ?? 0) > 0) { await env.audit(tx, 'pack.strike.skipped', d.id, { reason, why: 'already struck within the delivery deadline' }); return false; }
    const [u] = await tx.update(profiles).set({ strikes: sql`${profiles.strikes} + 1`, updatedAt: now() }).where(eq(profiles.id, op.id)).returning({ strikes: profiles.strikes });
    if (u && u.strikes >= MAX_STRIKES) await tx.update(profiles).set({ isBanned: true, bannedReason: `${MAX_STRIKES} pack deliveries or settlements not completed`, bannedAt: now() }).where(eq(profiles.id, op.id));
    await tx.update(packDraws).set({ strikeAt: now() }).where(eq(packDraws.id, d.id));
    await env.audit(tx, 'strike', op.id, { pack: p.id, draw: d.id, reason, strikes: u?.strikes });
    return true;
  }

  /**
   * The operator did not deliver: `deadline` (still deliverable late), or the card is gone (`asset_moved`, `asset_not_transferable`: the operator VOIDED a draw after the
   * result was fixed, which is a way to re-roll, so it costs a strike and pauses the pack just like a missed deadline). Nobody is refunded by the platform: it holds no
   * money. The buyer's page shows the operator wallet, the payment signature and the proof. A late `deadline` draw blocks the operator's sales until delivered.
   */
  async function markUndelivered(d: DrawRow, reason: string) {
    const voided = VOID_REASONS.includes(reason);
    await db.transaction(async (tx) => {
      const p = await env.loadPack(tx, d.packId, true);
      const cur = await env.loadDraw(tx, d.id, true);
      const fromLate = cur.status === 'undelivered' && !VOID_REASONS.includes(cur.undeliveredReason ?? '') && voided; // a late card that now vanished
      if (cur.status !== 'drawn' && !fromLate) return;
      const at = now();
      await tx.update(packDraws).set({
        status: 'undelivered', undeliveredAt: cur.undeliveredAt ?? at, undeliveredReason: reason, nextAttemptAt: null, preparedMessage: null, roundExpiresAt: null, operatorSignature: null,
      }).where(eq(packDraws.id, cur.id));
      if (voided && cur.cardId) await tx.update(packPoolCards).set({ status: 'removed' }).where(and(eq(packPoolCards.id, cur.cardId), eq(packPoolCards.status, 'reserved')));
      await tx.update(packDefinitions).set({ status: 'paused', updatedAt: at }).where(and(eq(packDefinitions.id, p.id), eq(packDefinitions.status, 'live')));
      // no strike when the operator tried and the platform failed, or when the card is still the operator's but cannot be moved (a freeze by a third party is not their act)
      const platformSide = reason === 'asset_not_transferable' || (reason === 'deadline' && (cur.deliveryAttempts > 0 || cur.failureCode === 'delivery_platform_fault'));
      const struck = platformSide ? false : await strikeOperator(tx, p, cur, reason);
      await env.audit(tx, 'pack.draw.undelivered', cur.id, { action: 'marked_undelivered', reason, struck, platformSide, operator: p.operatorWallet, payment: cur.txSignature });
      await env.audit(tx, 'pack.paused', p.id, { reason: 'undelivered', draw: cur.id });
    });
  }

  /** The card is the buyer's: the purchase is delivered. Locks pack then draw. */
  async function settle(d: DrawRow, action: string, detail: Record<string, unknown>) {
    const done = await db.transaction(async (tx) => {
      await env.loadPack(tx, d.packId, true);
      const cur = await env.loadDraw(tx, d.id, true);
      if (cur.status !== 'delivering' && cur.status !== 'drawn' && cur.status !== 'undelivered') return false;
      await tx.update(packDraws).set({ status: 'settled', settledAt: now(), failureCode: null, serverTx: null, serverLastValid: null, nextAttemptAt: null, preparedMessage: null, roundExpiresAt: null }).where(eq(packDraws.id, d.id));
      if (cur.cardId) await tx.update(packPoolCards).set({ status: 'drawn' }).where(eq(packPoolCards.id, cur.cardId));
      const left = (await env.loadCards(tx, cur.packId)).filter((c) => c.status === 'available' || c.status === 'reserved').length;
      if (left === 0) await tx.update(packDefinitions).set({ status: 'sold_out', updatedAt: now() }).where(and(eq(packDefinitions.id, cur.packId), eq(packDefinitions.status, 'live')));
      await env.audit(tx, 'pack.draw.settled', d.id, { action, late: !!cur.undeliveredAt, ...detail, explorer: d.deliverySignature ? explorerTxUrl(d.deliverySignature, d.cluster as Cluster) : null });
      return true;
    });
    if (done) { invalidateBalance(d.buyerWallet); }
  }

  // ---- the operator's view and public record -------------------------------------------------------------------------------------

  /** Draws of this operator's packs that are overdue (and so are marked undelivered the first time anybody looks), so a buyer sees an honest record BEFORE paying. */
  async function settleOverdue(operatorProfileId: string, limit = 20): Promise<void> {
    const rows = await db.select({ id: packDraws.id }).from(packDraws).innerJoin(packDefinitions, eq(packDefinitions.id, packDraws.packId))
      .where(and(eq(packDefinitions.operatorProfileId, operatorProfileId), eq(packDraws.status, 'drawn'), sql`${packDraws.deliverBy} < now()`)).limit(limit);
    for (const r of rows) await advance(r.id, { force: true }).catch(() => undefined);
  }

  /** The public delivery record per operator on this network: what a buyer checks before paying them directly. */
  async function operatorRecords(operatorProfileIds: string[], cluster: string): Promise<Map<string, PackOperatorRecord>> {
    const out = new Map<string, PackOperatorRecord>();
    if (operatorProfileIds.length === 0) return out;
    const res = await db.execute(sql`
      select p.operator_profile_id as op,
        count(*) filter (where d.status = 'settled')::int as delivered,
        count(*) filter (where d.status = 'settled' and d.undelivered_at is not null)::int as late,
        count(*) filter (where d.status = 'undelivered' and d.undelivered_reason in (${sql.join(RECORD_REASONS.map((r) => sql`${r}`), sql`, `)}))::int as undelivered,
        (percentile_cont(0.5) within group (order by extract(epoch from (d.settled_at - d.paid_at))) filter (where d.status = 'settled' and d.paid_at is not null and d.settled_at is not null))::float8 as median
      from pack_draws d join pack_definitions p on p.id = d.pack_id
      where d.flow = 'pay_first' and p.cluster = ${cluster} and p.is_house = false and p.operator_profile_id in (${sql.join(operatorProfileIds.map((i) => sql`${i}::uuid`), sql`, `)})
      group by p.operator_profile_id`);
    for (const r of (res as unknown as { rows: { op: string; delivered: number; late: number; undelivered: number; median: number | null }[] }).rows) {
      out.set(r.op, { delivered: r.delivered, late: r.late, undelivered: r.undelivered, medianDeliverySeconds: r.median === null ? null : Math.round(r.median) });
    }
    for (const id of operatorProfileIds) if (!out.has(id)) out.set(id, { delivered: 0, late: 0, undelivered: 0, medianDeliverySeconds: null });
    return out;
  }

  /** The sales this operator still has to deliver, with the drawn card (only the operator sees it here). Overdue ones (not yet marked) are marked first. */
  async function listDeliveries(operatorProfileId: string): Promise<PackDeliveryItem[]> {
    await settleOverdue(operatorProfileId);
    const rows = await db.select({ d: packDraws, p: packDefinitions, c: packPoolCards }).from(packDraws)
      .innerJoin(packDefinitions, eq(packDefinitions.id, packDraws.packId)).innerJoin(packPoolCards, eq(packPoolCards.id, packDraws.cardId))
      .where(and(eq(packDefinitions.operatorProfileId, operatorProfileId), eq(packDefinitions.isHouse, false), inArray(packDraws.status, ['drawn', 'undelivered'])))
      .orderBy(asc(packDraws.drawnAt)).limit(100);
    const out: PackDeliveryItem[] = [];
    for (const r of rows) {
      if (VOID_REASONS.includes(r.d.undeliveredReason ?? '')) continue; // nothing left to deliver
      out.push({
        draw: await env.drawViewOf(r.d), packName: r.p.name as { de: string; en: string },
        card: { asset: r.c.asset, name: r.c.name, imageUrl: r.c.imageUrl ?? null, tier: r.c.tier },
        deliverBy: iso(deliverByOf(r.d)), late: r.d.status === 'undelivered',
      });
    }
    return out;
  }

  // ---- the sweep and lazy kicks -------------------------------------------------------------------------------------------------

  /** Everything unfinished (up to `limit`), oldest first. `force` ignores the back-off of the steps that only look. Never throws for one bad row. */
  async function advanceOpen(o: { limit: number; force: boolean }): Promise<{ expired: number; delivered: number }> {
    const rows = await db.select({ id: packDraws.id, status: packDraws.status }).from(packDraws)
      .where(and(eq(packDraws.flow, 'pay_first'), inArray(packDraws.status, [...PAY_FIRST_OPEN]), ...(o.force ? [] : [sql`(${packDraws.nextAttemptAt} is null or ${packDraws.nextAttemptAt} <= now())`])))
      .orderBy(asc(packDraws.createdAt)).limit(o.limit);
    const n = { expired: 0, delivered: 0 };
    for (const r of rows) {
      const after = await advance(r.id, { force: o.force }).catch(() => null);
      if (!after || after.status === r.status) continue;
      if (after.status === 'expired') n.expired++;
      else if (after.status === 'settled') n.delivered++;
    }
    return n;
  }

  return { open, prepare, sign, advance, advanceOpen, assertHouseOperates, assertOperatorMaySell, operatorBlocked, operatorRecords, settleOverdue, listDeliveries, payExpected };
}

export type PayFirst = ReturnType<typeof createPayFirst>;
