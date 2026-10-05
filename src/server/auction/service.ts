/**
 * The auction service. Server-only: it owns every write to
 * bids, lots, shows, paddles and the settlement row that a sold lot creates. Routes (LIVE), auth (AUTH) and the
 * settlement service (CHAIN) call it; it never calls the chain.
 *
 * Locking, the whole story:
 *   - A bid locks ONE row, its lot (`FOR NO KEY UPDATE`), then reads the clock from the database, so the deadline check
 *     and `placed_at` both happen after the lock. No bid ever takes a show lock.
 *   - `advanceShow` first asks one cheap question without locks ("is anything due?"). Only then it locks the SHOW row
 *     (serialising advancers) and then each lot it changes. Order is always show, then lot: no cycle, no deadlock.
 *   - `NO KEY UPDATE` rather than `UPDATE`, because every show_events insert takes a KEY SHARE lock on the show row
 *     (foreign key); a plain UPDATE lock would make bids wait for advancers.
 *   - The partial unique indexes (one open lot per show, one live settlement per lot) mean that even a buggy caller cannot
 *     corrupt a show.
 *
 * Time comes from the database (`clock_timestamp()`). The optional `now` arguments exist for tests and replays only;
 * routes must never pass one.
 *
 * Legacy rows: a lot with `closes_at` NULL is not timed. It never closes here, refuses new-engine bids, and blocks the next
 * lot from opening. Shows with settlement_mode 'none' or mode 'manual' are never advanced.
 */
import { assertNotListed } from '@/server/assets/listed';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { auditLogs, bids, db, devnetAssets, lots, paddles, profiles, settlements, showEvents, shows } from '@/db';
import { ApiError, type ErrorCode } from '@/contracts/errors';
import { MAX_BID } from '@/contracts/common';
import type { EventKind } from '@/contracts/events';
import { settlementMemo } from '@/contracts/chain';
import type { AssetReadiness } from '@/contracts/chain';
import type { CatalogueLot, CreateShowRequest, LiveSnapshot, ShowCore, ShowDetail, ShowSummary } from '@/contracts/api';
import type { AdvanceResult, AuctionService, ListShowsQuery, Paddle, PlaceBidInput, PlaceBidResult, ShowList } from '@/contracts/services';
import { createMemo } from '@/lib/http/memo';
import { isValidUuid } from '@/lib/uuid';
import { isAuctioneer } from '@/lib/auctioneer';
import { DEMO_SHOW_ID, SEED_SELLER_WALLET } from '@/lib/demo-show';
import { featureOn } from '@/lib/features';
import { resolveCluster } from '@/lib/chain/config';
import { defaultIncrement, defaultOpeningPrice } from '@/lib/catalogue';
import { bidLogHash } from '@/lib/auction/bidlog';
import { decideBid, decidePause, decideTick, extendedClosesAt, orderGateOf, outcomeAtClose, pauseExpired, resumeShift, type TickAction } from '@/lib/auction/engine';
import { platformFeeBps, splitGross } from '@/lib/auction/fees';
import { envRuleDefaults, maxSellerExtendS, PAUSE_MAX_COUNT, resolveRules, timedMinDurationS } from '@/lib/auction/rules';
import { operatorWallets } from '@/lib/auctioneer';
import { telegramHooks } from '@/server/telegram/hooks';
import { buildSnapshot, isManaged, toCatalogueLot, toShowCore, videoEnabledFor, type Exec, type LotRow, type ShowRow } from './snapshot';

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

const NOW_MS = sql<number>`(extract(epoch from clock_timestamp()) * 1000)::float8`;
const rowsOf = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
/** The database clock in whole milliseconds. Always a statement of its own so it is read after any lock the caller just took. */
async function dbNowMs(x: Exec): Promise<number> {
  return Math.floor(Number(rowsOf<{ t: number }>(await x.execute(sql`select ${NOW_MS} as t`))[0].t));
}
const rulesOf = (raw: unknown, kind: 'live' | 'timed' = 'live') => resolveRules(raw, envRuleDefaults(), kind);
const isUniqueViolation = (e: unknown): boolean => {
  const code = (x: unknown) => (x && typeof x === 'object' && 'code' in x ? (x as { code?: string }).code : undefined);
  return code(e) === '23505' || code((e as { cause?: unknown } | null)?.cause) === '23505';
};

async function emit(x: Exec, showId: string, events: { kind: EventKind; payload: Record<string, unknown>; at: Date }[]): Promise<void> {
  if (events.length === 0) return;
  await x.insert(showEvents).values(events.map((e) => ({ showId, kind: e.kind, payload: e.payload, createdAt: e.at })));
}

const reject = (code: ErrorCode, reason: string, minNext?: bigint): PlaceBidResult =>
  minNext === undefined ? { ok: false, code, reason } : { ok: false, code, reason, minNext: minNext.toString() };

// ---------------------------------------------------------------------------------------------
// Closing a lot: outcome, events and, for a sold lot, the settlement row, in the caller's transaction
// ---------------------------------------------------------------------------------------------

/**
 * The sale half of a close, shared by the timer and Buy Now: the public `lot.sold` event and, for an on-chain show, the
 * settlements row (rail 'cosign', awaiting_payment, attempt 1, due_at = closedAt + settlement window) in the caller's
 * transaction, so "sold" and "to be settled" cannot come apart. Royalty is 0: only the chain layer knows the asset's
 * royalty rule. The bid log hash covers every row in `bids`, so call it after the last bid row is inserted.
 */
async function recordSale(x: Exec, lot: { id: string; lotNumber: number; sellerId: string; mintAddress: string; highBid: bigint; highBidderId: string | null }, show: ShowRow, closedAt: Date): Promise<string | null> {
  const base = { lotId: lot.id, lotNumber: lot.lotNumber };
  const [pad] = lot.highBidderId
    ? await x.select({ n: paddles.number }).from(paddles).where(and(eq(paddles.showId, show.id), eq(paddles.profileId, lot.highBidderId))).limit(1)
    : [];
  const events: { kind: EventKind; payload: Record<string, unknown>; at: Date }[] = [
    { kind: 'lot.sold', payload: { ...base, highBid: lot.highBid.toString(), paddle: pad?.n ?? null }, at: closedAt },
  ];
  let settlementId: string | null = null;
  if (show.settlementMode === 'onchain' && lot.highBidderId) {
    const logged = await x.select({ id: bids.id, message: bids.message, signature: bids.signature, placedAt: bids.placedAt }).from(bids).where(eq(bids.lotId, lot.id));
    const hash = bidLogHash(logged);
    const id = randomUUID();
    const split = splitGross(lot.highBid, platformFeeBps());
    const dueAt = new Date(closedAt.getTime() + rulesOf(show.rules, kindOf(show.kind)).settlementWindowS * 1000);
    const inserted = await x
      .insert(settlements)
      .values({
        id,
        lotId: lot.id,
        buyerId: lot.highBidderId,
        sellerId: lot.sellerId,
        grossAmount: lot.highBid,
        platformFee: split.platform,
        sellerAmount: split.seller,
        royaltyAmount: split.royalty,
        status: 'awaiting_payment',
        rail: 'cosign',
        cluster: show.cluster,
        mintAddress: lot.mintAddress,
        attempt: 1,
        dueAt,
        bidLogHash: hash,
        memo: settlementMemo(id, hash),
        railState: { v: 1, bidLogHash: hash, rounds: [] },
      })
      .onConflictDoNothing()
      .returning({ id: settlements.id });
    if (inserted.length) {
      settlementId = id;
      events.push({ kind: 'settlement.awaiting', payload: { ...base, settlementId: id, gross: lot.highBid.toString(), dueAt: dueAt.toISOString() }, at: closedAt });
    }
  }
  await emit(x, show.id, events);
  return settlementId;
}

/**
 * Precondition: `lot` was read FOR UPDATE in this transaction, is 'open' and has a `closesAt`. The outcome is derived from
 * the high bid against the reserve (never asked for). `closed_at` is the deadline, not the moment someone noticed.
 */
