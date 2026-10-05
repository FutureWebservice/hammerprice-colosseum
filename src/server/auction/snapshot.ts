/**
 * Read side of the auction: the public live snapshot (two queries), and the row mappers shared with the service.
 * Server-only (database). Nothing here writes.
 *
 * The snapshot is identical for every viewer and carries paddle numbers, never wallets.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { NeonQueryResultHKT } from 'drizzle-orm/neon-serverless';
import { db, lots, paddles, schema, settlements, showEvents, shows, vrfRequests } from '@/db';
import { type CatalogueLot, type LiveSnapshot, type ShowCore } from '@/contracts/api';
import { LotDescription } from '@/contracts/common';
import { isValidUuid } from '@/lib/uuid';
import { envRuleDefaults, resolveRules } from '@/lib/auction/rules';
import { lotPhase } from '@/lib/auction/phase';
import { pauseExpiresAt } from '@/lib/auction/engine';
import { PAUSE_MAX_COUNT } from '@/lib/auction/rules';
import { normalizeKind, publicPayload } from '@/lib/auction/events';
import { featureOn } from '@/lib/features';

/** The database handle or a transaction on it. */
export type Exec = PgDatabase<NeonQueryResultHKT, typeof schema>;
export type ShowRow = typeof shows.$inferSelect;
export type LotRow = typeof lots.$inferSelect;

/** The engine drives only shows created for real settlement in auto mode. Legacy rows (settlement_mode 'none', manual) are left alone. */
export const isManaged = (s: { settlementMode: string; mode: string }): boolean => s.settlementMode === 'onchain' && s.mode === 'auto';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Whether the show's video is on here: the seller's choice AND the deployment's switch. It never says where the video comes from. */
export const videoEnabledFor = async (s: Pick<ShowRow, 'videoEnabled'>): Promise<boolean> => s.videoEnabled && (await featureOn('VIDEO'));
const kindOf = (s: Pick<ShowRow, 'kind'>): ShowCore['kind'] => (s.kind === 'timed' ? 'timed' : 'live');
const orderModeOf = (s: Pick<ShowRow, 'orderMode'>): ShowCore['orderMode'] => (s.orderMode === 'vrf' ? 'vrf' : 'catalogue');

export const toShowCore = (s: ShowRow, videoEnabled = false, sellerName: string | null = null): ShowCore => ({
  id: s.id,
  title: s.title,
  format: s.format,
  mode: s.mode === 'manual' ? 'manual' : 'auto',
  status: s.status,
  scheduledAt: iso(s.scheduledAt),
  startedAt: iso(s.startedAt),
  endedAt: iso(s.endedAt),
  settlementMode: s.settlementMode === 'onchain' ? 'onchain' : 'none',
  cluster: s.cluster === 'devnet' || s.cluster === 'mainnet-beta' ? s.cluster : null,
  isHouse: s.isHouse,
  kind: kindOf(s),
  orderMode: orderModeOf(s),
  lotDurationS: resolveRules(s.rules, envRuleDefaults(), kindOf(s)).lotDurationS,
  sellerName: s.isHouse ? null : sellerName,
  video: { enabled: videoEnabled },
});

/** `lots.description` is jsonb written by this server only; anything that is not { de, en } strings reads as "no description". */
const toDescription = (raw: unknown): CatalogueLot['description'] => {
  const r = LotDescription.safeParse(raw);
  return r.success ? r.data : null;
};

const STANDARDS = ['core', 'pnft', 'nft', 'cnft', 'unknown'] as const;
const CONSIGN = ['none', 'pending', 'ready', 'rejected'] as const;
export const toCatalogueLot = (l: LotRow): CatalogueLot => ({
  id: l.id,
  lotNumber: l.lotNumber,
  name: l.name,
  setName: l.setName,
  gradingCompany: l.gradingCompany,
  grade: l.grade,
  imageUrl: l.imageUrl,
  insuredValue: l.insuredValue?.toString() ?? null,
  reserve: l.reserve?.toString() ?? null,
  increment: l.increment.toString(),
  openingPrice: l.openingPrice.toString(),
  buyNowPrice: l.buyNowPrice?.toString() ?? null,
  mintAddress: l.mintAddress,
  nftStandard: (STANDARDS as readonly string[]).includes(l.nftStandard) ? (l.nftStandard as CatalogueLot['nftStandard']) : 'unknown',
  consignStatus: (CONSIGN as readonly string[]).includes(l.consignStatus) ? (l.consignStatus as CatalogueLot['consignStatus']) : 'none',
  description: toDescription(l.description),
  aiAssisted: l.aiAssisted,
});

const LIVE_SETTLEMENT = new Set(['awaiting_payment', 'awaiting_seller', 'submitted', 'settled']);

/** Two queries: show + lots + paddles + settlements with the database clock, then the last 40 events. */
export async function buildSnapshot(showId: string, x: Exec = db as unknown as Exec): Promise<LiveSnapshot | null> {
  if (!isValidUuid(showId)) return null;
  const [rows, events] = await Promise.all([
    x
      .select({
        show: shows,
        lot: lots,
        paddle: paddles.number,
        stId: settlements.id,
        stStatus: settlements.status,
        stTx: settlements.txSignature,
        vrfId: vrfRequests.id,
        vrfStatus: vrfRequests.status,
        nowMs: sql<number>`(extract(epoch from clock_timestamp()) * 1000)::float8`,
      })
      .from(shows)
      .leftJoin(lots, eq(lots.showId, shows.id))
      .leftJoin(paddles, and(eq(paddles.showId, shows.id), eq(paddles.profileId, lots.highBidderId)))
      .leftJoin(settlements, eq(settlements.lotId, lots.id))
      // Only a show with a drawn order has a request to look up; a catalogue show never touches the table.
      .leftJoin(vrfRequests, and(eq(shows.orderMode, 'vrf'), eq(vrfRequests.purpose, 'lot_order'), eq(vrfRequests.subjectType, 'show'), eq(vrfRequests.subjectId, sql`${shows.id}::text`)))
      .where(eq(shows.id, showId))
      .orderBy(asc(lots.lotNumber)),
    x
      .select({ id: showEvents.id, kind: showEvents.kind, payload: showEvents.payload, at: showEvents.createdAt })
      .from(showEvents)
      .where(eq(showEvents.showId, showId))
      .orderBy(desc(showEvents.id))
      .limit(40),
  ]);
  if (rows.length === 0) return null;

  const show = rows[0].show;
  const now = Math.floor(Number(rows[0].nowMs));
  const order: LiveSnapshot['show']['order'] =
    show.orderMode === 'vrf'
      ? { mode: 'vrf', ...(rows[0].vrfId ? { requestId: rows[0].vrfId, status: rows[0].vrfStatus as NonNullable<LiveSnapshot['show']['order']['status']> } : {}) }
      : { mode: 'catalogue' };
  const videoEnabled = await videoEnabledFor(show);
  const rules = resolveRules(show.rules, envRuleDefaults(), kindOf(show));

  // One entry per lot; a lot could carry an old expired settlement next to a live one, so prefer the live one.
  const byLot = new Map<string, { lot: LotRow; paddle: number | null; st: { id: string; status: string; tx: string | null } | null }>();
  for (const r of rows) {
    if (!r.lot) continue;
    const st = r.stId ? { id: r.stId, status: r.stStatus as string, tx: r.stTx } : null;
    const cur = byLot.get(r.lot.id);
    if (!cur) byLot.set(r.lot.id, { lot: r.lot, paddle: r.paddle, st });
    else if (st && (!cur.st || (LIVE_SETTLEMENT.has(st.status) && !LIVE_SETTLEMENT.has(cur.st.status)))) cur.st = st;
  }
  const entries = [...byLot.values()];

  // The seller's pause: the clock is frozen, so the phase is drawn at the moment of the pause (a paused lot keeps its call and never turns "hammered").
  const pausedAt = show.status === 'live' ? show.pausedAt : null;
  const pause: LiveSnapshot['show']['pause'] = {
    paused: pausedAt !== null,
    pausedAt: iso(pausedAt),
    resumesBy: pausedAt ? new Date(pauseExpiresAt(pausedAt.getTime())).toISOString() : null,
    used: show.pauseCount,
    max: PAUSE_MAX_COUNT,
  };
  const phaseNow = pausedAt ? pausedAt.getTime() : now;

  const settlementOf = (e: (typeof entries)[number]) => (e.st ? { status: e.st.status as never } : null);
  const open = entries.find((e) => e.lot.state === 'open');
  const closed = entries.filter((e) => e.lot.closedAt).sort((a, b) => b.lot.closedAt!.getTime() - a.lot.closedAt!.getTime() || b.lot.lotNumber - a.lot.lotNumber);
  const cur = open ?? closed[0] ?? null;
  const openable = entries.some((e) => e.lot.state === 'catalogued' && e.lot.consignStatus === 'ready');
  const lastClosed = closed[0]?.lot.closedAt?.getTime() ?? null;

  const current: LiveSnapshot['current'] = cur
    ? {
        lotId: cur.lot.id,
        lotNumber: cur.lot.lotNumber,
        phase: lotPhase({ state: cur.lot.state, closesAt: cur.lot.closesAt?.getTime() ?? null, closedAt: cur.lot.closedAt?.getTime() ?? null, now: cur.lot.state === 'open' ? phaseNow : now, rules, settlement: settlementOf(cur) }),
        closesAt: iso(cur.lot.closesAt),
        nextOpensAt: !open && show.status === 'live' && isManaged(show) && openable && lastClosed !== null ? new Date(lastClosed + rules.gapS * 1000).toISOString() : null,
      }
    : null;

  const snapshotEvents = events.reverse().map((e) => ({ id: e.id, kind: normalizeKind(e.kind), at: e.at.toISOString(), payload: publicPayload(e.payload) }));

  return {
    v: 1,
    serverNow: now,
    show: {
      id: show.id,
      title: show.title,
      status: show.status,
      mode: show.mode === 'manual' ? 'manual' : 'auto',
      scheduledAt: iso(show.scheduledAt),
      settlementMode: show.settlementMode === 'onchain' ? 'onchain' : 'none',
      cluster: show.cluster,
      isHouse: show.isHouse,
      kind: kindOf(show),
      order,
      video: { enabled: videoEnabled },
      pause,
    },
    current,
    lots: entries.map((e) => ({
      id: e.lot.id,
      lotNumber: e.lot.lotNumber,
      state: e.lot.state,
      highBid: e.lot.highBid?.toString() ?? null,
      highBidder: e.lot.highBidderId ? { paddle: e.paddle } : null,
      bidCount: e.lot.bidCount,
      closesAt: iso(e.lot.closesAt),
      ...(e.st ? { settlement: { id: e.st.id, status: e.st.status as never, ...(e.st.tx ? { txSignature: e.st.tx } : {}) } } : {}),
    })),
    events: snapshotEvents,
    lastEventId: snapshotEvents.length ? snapshotEvents[snapshotEvents.length - 1].id : 0,
  };
}