async function closeDueLot(x: Exec, lot: LotRow, show: ShowRow): Promise<'sold' | 'passed' | null> {
  const closedAt = lot.closesAt;
  if (!closedAt) return null;
  const outcome = outcomeAtClose({ highBid: lot.highBid, reserve: lot.reserve });
  const updated = await x.update(lots).set({ state: outcome, closedAt, closedReason: 'timer' }).where(and(eq(lots.id, lot.id), eq(lots.state, 'open'))).returning({ id: lots.id });
  if (updated.length === 0) return null; // someone else closed it first
  if (outcome === 'passed') await emit(x, show.id, [{ kind: 'lot.passed', payload: { lotId: lot.id, lotNumber: lot.lotNumber, highBid: lot.highBid?.toString() ?? null }, at: closedAt }]);
  else await recordSale(x, { ...lot, highBid: lot.highBid as bigint }, show, closedAt);
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// advanceShow
// ---------------------------------------------------------------------------------------------

/** Raw `execute` rows skip drizzle's column decoders (timestamps arrive as strings), so every time is selected as epoch milliseconds. */
interface TickRow {
  status: ShowRow['status'];
  mode: string;
  settlementMode: string;
  scheduledAt: number | null;
  rules: unknown;
  nowMs: number;
  openId: string | null;
  openClosesAt: number | null;
  openable: number;
  lastClosedAt: number | null;
  kind: string;
  /** ms epoch of the pause in effect (null = running). */
  pausedAt: number | null;
  /** Drawn-order gate inputs (all null for a catalogue show: the join is skipped for it). */
  orderMode: string;
  vrfStatus: string | null;
  vrfRevealByMs: number | null;
}

/**
 * One query, bounded by the show id: the show, its open lot, how many lots are ready to open, and the last close. A show with a drawn
 * lot order (order_mode 'vrf') also reads its draw's status and reveal deadline through a LEFT JOIN that is skipped for every other show,
 * so a catalogue show costs exactly what it did before. Nothing here touches the chain: the draw itself is advanced elsewhere.
 */
async function readTickState(x: Exec, showId: string, now?: Date): Promise<TickRow | null> {
  const nowExpr = now ? sql`${now.getTime()}::float8` : sql`(extract(epoch from clock_timestamp()) * 1000)::float8`;
  const res = await x.execute(sql`
    select s.status, s.mode, s.settlement_mode as "settlementMode", (extract(epoch from s.scheduled_at) * 1000)::float8 as "scheduledAt", s.rules, s.kind, s.order_mode as "orderMode",
           (extract(epoch from s.paused_at) * 1000)::float8 as "pausedAt",
           vr.status as "vrfStatus", (extract(epoch from vr.reveal_by) * 1000)::float8 as "vrfRevealByMs",
           ${nowExpr} as "nowMs", ol.id as "openId", (extract(epoch from ol.closes_at) * 1000)::float8 as "openClosesAt",
           (select count(*)::int from lots c where c.show_id = s.id and c.state = 'catalogued' and c.consign_status = 'ready') as openable,
           (select (extract(epoch from max(z.closed_at)) * 1000)::float8 from lots z where z.show_id = s.id) as "lastClosedAt"
    from shows s
    left join lateral (select id, closes_at from lots where show_id = s.id and state = 'open' limit 1) ol on true
    left join vrf_requests vr on s.order_mode = 'vrf' and vr.purpose = 'lot_order' and vr.subject_type = 'show' and vr.subject_id = s.id::text
    where s.id = ${showId}`);
  const row = rowsOf<TickRow>(res)[0];
  if (!row) return null;
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    ...row, nowMs: Number(row.nowMs), pausedAt: num(row.pausedAt), scheduledAt: num(row.scheduledAt), openClosesAt: num(row.openClosesAt), lastClosedAt: num(row.lastClosedAt), vrfRevealByMs: num(row.vrfRevealByMs),
    rules: typeof row.rules === 'string' ? JSON.parse(row.rules) : row.rules,
  };
}

const kindOf = (k: string): 'live' | 'timed' => (k === 'timed' ? 'timed' : 'live');

const tickActions = (r: TickRow): TickAction[] =>
  decideTick({
    now: Math.floor(r.nowMs),
    show: { status: r.status, scheduledAt: r.scheduledAt, rules: rulesOf(r.rules, kindOf(r.kind)), pausedAt: r.pausedAt },
    openLot: r.openId ? { id: r.openId, closesAt: r.openClosesAt } : null,
    openableLots: r.openable,
    lastClosedAt: r.lastClosedAt,
    orderGate: orderGateOf({ orderMode: r.orderMode, requestStatus: r.vrfStatus, revealByMs: r.vrfRevealByMs, nowMs: Math.floor(r.nowMs) }),
  });

/** Ends the show and withdraws lots that never opened, so no ended show keeps a "queued" lot. */
async function endShowTx(x: Exec, show: ShowRow, at: Date, extra: { cancelled?: boolean } = {}): Promise<void> {
  await x.update(shows).set({ status: 'ended', endedAt: at, ...(extra.cancelled ? { cancelledAt: at } : {}) }).where(eq(shows.id, show.id));
  const left = await x
    .update(lots)
    .set({ state: 'withdrawn', closedAt: at, closedReason: extra.cancelled ? 'cancelled' : 'show_ended' })
    .where(and(eq(lots.showId, show.id), eq(lots.state, 'catalogued')))
    .returning({ id: lots.id, lotNumber: lots.lotNumber });
  await emit(x, show.id, [
    ...left.sort((a, b) => a.lotNumber - b.lotNumber).map((l) => ({ kind: 'lot.withdrawn' as const, payload: { lotId: l.id, lotNumber: l.lotNumber }, at })),
    { kind: 'show.ended', payload: {}, at },
  ]);
}

/**
 * The drawn lot order missed its reveal deadline: mark the draw defaulted (a pure database update, no chain I/O) and record the order that
 * applies, the catalogue order. A reveal that arrives later is not accepted (the draw is no longer pending or committed), so the operator
 * cannot pick between the two orders after seeing both.
 */
async function defaultLotOrder(x: Exec, showId: string, at: Date): Promise<void> {
  const order = (await x.select({ id: lots.id }).from(lots).where(eq(lots.showId, showId)).orderBy(asc(lots.lotNumber))).map((l) => l.id);
  await x.execute(sql`
    update vrf_requests set status = 'defaulted', defaulted_at = ${at.toISOString()}::timestamptz, result = ${JSON.stringify({ order, applied: false })}::jsonb
    where purpose = 'lot_order' and subject_type = 'show' and subject_id = ${showId} and status in ('pending', 'committed')`);
}

/**
 * The resume half of the seller's pause, shared by the seller's resume, the lazy auto-resume and "end show": in the caller's transaction, with the
 * SHOW row locked (lock order is always show, then lot). The open lot's deadline moves by the paused time (`resumeShift`: a pause counts as at most
 * its limit long, so a resume noticed late still gives bidders exactly the time they had), `lots.paused_ms` records it, the pause is cleared and the
 * public `show.resumed` event says so. No bid log row is touched: bids are only ever inserted while the room runs.
 */
async function applyResume(x: Exec, show: ShowRow, now: Date, auto: boolean, by: { wallet: string | null; role: 'seller' | 'operator' | 'timer' | 'end_show' } = { wallet: null, role: 'timer' }): Promise<void> {
  if (!show.pausedAt) return;
  const { resumedAt, shiftMs } = resumeShift({ pausedAt: show.pausedAt.getTime(), now: now.getTime() });
  const [lot] = await x.select().from(lots).where(and(eq(lots.showId, show.id), eq(lots.state, 'open'))).for('no key update');
  let closesAt: Date | null = null;
  if (lot?.closesAt) {
    closesAt = new Date(lot.closesAt.getTime() + shiftMs);
    await x.update(lots).set({ closesAt, pausedMs: sql`${lots.pausedMs} + ${shiftMs}` }).where(eq(lots.id, lot.id));
  }
  await x.update(shows).set({ pausedAt: null }).where(eq(shows.id, show.id));
  // The audit trail keeps who resumed (the wallet is never public: the feed event carries no wallet); the public event is the one every bidder sees.
  await x.insert(auditLogs).values({ action: 'show.resume', actorWallet: by.wallet, target: show.id, detail: { by: by.role, auto, shiftedMs: shiftMs, lotId: lot?.id ?? null } });
  await emit(x, show.id, [{ kind: 'show.resumed', payload: { lotId: lot?.id ?? null, lotNumber: lot?.lotNumber ?? null, closesAt: closesAt?.toISOString() ?? null, shiftedMs: shiftMs, auto }, at: new Date(auto ? resumedAt : now.getTime()) }]);
}

async function advanceShow(showId: string, now?: Date): Promise<AdvanceResult> {
  const result: AdvanceResult = { showId, wentLive: false, closed: 0, opened: 0, ended: false };
  if (!isValidUuid(showId)) return result;

  // Cheap path: no lock, one query. Nothing due means nothing else happens.
  const peek = await readTickState(db as unknown as Exec, showId, now);
  if (!peek || !isManaged(peek) || tickActions(peek).length === 0) return result;

  try {
    const done = await db.transaction(async (tx) => {
      const x = tx as unknown as Exec;
      const [show] = await x.select().from(shows).where(eq(shows.id, showId)).for('no key update'); // serialises advancers
      if (!show || !isManaged(show)) return result;
      const st = await readTickState(x, showId, now); // re-read after the lock: another advancer may have done the work
      if (!st) return result;
      const nowMs = Math.floor(st.nowMs);
      const at = new Date(nowMs);
      const rules = rulesOf(st.rules, kindOf(st.kind));
      for (const a of tickActions(st)) {
        if (a.type === 'go_live') {
          await x.update(shows).set({ status: 'live', startedAt: at }).where(and(eq(shows.id, showId), eq(shows.status, 'scheduled')));
          await emit(x, showId, [{ kind: 'show.live', payload: {}, at }]);
          result.wentLive = true;
        } else if (a.type === 'resume') {
          await applyResume(x, show, at, true); // the pause reached its limit
        } else if (a.type === 'default_order') {
          await defaultLotOrder(x, showId, at);
        } else if (a.type === 'close_lot') {
          const [lot] = await x.select().from(lots).where(and(eq(lots.id, a.lotId), eq(lots.state, 'open'))).for('no key update');
          if (lot?.closesAt && lot.closesAt.getTime() <= nowMs && (await closeDueLot(x, lot, show))) result.closed++;
        } else if (a.type === 'open_next') {
          const [next] = await x
            .select()
            .from(lots)
            .where(and(eq(lots.showId, showId), eq(lots.state, 'catalogued'), eq(lots.consignStatus, 'ready')))
            .orderBy(asc(lots.lotNumber))
            .limit(1)
            .for('no key update');
          if (next) {
            const closesAt = new Date(nowMs + rules.lotDurationS * 1000);
            await x.update(lots).set({ state: 'open', openedAt: at, closesAt }).where(and(eq(lots.id, next.id), eq(lots.state, 'catalogued')));
            await emit(x, showId, [{ kind: 'lot.opened', payload: { lotId: next.id, lotNumber: next.lotNumber, closesAt: closesAt.toISOString() }, at }]);
            result.opened++;
          }
        } else if (a.type === 'end_show') {
          await endShowTx(x, show, at);
          result.ended = true;
        }
      }
      return result;
    });
    if (done.wentLive || done.closed > 0 || done.opened > 0 || done.ended) telegramHooks.showAdvanced(showId, { wentLive: done.wentLive, closed: done.closed > 0, opened: done.opened > 0, ended: done.ended }); // Telegram: never throws, runs after the response
    return done;
  } catch (e) {
    // The database refused a second open lot (a legacy route raced us): nothing was applied, the next read retries.
    if (isUniqueViolation(e)) return { showId, wentLive: false, closed: 0, opened: 0, ended: false };
    throw e;
  }
}

/** Shows that may have work: live, due to start, or ended with a lot still running. One indexed query. */
async function dueShowIds(now: Date | undefined, limit: number): Promise<string[]> {
  const nowExpr = now ? sql`${now.toISOString()}::timestamptz` : sql`clock_timestamp()`;
  const res = await db.execute(sql`
    select s.id from shows s
    where s.settlement_mode = 'onchain' and s.mode = 'auto'
      and (s.status = 'live'
        or (s.status = 'scheduled' and s.scheduled_at is not null and s.scheduled_at <= ${nowExpr})
        or (s.status = 'ended' and exists (select 1 from lots l where l.show_id = s.id and l.state = 'open')))
    order by s.created_at desc limit ${limit}`);
  return rowsOf<{ id: string }>(res).map((r) => r.id);
}

async function sweep(now?: Date): Promise<{ advanced: number; expired: number }> {
  let advanced = 0;
  for (const id of await dueShowIds(now, 500)) {
    const r = await advanceShow(id, now);
    if (r.wentLive || r.closed || r.opened || r.ended) advanced++;
  }
  // Known limit: settlement expiry (strikes need the signing-round history) belongs to CHAIN's expireDue, so `expired` is 0 here.
  return { advanced, expired: 0 };
}

async function getLiveSnapshot(showId: string): Promise<LiveSnapshot | null> {
  if (!isValidUuid(showId)) return null;
  await advanceShow(showId); // lazy: a read is what closes a lot that nobody bid on
  return buildSnapshot(showId);
}

// ---------------------------------------------------------------------------------------------
// Funds and bids
// ---------------------------------------------------------------------------------------------

/** High bids on other open lots plus unpaid settlements. The caller subtracts this from the chain balance. */
async function commitments(x: Exec, profileId: string, excludeLotId?: string): Promise<bigint> {
  const excl = excludeLotId ? sql`and id <> ${excludeLotId}` : sql``;
  const res = await x.execute(sql`
    select (
      coalesce((select sum(high_bid) from lots where high_bidder_id = ${profileId} and state = 'open' ${excl}), 0)
      + coalesce((select sum(gross_amount) from settlements where buyer_id = ${profileId} and status in ('awaiting_payment', 'submitted')), 0)
    )::text as total`);
  return BigInt(rowsOf<{ total: string }>(res)[0]?.total ?? '0');
}

type BidTx =
  | { done: PlaceBidResult; showId?: undefined; closedLotId?: string; resumeShowId?: string }
  | { done: 'ok'; showId: string; bidId: string; belowReserve: boolean; closesAt: number; extended: boolean; lotId: string; lotName: string; previousBidderId: string | null };

/** The lot's effective opening time for the extension cap: the clock the lot has actually run (its pauses do not count). */
const effectiveOpenedAt = (lot: Pick<LotRow, 'openedAt' | 'pausedMs'>): number | null => (lot.openedAt ? lot.openedAt.getTime() + Number(lot.pausedMs) : null);

/** The pause in effect, read in a statement of its own (after the lot lock), so a pause that committed while we waited for the lock is seen. ms epoch or null. */
const PAUSED_AT = (showId: string) => sql<number | null>`(select (extract(epoch from paused_at) * 1000)::float8 from shows where id = ${showId})`;

async function placeBid(input: PlaceBidInput, retried = false): Promise<PlaceBidResult> {
  if (!isValidUuid(input.lotId)) return reject('not_found', 'Lot not found.');
  const out = await db.transaction(async (tx): Promise<BidTx> => {
    const x = tx as unknown as Exec;
    const lotSeller = alias(profiles, 'lot_seller');
    const showSeller = alias(profiles, 'show_seller');
    // The lock. Everything after it (clock, deadline, funds, insert) happens while we hold the lot.
    const [row] = await x
      .select({ lot: lots, show: shows, lotSellerWallet: lotSeller.walletAddress, showSellerWallet: showSeller.walletAddress })
      .from(lots)
      .innerJoin(shows, eq(shows.id, lots.showId))
      .innerJoin(lotSeller, eq(lotSeller.id, lots.sellerId))
      .innerJoin(showSeller, eq(showSeller.id, shows.sellerId))
      .where(eq(lots.id, input.lotId))
      .for('no key update', { of: lots });
    if (!row) return { done: reject('not_found', 'Lot not found.') };
    const { lot, show } = row;

    // The clock is read in a statement of its own, after the lock was granted. (Selecting clock_timestamp() in the locking
    // query does NOT work: Postgres evaluates it before it waits for the lock, so a bid that queued past the deadline
    // would be judged on the time it queued. The "deadline clock is read after the lock" test pins this.)
    const [b] = await x
      .select({ profile: profiles, paddle: paddles, nowMs: NOW_MS, pausedAt: PAUSED_AT(show.id) })
      .from(profiles)
      .leftJoin(paddles, and(eq(paddles.showId, show.id), eq(paddles.profileId, profiles.id)))
      .where(eq(profiles.id, input.bidderProfileId));
    if (!b || b.profile.walletAddress !== input.bidderWallet) return { done: reject('forbidden', 'Unknown bidder.') };
    const nowMs = input.now ? input.now.getTime() : Number(b.nowMs);
    const pausedAt = b.pausedAt === null || b.pausedAt === undefined ? null : Number(b.pausedAt);

    // The seller's pause. Its limit may have passed without anyone resuming yet: then the resume is applied (outside this transaction, which holds only the
    // lot lock and must not take the show lock) and the bid is tried once more. A pause still in force is refused by decideBid below.
    if (pausedAt !== null && lot.state === 'open' && pauseExpired(pausedAt, nowMs)) return { done: reject('show_paused', 'The seller paused the room. Bidding resumes with the same time left.'), resumeShowId: show.id };

    // Lazy close: a bid that arrives after the deadline closes the lot (and creates the settlement) instead of being accepted. A paused clock never closes.
    if (pausedAt === null && lot.state === 'open' && lot.closesAt && nowMs >= lot.closesAt.getTime()) {
      await closeDueLot(x, lot, show);
      return { done: reject('lot_closed', 'Bidding on this lot is closed.'), closedLotId: lot.id };
    }

    const paddle = b.paddle && (input.paddleId === null || input.paddleId === b.paddle.id) ? b.paddle : null;

    const committed = await commitments(x, b.profile.id, lot.id);
    const available = input.fundsBalance > committed ? input.fundsBalance - committed : 0n;

    const decision = decideBid({
      lot: {
        state: lot.state, highBid: lot.highBid, highBidderId: lot.highBidderId, openingPrice: lot.openingPrice, increment: lot.increment, reserve: lot.reserve,
        closesAt: lot.closesAt?.getTime() ?? null, openedAt: effectiveOpenedAt(lot), sellerProfileId: lot.sellerId, sellerWallet: row.lotSellerWallet,
      },
      show: { status: show.status, rules: rulesOf(show.rules, kindOf(show.kind)), isHouse: show.isHouse, sellerProfileId: show.sellerId, sellerWallet: row.showSellerWallet, pausedAt },
      bidder: { profileId: b.profile.id, wallet: b.profile.walletAddress, isBanned: b.profile.isBanned, isBot: b.profile.isBot },
      paddle: paddle ? { number: paddle.number, validUntil: paddle.validUntil.getTime(), revoked: paddle.revokedAt !== null, maxBid: paddle.maxBid } : null,
      via: input.via,
      amount: input.amount,
      nowMs,
      available,
    });
    if (!decision.ok) return { done: reject(decision.code, decision.reason, decision.minNext) };

    const [bid] = await x
      .insert(bids)
      .values({
        lotId: lot.id, bidderId: b.profile.id, amount: input.amount, signature: input.signature, message: input.message, nonce: input.nonce,
        via: input.via, paddleId: paddle!.id, fundedAmount: input.fundsBalance, placedAt: input.now ?? sql`clock_timestamp()`,
      })
      .onConflictDoNothing({ target: [bids.bidderId, bids.nonce] })
      .returning({ id: bids.id });
    if (!bid) return { done: reject('replay', 'This bid was already submitted.') };

    const closesAt = new Date(decision.closesAt);
    await x
      .update(lots)
      .set({ highBid: input.amount, highBidderId: b.profile.id, bidCount: sql`${lots.bidCount} + 1`, closesAt })
      .where(eq(lots.id, lot.id));
    const at = new Date(Math.floor(nowMs));
    const base = { lotId: lot.id, lotNumber: lot.lotNumber };
    await emit(x, show.id, [
      { kind: 'bid.placed', payload: { ...base, amount: input.amount.toString(), paddle: paddle!.number, belowReserve: decision.belowReserve }, at },
      ...(decision.extended ? [{ kind: 'lot.extended' as const, payload: { ...base, closesAt: closesAt.toISOString() }, at }] : []),
    ]);
    return { done: 'ok', showId: show.id, bidId: bid.id, belowReserve: decision.belowReserve, closesAt: decision.closesAt, extended: decision.extended, lotId: lot.id, lotName: lot.name, previousBidderId: lot.highBidderId };
  });

  if (out.done !== 'ok') {
    if (out.resumeShowId && !retried) {
      await advanceShow(out.resumeShowId); // the pause reached its limit: resume now (the lazy timer), then bid on the running room
      return placeBid(input, true);
    }
    if (out.closedLotId) telegramHooks.lotClosed(out.closedLotId); // the late bid closed the lot: the winner hears it (never throws, runs after the response)
    return out.done;
  }
  telegramHooks.bidPlaced({
    bidId: out.bidId, lotId: out.lotId, lotName: out.lotName, showId: out.showId, amount: input.amount, highBid: input.amount,
    previousBidderId: out.previousBidderId, bidderId: input.bidderProfileId, closesAt: new Date(out.closesAt),
  });
  const live = await buildSnapshot(out.showId);
  if (!live) return reject('not_found', 'Show not found.');
  return { ok: true, bidId: out.bidId, belowReserve: out.belowReserve, closesAt: new Date(out.closesAt).toISOString(), extended: out.extended, live };
}

async function commitmentsFor(profileId: string, excludeLotId?: string): Promise<bigint> {
  if (!isValidUuid(profileId) || (excludeLotId !== undefined && !isValidUuid(excludeLotId))) return 0n;
  return commitments(db as unknown as Exec, profileId, excludeLotId);
}

async function registerPaddle(i: Parameters<AuctionService['registerPaddle']>[0]): Promise<Paddle> {
  if (!isValidUuid(i.showId) || !isValidUuid(i.profileId)) throw new ApiError('not_found', 'Show not found.');
  if (i.validUntil.getTime() <= Date.now()) throw new ApiError('validation', 'The paddle validity must be in the future.');
  if (i.maxBid !== null && (i.maxBid <= 0n || i.maxBid > MAX_BID)) throw new ApiError('validation', 'The paddle maximum is out of range.');
  const [show] = await db.select({ status: shows.status }).from(shows).where(eq(shows.id, i.showId));
  if (!show) throw new ApiError('not_found', 'Show not found.');
  if (show.status === 'ended') throw new ApiError('show_ended', 'This show has ended.');
  const fields = { sessionPubkey: i.sessionPubkey, maxBid: i.maxBid, validUntil: i.validUntil, authMessage: i.authMessage, authSignature: i.authSignature };
  // The next number is computed inside the insert; two registrations racing for the same number hit paddles_show_number_idx and retry.
  // Every lost round means another registration won it, so n concurrent registrations need at most n rounds: 40 covers a full room joining at once.
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const [p] = await db
        .insert(paddles)
        .values({ showId: i.showId, profileId: i.profileId, number: sql`(select coalesce(max(number), 0) + 1 from paddles where show_id = ${i.showId})`, ...fields })
        .onConflictDoUpdate({ target: [paddles.showId, paddles.profileId], set: { ...fields, revokedAt: null } })
        .returning();
      return { id: p.id, number: p.number, validUntil: p.validUntil.toISOString(), revokedAt: p.revokedAt?.toISOString() ?? null };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  throw new ApiError('rate_limited', 'Too many registrations at once, try again.');
}

// ---------------------------------------------------------------------------------------------
// Buy Now (P1): the same way of winning a lot, at a fixed price
// ---------------------------------------------------------------------------------------------

/**
 * A signed Buy Now intent wins the lot at `buy_now_price` while it is open and nobody has bid that high. It is recorded as
 * an accepted bid (so it is in the signed bid log and replay-proof) and then sold through the same `recordSale` as a timed
 * close. The shared guards (banned, house bots, paddle, seller-linked, deadline, funds) are `decideBid` itself, asked about
 * the Buy Now price with the lot's current bid masked out: whether the price is still above the high bid is checked here.
 */
async function buyNow(i: Parameters<AuctionService['buyNow']>[0], retried = false): Promise<{ settlementId: string }> {
  if (!isValidUuid(i.lotId)) throw new ApiError('not_found', 'Lot not found.');
  const out = await db.transaction(async (tx): Promise<{ settlementId: string } | 'closed' | 'resume'> => {
    const x = tx as unknown as Exec;
    const lotSeller = alias(profiles, 'lot_seller');
    const showSeller = alias(profiles, 'show_seller');
    const [row] = await x
      .select({ lot: lots, show: shows, lotSellerWallet: lotSeller.walletAddress, showSellerWallet: showSeller.walletAddress })
      .from(lots)
      .innerJoin(shows, eq(shows.id, lots.showId))
      .innerJoin(lotSeller, eq(lotSeller.id, lots.sellerId))
      .innerJoin(showSeller, eq(showSeller.id, shows.sellerId))
      .where(eq(lots.id, i.lotId))
      .for('no key update', { of: lots });
    if (!row) throw new ApiError('not_found', 'Lot not found.');
    const { lot, show } = row;
    const [b] = await x
      .select({ profile: profiles, paddle: paddles, nowMs: NOW_MS, pausedAt: PAUSED_AT(show.id) })
      .from(profiles)
      .leftJoin(paddles, and(eq(paddles.showId, show.id), eq(paddles.profileId, profiles.id)))
      .where(eq(profiles.id, i.buyerProfileId));
    if (!b || b.profile.walletAddress !== i.buyerWallet) throw new ApiError('forbidden', 'Unknown buyer.');
    const nowMs = Math.floor(Number(b.nowMs));
    const pausedAt = b.pausedAt === null || b.pausedAt === undefined ? null : Number(b.pausedAt);
    // A paused room sells nothing (Buy Now is a bid). A pause past its limit is resumed first (outside this transaction, see placeBid) and the purchase retried once.
    if (pausedAt !== null && lot.state === 'open' && pauseExpired(pausedAt, nowMs)) return 'resume';
    if (pausedAt !== null && lot.state === 'open') throw new ApiError('show_paused', 'The seller paused the room. Bidding resumes with the same time left.');

    if (lot.state === 'open' && lot.closesAt && nowMs >= lot.closesAt.getTime()) {
      await closeDueLot(x, lot, show);
      return 'closed';
    }
    const price = lot.buyNowPrice;
    if (price === null || show.settlementMode !== 'onchain') throw new ApiError('not_buyable', 'This lot has no Buy Now price.');
    if (i.amount !== price) throw new ApiError('validation', 'The amount must equal the Buy Now price.');
    if (lot.state === 'open' && lot.highBid !== null && lot.highBid >= price) throw new ApiError('not_buyable', 'The bidding has reached the Buy Now price.');

    const committed = await commitments(x, b.profile.id, lot.id);
    const decision = decideBid({
      lot: {
        state: lot.state, highBid: null, highBidderId: null, openingPrice: 1n, increment: 1n, reserve: lot.reserve,
        closesAt: lot.closesAt?.getTime() ?? null, openedAt: effectiveOpenedAt(lot), sellerProfileId: lot.sellerId, sellerWallet: row.lotSellerWallet,
      },
      show: { status: show.status, rules: rulesOf(show.rules, kindOf(show.kind)), isHouse: show.isHouse, sellerProfileId: show.sellerId, sellerWallet: row.showSellerWallet, pausedAt },
      bidder: { profileId: b.profile.id, wallet: b.profile.walletAddress, isBanned: b.profile.isBanned, isBot: b.profile.isBot },
      paddle: b.paddle ? { number: b.paddle.number, validUntil: b.paddle.validUntil.getTime(), revoked: b.paddle.revokedAt !== null, maxBid: b.paddle.maxBid } : null,
      via: 'wallet',
      amount: price,
      nowMs,
      available: i.fundsBalance > committed ? i.fundsBalance - committed : 0n,
    });
    if (!decision.ok) throw new ApiError(decision.code, decision.reason);

    const at = new Date(nowMs);
    const [bid] = await x
      .insert(bids)
      .values({ lotId: lot.id, bidderId: b.profile.id, amount: price, signature: i.signature, message: i.message, nonce: i.nonce, via: 'wallet', paddleId: b.paddle!.id, fundedAmount: i.fundsBalance, placedAt: sql`clock_timestamp()` })
      .onConflictDoNothing({ target: [bids.bidderId, bids.nonce] })
      .returning({ id: bids.id });
    if (!bid) throw new ApiError('replay', 'This purchase was already submitted.');
    // closes_at = closed_at = now keeps the invariant that a closed lot's deadline is when it closed (and the settlement window counts from here).
    await x.update(lots).set({ state: 'sold', highBid: price, highBidderId: b.profile.id, bidCount: sql`${lots.bidCount} + 1`, closesAt: at, closedAt: at, closedReason: 'buy_now' }).where(eq(lots.id, lot.id));
    await emit(x, show.id, [{ kind: 'bid.placed', payload: { lotId: lot.id, lotNumber: lot.lotNumber, amount: price.toString(), paddle: b.paddle!.number, belowReserve: lot.reserve !== null && price < lot.reserve }, at }]);
    const settlementId = await recordSale(x, { ...lot, highBid: price, highBidderId: b.profile.id }, show, at);
    if (!settlementId) throw new ApiError('wrong_state', 'The sale could not be recorded.');
    return { settlementId };
  });
  if (out === 'resume') {
    if (retried) throw new ApiError('show_paused', 'The seller paused the room. Bidding resumes with the same time left.');
    const [l] = await db.select({ showId: lots.showId }).from(lots).where(eq(lots.id, i.lotId));
    if (l?.showId) await advanceShow(l.showId);
    return buyNow(i, true);
  }
  if (out === 'closed') throw new ApiError('lot_closed', 'Bidding on this lot is closed.');
  telegramHooks.saleCreated(out.settlementId);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Catalogue and lists
// ---------------------------------------------------------------------------------------------

async function getCatalogue(showId: string): Promise<ShowDetail | null> {
  if (!isValidUuid(showId)) return null;
  const [found] = await db.select({ show: shows, sellerName: profiles.displayName }).from(shows).leftJoin(profiles, eq(profiles.id, shows.sellerId)).where(eq(shows.id, showId));
  if (!found) return null;
  const { show } = found;
  const rows = await db.select().from(lots).where(eq(lots.showId, showId)).orderBy(asc(lots.lotNumber));
  return { show: toShowCore(show, await videoEnabledFor(show), found.sellerName), lots: rows.map(toCatalogueLot) };
}

// One second of sharing on a server (the CDN keeps a list for five); none under test, where a list read right after a show became due must advance it.
const advancingForList = createMemo<void>(process.env.NODE_ENV === 'test' ? 0 : 1_000);

async function listShows(q: ListShowsQuery): Promise<ShowList> {
  const limit = Math.min(50, Math.max(1, Math.floor(q.limit)));
  const offset = /^o\d{1,6}$/.test(q.cursor ?? '') ? Number(q.cursor!.slice(1)) : 0;
  // Reading the list is what turns a due show live: advance the shows that may have work first. Lists that arrive together (the schedule page asks for four)
  // share one run, so a due show is advanced at most a second after it became due.
  if (q.status !== 'ended') await advancingForList.get('due', async () => { await Promise.all((await dueShowIds(undefined, 20)).map((id) => advanceShow(id))); });
  // The page of shows is picked first (filters, order, limit), and only then are the lots of THOSE shows counted: the work is bounded by the page, not by every
  // show and lot ever created (the house room adds a show every ten minutes it is watched). The order is written once for the inner and the outer select.
  const orderOf = (c: { isHouse: SQLWrapper; status: SQLWrapper; kind: SQLWrapper; scheduledAt: SQLWrapper; startedAt: SQLWrapper; endedAt: SQLWrapper; createdAt: SQLWrapper }) => {
    // The demo (house) room is pinned first among what is live or coming up, live-kind before timed; then live seller rooms, upcoming, ended.
    const pinned = sql`case when ${c.isHouse} and ${c.status} <> 'ended' then 0 else 1 end`;
    const liveFirst = sql`case when ${c.kind} = 'live' then 0 else 1 end`;
    return q.status === 'scheduled' ? [pinned, liveFirst, sql`${c.scheduledAt} asc nulls last`, sql`${c.createdAt} desc`]
      : q.status === 'live' ? [pinned, liveFirst, sql`${c.startedAt} desc`, sql`${c.createdAt} desc`]
        : q.status === 'ended' ? [sql`coalesce(${c.endedAt}, ${c.startedAt}, ${c.createdAt}) desc`]
          : [pinned, liveFirst, sql`case ${c.status} when 'live' then 0 when 'scheduled' then 1 else 2 end`, sql`${c.createdAt} desc`];
  };
  // Seed data is owned by a profile no wallet can be: it is never a room a person made, so the public list leaves it out (with the legacy practice show). Nothing is deleted.
  const notSeed = sql`(${shows.isHouse} or (${profiles.walletAddress} is distinct from ${SEED_SELLER_WALLET} and ${shows.id} <> ${DEMO_SHOW_ID}))`;
  const picked = db
    .select({
      id: shows.id, title: shows.title, status: shows.status, scheduledAt: shows.scheduledAt, startedAt: shows.startedAt, endedAt: shows.endedAt, createdAt: shows.createdAt, cluster: shows.cluster, isHouse: shows.isHouse, kind: shows.kind,
    })
    .from(shows)
    .leftJoin(profiles, eq(profiles.id, shows.sellerId))
    .where(and(q.status ? eq(shows.status, q.status) : undefined, q.kind ? eq(shows.kind, q.kind) : undefined, q.house ? eq(shows.isHouse, q.house === 'only') : undefined, notSeed))
    .orderBy(...orderOf(shows), desc(shows.id))
    .limit(limit + 1)
    .offset(offset)
    .as('picked');
  const counts = db
    .select({
      lotCount: sql<number>`count(${lots.id})::int`.as('lot_count'),
      soldCount: sql<number>`(count(${lots.id}) filter (where ${lots.state} = 'sold'))::int`.as('sold_count'),
      hammerTotal: sql<string>`coalesce(sum(${lots.highBid}) filter (where ${lots.state} = 'sold'), 0)::text`.as('hammer_total'),
      thumbs: sql<string[]>`coalesce((array_agg(${lots.imageUrl} order by ${lots.lotNumber}) filter (where ${lots.imageUrl} is not null))[1:4], '{}')`.as('thumbs'),
      // The deadline of the lot on the block (a timed show's "ends in"); the one open lot per show is a database guarantee.
      closesAt: sql<string | null>`(array_agg(to_char(${lots.closesAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) filter (where ${lots.state} = 'open' and ${lots.closesAt} is not null))[1]`.as('closes_at'),
    })
    .from(lots)
    .where(eq(lots.showId, picked.id))
    .as('counts');
  const rows = await db
    .select({
      id: picked.id, title: picked.title, status: picked.status, scheduledAt: picked.scheduledAt, startedAt: picked.startedAt, endedAt: picked.endedAt, cluster: picked.cluster, isHouse: picked.isHouse, kind: picked.kind,
      lotCount: counts.lotCount, soldCount: counts.soldCount, hammerTotal: counts.hammerTotal, thumbs: counts.thumbs, closesAt: counts.closesAt,
    })
    .from(picked)
    .leftJoinLateral(counts, sql`true`)
    .orderBy(...orderOf(picked), desc(picked.id));
  const page: ShowSummary[] = rows.slice(0, limit).map((r) => ({
    id: r.id, title: r.title, status: r.status, scheduledAt: r.scheduledAt?.toISOString() ?? null, startedAt: r.startedAt?.toISOString() ?? null, endedAt: r.endedAt?.toISOString() ?? null,
    lotCount: Number(r.lotCount), soldCount: Number(r.soldCount), hammerTotal: String(r.hammerTotal),
    cluster: r.cluster === 'devnet' || r.cluster === 'mainnet-beta' ? r.cluster : null, isHouse: r.isHouse, thumbs: r.thumbs ?? [], kind: r.kind === 'timed' ? 'timed' : 'live', closesAt: r.closesAt ?? null,
  }));
  // Known limit: offset cursor. A show created while someone pages can shift a row; keyset paging when lists get long.
  return { shows: page, nextCursor: rows.length > limit ? `o${offset + limit}` : null };
}

// ---------------------------------------------------------------------------------------------
// Creating a show
// ---------------------------------------------------------------------------------------------

/** What the catalogue row needs beyond the seller's terms. Optional: replicas fall back to `devnet_assets`. */
export interface AssetMeta {
  name: string;
  imageUrl?: string | null;
  setName?: string | null;
  gradingCompany?: string | null;
  grade?: string | null;
  gradingId?: string | null;
  insuredValue?: bigint | null;
  nftStandard?: string;
}

export type CreateShowInput = CreateShowRequest & {
  sellerProfileId: string;
  readiness: Record<string, AssetReadiness>;
  /** Card facts from the chain or vault read (CHAIN/LIVE). Anything missing falls back to the devnet replica row, then a neutral name. */
  assets?: Record<string, AssetMeta>;
  /** Server-side only: house shows (never from a request body). */
  isHouse?: boolean;
  cluster?: 'devnet' | 'mainnet-beta';
  /** Server-side only: how the lots are ordered ('vrf' is set by the house rollover, never from a request body). Default 'catalogue'. */
  orderMode?: 'catalogue' | 'vrf';
};

const READINESS_CODE: Record<string, ErrorCode> = {
  not_owner: 'not_owner', frozen: 'frozen', unsupported_standard: 'unsupported_standard', not_found: 'not_owner',
  royalty_rules_block_transfer: 'asset_not_ready', foreign_delegate_blocks: 'asset_not_ready', already_listed: 'already_listed',
};

function amount(raw: string | undefined, field: string, min: bigint): bigint | undefined {
  if (raw === undefined) return undefined;
  if (!/^(0|[1-9]\d{0,18})$/.test(raw)) throw new ApiError('validation', `${field} must be a whole number of USDC base units.`);
  const v = BigInt(raw);
  if (v < min || v > MAX_BID) throw new ApiError('validation', `${field} is out of range.`);
  return v;
}

const clusterFromEnv = (): 'devnet' | 'mainnet-beta' => resolveCluster(); // the one switch (SOLANA_CLUSTER); never a second reading of it

/**
 * A timed show (one lot, hours to days) is for now only offered where the sale cannot lapse: the Hammerprice room (the server signs the seller's
 * leg) and operator wallets. A stranger who must sign the seller leg in the same 60 s round as the buyer would lose a day-long win to a missed
 * minute, so it is refused plainly until the durable-nonce settlement exists. Exactly one lot, and no shorter
 * than the minimum (10 minutes; a test environment may lower it, never on mainnet).
 */
async function assertTimedAllowed(i: CreateShowInput): Promise<void> {
  if (i.isHouse !== true) {
    const [p] = await db.select({ wallet: profiles.walletAddress }).from(profiles).where(eq(profiles.id, i.sellerProfileId));
    if (!p || !operatorWallets().includes(p.wallet)) throw new ApiError('feature_off', 'Timed auctions are for now only available in the Hammerprice room.');
  }
  if (i.lots.length !== 1) throw new ApiError('validation', 'A timed auction has exactly one lot.');
  const min = timedMinDurationS();
  if (i.rules?.lotDurationS !== undefined && i.rules.lotDurationS < min) throw new ApiError('validation', `A timed auction runs at least ${Math.ceil(min / 60)} minutes.`);
}

async function createShow(i: CreateShowInput): Promise<ShowDetail> {
  if (!isValidUuid(i.sellerProfileId)) throw new ApiError('forbidden', 'Unknown seller.');
  const kind = i.kind === 'timed' ? 'timed' : 'live';
  if (kind === 'timed' && !(await featureOn('TIMED'))) throw new ApiError('feature_off', 'Timed auctions are not available here.');
  // The seller's video choice counts only where the feature is on; a stored "yes" must not switch itself on later.
  const videoEnabled = i.videoEnabled === true && (await featureOn('VIDEO'));
  if (kind === 'timed') await assertTimedAllowed(i);
  if (i.lots.length < 1 || i.lots.length > 30) throw new ApiError('validation', 'A show needs 1 to 30 lots.');
  if (new Set(i.lots.map((l) => l.mint)).size !== i.lots.length) throw new ApiError('validation', 'The same card appears twice.');

  // Validate everything before opening the transaction: a bad lot must not cost a round trip, and must never leave a half-made show.
  const terms = i.lots.map((l) => {
    const r = i.readiness[l.mint];
    if (!r) throw new ApiError('asset_not_ready', 'The card has not been checked for readiness.');
    if (!r.eligible) throw new ApiError(READINESS_CODE[r.reasons[0]] ?? 'asset_not_ready', 'This card cannot be consigned yet.');
    const reserve = amount(l.reserve, 'reserve', 0n);
    const buyNowPrice = amount(l.buyNowPrice, 'buyNowPrice', 1n);
    const meta = i.assets?.[l.mint];
    const estimate = reserve ?? meta?.insuredValue ?? 1_000_000n;
    return {
      mint: l.mint, reserve, buyNowPrice, meta, description: l.description, aiAssisted: l.aiAssisted === true && l.description != null,
      
      openingPrice: amount(l.openingPrice, 'openingPrice', 1n) ?? defaultOpeningPrice(estimate),
      increment: amount(l.increment, 'increment', 1n) ?? defaultIncrement(estimate),
    };
  });

  return db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    await assertNotListed(x, terms.map((t) => t.mint)); // a card is offered in one place at a time, even by API (races serialised by an advisory lock)
    const fallbacks = await x.select().from(devnetAssets).where(inArray(devnetAssets.mint, terms.filter((t) => !t.meta).map((t) => t.mint)));
    const replica = new Map(fallbacks.map((r) => [r.mint, r]));
    const attr = (mint: string, ...keys: string[]): string | null => {
      const list = replica.get(mint)?.attributes;
      const hit = Array.isArray(list) ? list.find((a) => a && typeof a === 'object' && keys.includes(String((a as { trait_type?: unknown }).trait_type).toLowerCase())) : undefined;
      const v = hit && typeof hit === 'object' ? (hit as { value?: unknown }).value : undefined;
      return v === undefined || v === null ? null : String(v);
    };

    // The show row is invisible to everyone else until this transaction commits, so there is nothing to lock: show and lots appear together or not at all.
    const [show] = await x
      .insert(shows)
      .values({
        sellerId: i.sellerProfileId, title: i.title, format: i.format ?? 'auction', status: 'scheduled', scheduledAt: i.scheduledAt ? new Date(i.scheduledAt) : null,
        mode: 'auto', rules: i.rules ?? {}, settlementMode: 'onchain', cluster: i.cluster ?? clusterFromEnv(), isHouse: i.isHouse === true,
        kind, orderMode: i.orderMode === 'vrf' ? 'vrf' : 'catalogue', videoEnabled,
      })
      .returning();
    await x.update(profiles).set({ isSeller: true }).where(eq(profiles.id, i.sellerProfileId));
    const made = await x
      .insert(lots)
      .values(
        terms.map((t, n) => ({
          showId: show.id, sellerId: i.sellerProfileId, lotNumber: n + 1, mintAddress: t.mint, nftStandard: t.meta?.nftStandard ?? 'core',
          name: t.meta?.name ?? replica.get(t.mint)?.name ?? 'Graded card', setName: t.meta?.setName ?? attr(t.mint, 'set'),
          gradingCompany: t.meta?.gradingCompany ?? attr(t.mint, 'grading company', 'grader', 'company'), grade: t.meta?.grade ?? attr(t.mint, 'grade'),
          gradingId: t.meta?.gradingId ?? null, imageUrl: t.meta?.imageUrl ?? replica.get(t.mint)?.imageUrl ?? null, insuredValue: t.meta?.insuredValue ?? null,
          reserve: t.reserve ?? null, openingPrice: t.openingPrice, increment: t.increment, buyNowPrice: t.buyNowPrice ?? null, consignStatus: 'ready',
          description: t.description ?? null, aiAssisted: t.aiAssisted,
        })),
      )
      .returning();
    return { show: toShowCore(show, videoEnabled), lots: made.sort((a, b) => a.lotNumber - b.lotNumber).map(toCatalogueLot) };
  });
}

// ---------------------------------------------------------------------------------------------
// Seller controls (withdraw or extend only while the lot has no bid)
// ---------------------------------------------------------------------------------------------

async function controlLot(i: Parameters<AuctionService['controlLot']>[0]): Promise<{ lot: CatalogueLot; live: LiveSnapshot }> {
  if (!isValidUuid(i.lotId)) throw new ApiError('not_found', 'Lot not found.');
  const showId = await db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const [row] = await x.select({ lot: lots, show: shows }).from(lots).innerJoin(shows, eq(shows.id, lots.showId)).where(eq(lots.id, i.lotId)).for('no key update', { of: lots });
    if (!row) throw new ApiError('not_found', 'Lot not found.');
    const { lot, show } = row;
    if (lot.sellerId !== i.actorProfileId) throw new ApiError('not_seller', 'Only the seller controls this lot.');
    // The rule is enforced here, under the lot lock, so a bid that lands a millisecond earlier always wins the race.
    if (lot.bidCount > 0 || lot.highBid !== null) throw new ApiError('wrong_state', 'This lot has a bid and can no longer be changed.');
    const at = new Date(await dbNowMs(x)); // after the lock
    const base = { lotId: lot.id, lotNumber: lot.lotNumber };
    if (i.action === 'withdraw') {
      if (lot.state !== 'catalogued' && lot.state !== 'open') throw new ApiError('wrong_state', 'This lot is already closed.');
      await x.update(lots).set({ state: 'withdrawn', closedAt: at, closedReason: 'withdrawn' }).where(eq(lots.id, lot.id));
      await emit(x, show.id, [{ kind: 'lot.withdrawn', payload: base, at }]);
    } else {
      if (lot.state !== 'open' || !lot.closesAt) throw new ApiError('wrong_state', 'Only an open, timed lot can be extended.');
      // A paused clock is not extended (the pause shifts the deadline on resume; an extend now would be applied to a frozen lot). Read after the lot lock.
      if ((await x.select({ p: PAUSED_AT(show.id) }).from(shows).where(eq(shows.id, show.id)))[0]?.p != null) throw new ApiError('show_paused', 'The room is paused. Resume it first.');
      if (lot.closesAt.getTime() <= at.getTime()) throw new ApiError('wrong_state', 'Bidding on this lot is closed.');
      const rules = rulesOf(show.rules, kindOf(show.kind));
      const maxS = maxSellerExtendS(kindOf(show.kind));
      const seconds = i.seconds === undefined ? rules.snipeExtendS || 15 : Math.floor(i.seconds);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > maxS) throw new ApiError('validation', `seconds must be 1 to ${maxS}.`);
      const closesAt = new Date(extendedClosesAt({ closesAt: lot.closesAt.getTime(), openedAt: effectiveOpenedAt(lot), seconds, rules }));
      if (closesAt.getTime() === lot.closesAt.getTime()) throw new ApiError('wrong_state', 'This lot already has the maximum extension.');
      await x.update(lots).set({ closesAt }).where(eq(lots.id, lot.id));
      await emit(x, show.id, [{ kind: 'lot.extended', payload: { ...base, closesAt: closesAt.toISOString() }, at }]);
    }
    return show.id;
  });
  const [lot] = await db.select().from(lots).where(eq(lots.id, i.lotId));
  const live = await buildSnapshot(showId);
  if (!lot || !live) throw new ApiError('not_found', 'Lot not found.');
  return { lot: toCatalogueLot(lot), live };
}

/** PATCH /api/lots/:id: the seller edits the terms of a lot that has not opened. */
async function patchLot(i: { lotId: string; actorProfileId: string; terms: { reserve?: string; openingPrice?: string; increment?: string; buyNowPrice?: string } }): Promise<CatalogueLot> {
  if (!isValidUuid(i.lotId)) throw new ApiError('not_found', 'Lot not found.');
  const set = {
    ...(i.terms.reserve !== undefined ? { reserve: amount(i.terms.reserve, 'reserve', 0n) } : {}),
    ...(i.terms.openingPrice !== undefined ? { openingPrice: amount(i.terms.openingPrice, 'openingPrice', 1n) } : {}),
    ...(i.terms.increment !== undefined ? { increment: amount(i.terms.increment, 'increment', 1n) } : {}),
    ...(i.terms.buyNowPrice !== undefined ? { buyNowPrice: amount(i.terms.buyNowPrice, 'buyNowPrice', 1n) } : {}),
  };
  if (Object.keys(set).length === 0) throw new ApiError('validation', 'Nothing to change.');
  return db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const [lot] = await x.select().from(lots).where(eq(lots.id, i.lotId)).for('no key update');
    if (!lot) throw new ApiError('not_found', 'Lot not found.');
    if (lot.sellerId !== i.actorProfileId) throw new ApiError('not_seller', 'Only the seller controls this lot.');
    if (lot.state !== 'catalogued') throw new ApiError('wrong_state', 'The terms are fixed once the lot has opened.');
    const [u] = await x.update(lots).set(set).where(eq(lots.id, lot.id)).returning();
    return toCatalogueLot(u);
  });
}

// ---------------------------------------------------------------------------------------------
// Show lifecycle for the seller (and, on the house show only, an operator wallet)
// ---------------------------------------------------------------------------------------------

export interface ShowActor { profileId: string; wallet: string }

async function lockedShowFor(x: Exec, showId: string, actor: ShowActor): Promise<ShowRow> {
  if (!isValidUuid(showId)) throw new ApiError('not_found', 'Show not found.');
  const [row] = await x.select({ show: shows, sellerWallet: profiles.walletAddress }).from(shows).innerJoin(profiles, eq(profiles.id, shows.sellerId)).where(eq(shows.id, showId)).for('no key update', { of: shows });
  if (!row) throw new ApiError('not_found', 'Show not found.');
  if (row.show.sellerId !== actor.profileId && !isAuctioneer(actor.wallet, row.sellerWallet, { isHouse: row.show.isHouse })) throw new ApiError('not_seller', 'Only the seller runs this show.');
  return row.show;
}

/** Go live now. Every lot must be ready; the first lot opens right away. */
async function startShow(showId: string, actor: ShowActor): Promise<ShowCore> {
  await db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const show = await lockedShowFor(x, showId, actor);
    if (show.status !== 'scheduled') throw new ApiError('wrong_state', 'Only a scheduled show can go live.');
    const all = await x.select({ state: lots.state, consign: lots.consignStatus }).from(lots).where(eq(lots.showId, showId));
    if (all.some((l) => l.state === 'catalogued' && l.consign !== 'ready')) throw new ApiError('lots_not_ready', 'Every lot must be ready before the show goes live.');
    const at = new Date(await dbNowMs(x));
    await x.update(shows).set({ status: 'live', startedAt: at }).where(eq(shows.id, showId));
    await emit(x, showId, [{ kind: 'show.live', payload: {}, at }]);
  });
  telegramHooks.showAdvanced(showId, { wentLive: true });
  await advanceShow(showId); // opens the first lot
  const [s] = await db.select().from(shows).where(eq(shows.id, showId));
  return toShowCore(s, await videoEnabledFor(s));
}

/** End the show: no new lots open. A lot already on the block runs to its closing time. */
async function endShow(showId: string, actor: ShowActor): Promise<ShowCore> {
  const s = await db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const show = await lockedShowFor(x, showId, actor);
    if (show.status !== 'live') throw new ApiError('wrong_state', 'Only a live show can be ended.');
    // Ending a paused show resumes it first: the lot on the block must run to its (shifted) end, not stay frozen forever.
    if (show.pausedAt) await applyResume(x, show, new Date(await dbNowMs(x)), false, { wallet: actor.wallet, role: 'end_show' });
    await endShowTx(x, show, new Date());
    return (await x.select().from(shows).where(eq(shows.id, showId)))[0];
  });
  telegramHooks.showAdvanced(showId, { ended: true }); // the watchers of this room hear it is over (never throws, runs after the response)
  return toShowCore(s, await videoEnabledFor(s));
}

/**
 * Pause the room (the seller, or an operator wallet on the house show). Bids are refused until the seller resumes or the pause reaches PAUSE_MAX_MS, the
 * open lot's deadline is held where it stands and moves by the paused time on resume, so no bidder loses time. Limited to protect bidders (`decidePause`):
 * 2 pauses per show, 5 minutes each, never in the last 10 seconds of the lot. Lock order: show, then the open lot; the clock is read after both locks.
 */
async function pauseShow(showId: string, actor: ShowActor): Promise<ShowCore> {
  if (isValidUuid(showId)) await advanceShow(showId); // a pause that already reached its limit is resumed first (and a lot that is due is closed first)
  const s = await db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const show = await lockedShowFor(x, showId, actor);
    const [lot] = await x.select().from(lots).where(and(eq(lots.showId, showId), eq(lots.state, 'open'))).for('no key update');
    const at = new Date(await dbNowMs(x));
    const d = decidePause({ status: show.status, kind: kindOf(show.kind), pausedAt: show.pausedAt?.getTime() ?? null, pauseCount: show.pauseCount, openLot: lot ? { closesAt: lot.closesAt?.getTime() ?? null } : null, now: at.getTime() });
    if (!d.ok) throw new ApiError(d.code, d.reason);
    const upd = await x.update(shows).set({ pausedAt: at, pauseCount: sql`${shows.pauseCount} + 1` }).where(and(eq(shows.id, showId), sql`${shows.pausedAt} is null`)).returning({ id: shows.id });
    if (upd.length === 0) throw new ApiError('show_paused', 'The room is already paused.');
    await x.insert(auditLogs).values({ action: 'show.pause', actorWallet: actor.wallet, target: showId, detail: { by: show.sellerId === actor.profileId ? 'seller' : 'operator', count: d.count, msLeft: Math.max(0, Math.floor(d.msLeft)), lotId: lot!.id } });
    await emit(x, showId, [{ kind: 'show.paused', payload: { lotId: lot!.id, lotNumber: lot!.lotNumber, resumesBy: new Date(d.resumesBy).toISOString(), msLeft: Math.max(0, Math.floor(d.msLeft)), count: d.count, max: PAUSE_MAX_COUNT }, at }]);
    return (await x.select().from(shows).where(eq(shows.id, showId)))[0];
  });
  return toShowCore(s, await videoEnabledFor(s));
}

/** Resume a paused room now. The lot's deadline moves by the paused time. Resuming a room that is not paused is `wrong_state`. */
async function resumeShow(showId: string, actor: ShowActor): Promise<ShowCore> {
  const s = await db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const show = await lockedShowFor(x, showId, actor);
    if (!show.pausedAt) throw new ApiError('wrong_state', 'The room is not paused.');
    const at = new Date(await dbNowMs(x));
    await applyResume(x, show, at, pauseExpired(show.pausedAt.getTime(), at.getTime()), { wallet: actor.wallet, role: show.sellerId === actor.profileId ? 'seller' : 'operator' });
    return (await x.select().from(shows).where(eq(shows.id, showId)))[0];
  });
  return toShowCore(s, await videoEnabledFor(s));
}

/** Cancel a show that has not started. */
async function cancelShow(showId: string, actor: ShowActor): Promise<ShowCore> {
  const s = await db.transaction(async (tx) => {
    const x = tx as unknown as Exec;
    const show = await lockedShowFor(x, showId, actor);
    if (show.status !== 'scheduled') throw new ApiError('wrong_state', 'Only a scheduled show can be cancelled.');
    await endShowTx(x, show, new Date(), { cancelled: true });
    return (await x.select().from(shows).where(eq(shows.id, showId)))[0];
  });
  telegramHooks.showAdvanced(showId, { ended: true });
  return toShowCore(s, await videoEnabledFor(s));
}

export const auction = { buyNow, placeBid, advanceShow, sweep, getLiveSnapshot, getCatalogue, listShows, createShow, controlLot, registerPaddle, commitmentsFor, patchLot, startShow, endShow, cancelShow, pauseShow, resumeShow };
export { buyNow, placeBid, advanceShow, sweep, getLiveSnapshot, getCatalogue, listShows, createShow, controlLot, registerPaddle, commitmentsFor, patchLot, startShow, endShow, cancelShow, pauseShow, resumeShow };
export { buildSnapshot } from './snapshot';

/** Compile-time proof that the service satisfies the contract (the extras above are additive). */
export const _conformsToContract = { placeBid, advanceShow, sweep, getLiveSnapshot, getCatalogue, listShows, createShow, controlLot, buyNow, registerPaddle, commitmentsFor } satisfies AuctionService;
