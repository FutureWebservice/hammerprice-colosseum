/**
 * Sending the notifications. Every message goes through `deliver`, which makes four promises:
 *
 *   - Opt-in: only a linked chat whose switch for this kind is on is ever messaged (`linksWanting`).
 *   - Once: a marker row (profile, kind, our own object id) is claimed BEFORE sending, so a hook, a retry and the daily sweep that all see the
 *     same event send it once. A failed send gives the claim back so a later pass can retry.
 *   - Rate limited per chat (20 a minute, the shared `rate_limits` table): over the limit the message is not sent and not claimed.
 *   - A Telegram 403 (the user blocked the bot) unlinks the chat on the spot.
 *
 * Events are found by id (a bid, a lot, a settlement, a show, a chat message) or, in the daily sweep, by a bounded scan. Only events that happened
 * AFTER the chat was linked are sent, so connecting never floods the user with the past. Texts come from copy.ts (German or English by the link's
 * language) and carry absolute links into the site; the explorer link of a receipt follows the settlement's own cluster.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { bids, chatMessages, lots, packDefinitions, packDraws, paddles, profiles, settlements, shows, telegramSent, telegramWatches } from '@/db/schema';
import type { Cluster } from '@/contracts/common';
import type { TelegramLocale, TelegramType } from '@/contracts/telegram';
import { operatorWallets } from '@/lib/auctioneer';
import { resolveCluster } from '@/lib/chain/config';
import { rateLimit } from '@/lib/http/ratelimit';
import { createBotApi, type BotApi, type ReplyMarkup } from './api';
import { signCallback } from './callback';
import { telegramConfig, type BotConfig } from './config';
import { bidLink, minutesLeft, payLink, receiptLink, roomLink, siteLink, t, usdc, usdcCeil, when } from './copy';
import { minNextBid } from '@/lib/auction/engine';
import { watchCallback } from './watch';
import { linksWanting, unlinkChat, type Link } from './links';

async function getDb() {
  return (await import('@/db')).db;
}

/** Messages per chat and minute. Telegram's own ceiling for a private chat is about one a second; this is well inside it. */
export const CHAT_LIMIT_PER_MIN = 20;
export const ENDING_SOON_MS = 5 * 60_000;
export const MUTE_MINUTES = 60;
/** The deadline reminder goes out when the deadline is within this long, and not within the first hour after the win (the win message says it already). */
export const DEADLINE_WINDOW_MS = 24 * 3_600_000;
export const DEADLINE_QUIET_MS = 3_600_000;

export type Outcome = 'sent' | 'duplicate' | 'limited' | 'blocked' | 'failed';
export interface Content { text: string; markup?: ReplyMarkup }
/** `api` and `now` are for tests; production passes nothing. */
/** `deadline` (epoch ms) is for the daily sweep: past it nothing more is sent, so a slow Telegram cannot eat the function's time (the rest waits for the next pass). */
export interface Deps { api?: BotApi; now?: Date; deadline?: number }
interface Ctx { cfg: BotConfig; api: BotApi; now: Date; deadline?: number }

/** The configuration and API client, or null while the feature is off (every notifier then does nothing). */
export async function context(deps: Deps = {}): Promise<Ctx | null> {
  const cfg = await telegramConfig();
  if (!cfg) return null;
  return { cfg, api: deps.api ?? createBotApi(cfg), now: deps.now ?? new Date(), deadline: deps.deadline };
}

export async function deliver(ctx: Ctx, link: Link, kind: TelegramType, ref: string, content: (link: Link) => Content | Promise<Content>): Promise<Outcome> {
  return (await deliverMany(ctx, link, kind, [ref], (l) => content(l))).outcome;
}

/**
 * `deliver` for one message that stands for several objects (a burst of lots that opened): every ref is claimed first, the refs that were already
 * sent are left out, and `content` is built from the ones this call claimed. One message, one rate-limit slot; a failure gives all the claims back.
 */
export async function deliverMany(ctx: Ctx, link: Link, kind: TelegramType, refs: string[], content: (link: Link, claimed: string[]) => Content | Promise<Content>): Promise<{ outcome: Outcome; claimed: string[] }> {
  if (ctx.deadline !== undefined && Date.now() > ctx.deadline) return { outcome: 'limited', claimed: [] };
  const db = await getDb();
  const unique = [...new Set(refs)];
  const got = await db.insert(telegramSent).values(unique.map((ref) => ({ profileId: link.profileId, kind, ref, sentAt: ctx.now }))).onConflictDoNothing().returning({ ref: telegramSent.ref });
  if (got.length === 0) return { outcome: 'duplicate', claimed: [] };
  const claimed = unique.filter((r) => got.some((g) => g.ref === r));
  const release = () => db.delete(telegramSent).where(and(eq(telegramSent.profileId, link.profileId), eq(telegramSent.kind, kind), inArray(telegramSent.ref, claimed)));
  try {
    if (!(await rateLimit(`tg:chat:${link.chatId}`, CHAT_LIMIT_PER_MIN, 60, { failOpen: true })).ok) { await release(); return { outcome: 'limited', claimed: [] }; }
    const c = await content(link, claimed);
    const res = await ctx.api.sendMessage(link.chatId, c.text, c.markup);
    if (res.ok) return { outcome: 'sent', claimed };
    await release();
    if (res.blocked) { await unlinkChat(link.chatId); return { outcome: 'blocked', claimed: [] }; }
    return { outcome: 'failed', claimed: [] };
  } catch (e) {
    await release().catch(() => {});
    throw e;
  }
}

async function deliverAll(ctx: Ctx, links: Link[], kind: TelegramType, ref: string, content: (link: Link) => Content | Promise<Content>): Promise<number> {
  let sent = 0;
  for (const l of links) if ((await deliver(ctx, l, kind, ref, content)) === 'sent') sent++;
  return sent;
}

// ---------------------------------------------------------------------------------------------
// Outbid and ending soon (called after a bid is stored)
// ---------------------------------------------------------------------------------------------

export interface BidEvent {
  bidId: string; lotId: string; lotName: string; showId: string; amount: bigint;
  /** The leading bidder before this bid (the one who is outbid), and the one who just bid. */
  previousBidderId: string | null; bidderId: string;
  closesAt: Date | null;
}

export async function notifyOutbid(e: BidEvent, deps: Deps = {}): Promise<number> {
  if (!e.previousBidderId || e.previousBidderId === e.bidderId) return 0;
  const ctx = await context(deps);
  if (!ctx) return 0;
  const links = await linksWanting([e.previousBidderId], 'outbid');
  return deliverAll(ctx, links, 'outbid', e.bidId, (l) => ({ text: t(l.locale, 'outbid', { lot: e.lotName, amount: usdc(e.amount), link: roomLink(l.locale, e.showId) }) }));
}

/** Everyone who bid on the lot except `exceptProfileId`, when the lot closes within `withinMs`. Once per lot and person. */
export async function notifyEndingSoon(i: { lotId: string; lotName: string; showId: string; closesAt: Date; highBid: bigint | null; exceptProfileId?: string }, deps: Deps & { withinMs?: number } = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const left = i.closesAt.getTime() - ctx.now.getTime();
  if (left <= 0 || left > (deps.withinMs ?? ENDING_SOON_MS)) return 0;
  const db = await getDb();
  const rows = await db.selectDistinct({ id: bids.bidderId }).from(bids).where(eq(bids.lotId, i.lotId));
  const links = (await linksWanting(rows.map((r) => r.id).filter((id) => id !== i.exceptProfileId), 'ending_soon')).filter((l) => l.linkedAt <= ctx.now);
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return deliverAll(ctx, links, 'ending_soon', i.lotId, (l) => ({ text: t(l.locale, 'endingSoon', { lot: i.lotName, minutes, amount: usdc(i.highBid ?? 0n), link: roomLink(l.locale, i.showId) }) }));
}

// ---------------------------------------------------------------------------------------------
// Won, settled, deadline (settlement rows)
// ---------------------------------------------------------------------------------------------

const saleCols = {
  id: settlements.id, lotId: settlements.lotId, buyerId: settlements.buyerId, sellerId: settlements.sellerId, gross: settlements.grossAmount, dueAt: settlements.dueAt,
  status: settlements.status, cluster: settlements.cluster, txSignature: settlements.txSignature, settledAt: settlements.settledAt,
  lotName: lots.name, showId: lots.showId, closedAt: lots.closedAt,
};
type Sale = { id: string; lotId: string; buyerId: string; sellerId: string; gross: bigint; dueAt: Date | null; status: string; cluster: string | null; txSignature: string | null; settledAt: Date | null; lotName: string; showId: string | null; closedAt: Date | null };

async function sales(status: 'awaiting_payment' | 'settled', where: SQL | undefined, limit = 100): Promise<Sale[]> {
  const db = await getDb();
  return db.select(saleCols).from(settlements).innerJoin(lots, eq(lots.id, settlements.lotId)).where(and(eq(settlements.status, status), where)).orderBy(asc(settlements.dueAt)).limit(limit);
}

/** The buyer(s) of these open sales who want `won`: "you won, pay by ...", with the pay link. Filter by settlement, lot or show, or the last `sinceMs`. */
export async function notifyWon(f: { settlementId?: string; lotId?: string; showId?: string; sinceMs?: number }, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const conds: SQL[] = [];
  if (f.settlementId) conds.push(eq(settlements.id, f.settlementId));
  if (f.lotId) conds.push(eq(settlements.lotId, f.lotId));
  if (f.showId) conds.push(eq(lots.showId, f.showId));
  if (f.sinceMs) conds.push(gte(lots.closedAt, new Date(ctx.now.getTime() - f.sinceMs)));
  const rows = (await sales('awaiting_payment', and(...conds))).filter((s) => s.dueAt && s.dueAt > ctx.now);
  const links = new Map((await linksWanting(rows.map((r) => r.buyerId), 'won')).map((l) => [l.profileId, l]));
  let sent = 0;
  for (const s of rows) {
    const link = links.get(s.buyerId);
    if (!link || !s.closedAt || s.closedAt < link.linkedAt) continue;
    const out = await deliver(ctx, link, 'won', s.id, (l) => ({ text: t(l.locale, 'won', { lot: s.lotName, amount: usdc(s.gross), due: when(s.dueAt!, l.locale), link: payLink(l.locale, s.showId, s.id, s.lotId) }) }));
    if (out === 'sent') sent++;
  }
  return sent;
}

/** The payment deadline reminder (daily sweep): open sales due within 24 hours that were won more than an hour ago. */
export async function notifyDeadlines(deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const now = ctx.now.getTime();
  const rows = await sales('awaiting_payment', and(gt(settlements.dueAt, ctx.now), lte(settlements.dueAt, new Date(now + DEADLINE_WINDOW_MS)), lte(lots.closedAt, new Date(now - DEADLINE_QUIET_MS))));
  const links = new Map((await linksWanting(rows.map((r) => r.buyerId), 'deadline')).map((l) => [l.profileId, l]));
  let sent = 0;
  for (const s of rows) {
    const link = links.get(s.buyerId);
    if (!link || !s.closedAt || s.closedAt < link.linkedAt) continue;
    const out = await deliver(ctx, link, 'deadline', s.id, (l) => ({ text: t(l.locale, 'deadline', { lot: s.lotName, amount: usdc(s.gross), due: when(s.dueAt!, l.locale), link: payLink(l.locale, s.showId, s.id, s.lotId) }) }));
    if (out === 'sent') sent++;
  }
  return sent;
}

/** A finished settlement: the buyer hears the card is theirs, the seller hears it was paid. Both with the receipt on the settlement's own cluster. */
export async function notifySettled(f: { settlementId?: string; sinceMs?: number }, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const conds: SQL[] = [isNotNull(settlements.txSignature)];
  if (f.settlementId) conds.push(eq(settlements.id, f.settlementId));
  if (f.sinceMs) conds.push(gte(settlements.settledAt, new Date(ctx.now.getTime() - f.sinceMs)));
  const rows = await sales('settled', and(...conds));
  const links = new Map((await linksWanting(rows.flatMap((r) => [r.buyerId, r.sellerId]), 'settled')).map((l) => [l.profileId, l]));
  let sent = 0;
  for (const s of rows) {
    const cluster = (s.cluster ?? resolveCluster()) as Cluster;
    const receipt = await receiptLink(s.txSignature!, cluster);
    for (const [who, profileId] of [['buyer', s.buyerId], ['seller', s.sellerId]] as const) {
      const link = links.get(profileId);
      if (!link || (s.settledAt && s.settledAt < link.linkedAt)) continue;
      const out = await deliver(ctx, link, 'settled', s.id, (l) => ({ text: who === 'buyer' ? t(l.locale, 'settledBuyer', { lot: s.lotName, receipt }) : t(l.locale, 'settledSeller', { lot: s.lotName, amount: usdc(s.gross), receipt }) }));
      if (out === 'sent') sent++;
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------------------------
// A show starts
// ---------------------------------------------------------------------------------------------

/** People who registered a bidder number for a show (not its seller) hear when it starts. There is no separate "follow" yet; the paddle is the signal. */
export async function notifyShowStarted(showId: string, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const db = await getDb();
  const [show] = await db.select({ id: shows.id, title: shows.title, status: shows.status, startedAt: shows.startedAt, sellerId: shows.sellerId, kind: shows.kind }).from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show || show.status !== 'live') return 0;
  const rows = await db.select({ id: paddles.profileId }).from(paddles).where(and(eq(paddles.showId, showId), sql`${paddles.revokedAt} is null`, ne(paddles.profileId, show.sellerId)));
  const links = (await linksWanting(rows.map((r) => r.id), 'show_start')).filter((l) => !show.startedAt || show.startedAt >= l.linkedAt);
  return deliverAll(ctx, links, 'show_start', showId, (l) => ({
    text: t(l.locale, 'showStart', { show: show.title, link: roomLink(l.locale, showId) }),
    markup: show.kind === 'live' ? { inline_keyboard: [[{ text: t(l.locale, 'watchRoom'), callback_data: watchCallback('p', showId) }]] } : undefined, // "Watch this room": asks how many lots, see watch.ts
  }));
}

// ---------------------------------------------------------------------------------------------
// Watch a room: one short message when a lot opens (the bot never bids, see watch.ts)
// ---------------------------------------------------------------------------------------------

/** A lot that opened longer ago than this is not announced any more (the room has moved on); a burst inside it is collapsed into one message. */
export const WATCH_LOOKBACK_MS = 15 * 60_000;
/** At most this many lot lines in one collapsed message (the count in its first line still says how many opened). */
const WATCH_BURST_MAX = 5;

/**
 * The people who watch this room hear that lots opened: ONE message per person and pass. A single new lot gets the card, grade, opening price, time
 * left and the room link, with a "Bid N" button (the next valid bid) and a "+10 %" one. Both buttons are plain URL buttons to
 * `/room/<show>?lot=<n>&bid=<amount>`: the room pre-fills its own confirmation and the person signs in their own wallet. Several lots at once
 * (a pass that was late) become one list message with the buttons of the lot that is still open. Once per person and lot (`telegram_sent`), only lots
 * that opened after the watch started, never more than the person's count, and over the chat's rate limit nothing is claimed so a later pass sends it.
 */
export async function notifyLotsOpened(showId: string, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const db = await getDb();
  const [show] = await db.select({ id: shows.id, title: shows.title, status: shows.status }).from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show) return 0;
  if (show.status === 'ended') { await notifyWatchEnded(showId, deps); return 0; }
  const watches = await db.select().from(telegramWatches).where(and(eq(telegramWatches.showId, showId), sql`(${telegramWatches.remaining} is null or ${telegramWatches.remaining} > 0)`));
  if (watches.length === 0) return 0;
  const since = new Date(ctx.now.getTime() - WATCH_LOOKBACK_MS);
  const opened = await db.select({
    id: lots.id, number: lots.lotNumber, name: lots.name, company: lots.gradingCompany, grade: lots.grade, state: lots.state, openedAt: lots.openedAt, closesAt: lots.closesAt,
    highBid: lots.highBid, openingPrice: lots.openingPrice, increment: lots.increment,
  }).from(lots).where(and(eq(lots.showId, showId), isNotNull(lots.openedAt), gte(lots.openedAt, since), inArray(lots.state, ['open', 'sold', 'passed']))).orderBy(asc(lots.lotNumber)).limit(20);
  if (opened.length === 0) return 0;
  const links = new Map((await linksWanting(watches.map((w) => w.profileId), 'lot_watch')).map((l) => [l.profileId, l]));
  const told = new Set((await db.select({ p: telegramSent.profileId, ref: telegramSent.ref }).from(telegramSent)
    .where(and(eq(telegramSent.kind, 'lot_watch'), inArray(telegramSent.profileId, watches.map((w) => w.profileId)), inArray(telegramSent.ref, opened.map((l) => l.id))))).map((r) => `${r.p}:${r.ref}`));
  let sent = 0;
  for (const w of watches) {
    const link = links.get(w.profileId);
    if (!link) continue;
    let mine = opened.filter((l) => l.openedAt! >= w.createdAt && !told.has(`${w.profileId}:${l.id}`)); // not yet announced to this person (before the count is applied)
    if (w.remaining !== null) mine = mine.slice(0, w.remaining);
    if (mine.length === 0) continue;
    const { outcome, claimed } = await deliverMany(ctx, link, 'lot_watch', mine.map((l) => l.id), (l, got) => {
      const lotsNow = mine.filter((x) => got.includes(x.id));
      const live = [...lotsNow].reverse().find((x) => x.state === 'open' && x.closesAt && x.closesAt > ctx.now);
      const left = w.remaining === null ? t(l.locale, 'lotLeftAll') : w.remaining - lotsNow.length > 0 ? t(l.locale, 'lotLeft', { n: w.remaining - lotsNow.length }) : t(l.locale, 'lotLeftAll');
      const head = lotsNow.length === 1
        ? t(l.locale, 'lotOpen', {
          number: lotsNow[0].number, show: show.title, lot: lotsNow[0].name, grade: lotsNow[0].grade ? ` (${[lotsNow[0].company, lotsNow[0].grade].filter(Boolean).join(' ')})` : '',
          amount: usdc(lotsNow[0].highBid ?? lotsNow[0].openingPrice), minutes: lotsNow[0].closesAt ? minutesLeft(lotsNow[0].closesAt.getTime() - ctx.now.getTime()) : 1, link: roomLink(l.locale, showId),
        })
        : t(l.locale, 'lotsOpen', { count: lotsNow.length, show: show.title, link: roomLink(l.locale, showId), lines: lotsNow.slice(-WATCH_BURST_MAX).map((x) => t(l.locale, 'lotsLine', { number: x.number, lot: x.name, amount: usdc(x.openingPrice) })).join('\n') });
      return { text: `${head}\n\n${t(l.locale, 'lotNote')}\n${left}`, markup: live ? bidButtons(l.locale, showId, live) : undefined };
    });
    if (outcome !== 'sent') continue;
    sent++;
    // The count only moves for a message that really went out. Gone at 0, so the row never outlives its alerts.
    if (w.remaining !== null) {
      await db.update(telegramWatches).set({ remaining: sql`greatest(${telegramWatches.remaining} - ${claimed.length}, 0)` }).where(and(eq(telegramWatches.profileId, w.profileId), eq(telegramWatches.showId, showId), sql`${telegramWatches.remaining} is not null`));
      await db.delete(telegramWatches).where(and(eq(telegramWatches.profileId, w.profileId), eq(telegramWatches.showId, showId), sql`${telegramWatches.remaining} <= 0`));
    }
  }
  return sent;
}

/** The two bid buttons of an open lot: the next valid bid and 10 percent more (rounded up to the cent). Both only open the room pre-filled. */
function bidButtons(locale: TelegramLocale, showId: string, lot: { number: number; highBid: bigint | null; openingPrice: bigint; increment: bigint }): ReplyMarkup {
  const min = minNextBid({ highBid: lot.highBid, openingPrice: lot.openingPrice, increment: lot.increment });
  const plus = (min * 110n + 99n) / 100n;
  const row = [{ text: t(locale, 'bidButton', { amount: usdcCeil(min) }), url: bidLink(locale, showId, lot.number, usdcCeil(min)) }];
  if (usdcCeil(plus) !== usdcCeil(min)) row.push({ text: t(locale, 'bidButtonPlus', { amount: usdcCeil(plus) }), url: bidLink(locale, showId, lot.number, usdcCeil(plus)) });
  return { inline_keyboard: [row] };
}

/**
 * A watched show is over (or cancelled): every watcher hears it once, and the watches go. The watches go even for people who switched the messages off
 * or unlinked, so no row outlives its show.
 */
export async function notifyWatchEnded(showId: string, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const db = await getDb();
  const [show] = await db.select({ title: shows.title, status: shows.status }).from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show || show.status !== 'ended') return 0;
  const watches = await db.select({ profileId: telegramWatches.profileId }).from(telegramWatches).where(eq(telegramWatches.showId, showId));
  if (watches.length === 0) return 0;
  const links = await linksWanting(watches.map((w) => w.profileId), 'lot_watch');
  const sent = await deliverAll(ctx, links, 'lot_watch', `end:${showId}`, (l) => ({ text: t(l.locale, 'watchEnded', { show: show.title }) }));
  await db.delete(telegramWatches).where(eq(telegramWatches.showId, showId));
  return sent;
}

// ---------------------------------------------------------------------------------------------
// Packs (A14): the operator must deliver a paid and drawn card
// ---------------------------------------------------------------------------------------------

/**
 * The operator of a third-party chance pack hears that a purchase was paid to them and drawn (`reminder` false), or that its deadline is close
 * (`reminder` true). Once per draw and kind. Nothing here names the card (the operator sees it on the manage page); the text names the pack.
 */
export async function notifyPackDelivery(drawId: string, o: { reminder?: boolean } = {}, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const db = await getDb();
  const [r] = await db.select({ id: packDraws.id, status: packDraws.status, price: packDraws.price, deliverBy: packDraws.deliverBy, name: packDefinitions.name, operator: packDefinitions.operatorProfileId, isHouse: packDefinitions.isHouse })
    .from(packDraws).innerJoin(packDefinitions, eq(packDefinitions.id, packDraws.packId)).where(eq(packDraws.id, drawId)).limit(1);
  if (!r || r.isHouse || r.status !== 'drawn' || !r.deliverBy) return 0;
  const links = await linksWanting([r.operator], 'pack_delivery');
  const name = r.name as { de: string; en: string };
  return deliverAll(ctx, links, 'pack_delivery', o.reminder ? `${r.id}:due` : r.id, (l) => ({
    text: t(l.locale, o.reminder ? 'packDue' : 'packSold', { pack: name[l.locale], amount: usdc(r.price), due: when(r.deliverBy!, l.locale), link: siteLink(l.locale, '/packs/manage') }),
  }));
}

// ---------------------------------------------------------------------------------------------
// Moderation: a pending chat message goes to the room operators, with buttons
// ---------------------------------------------------------------------------------------------

/**
 * The operators of a show: its seller, and for the house show the OPERATOR_WALLETS list. Only those who linked Telegram AND switched
 * `moderation` on get the message. The text shows the bidder number and the message, never a wallet. The buttons carry signed callback data.
 */
export async function notifyModeration(messageId: string, deps: Deps = {}): Promise<number> {
  const ctx = await context(deps);
  if (!ctx) return 0;
  const db = await getDb();
  const [m] = await db
    .select({ id: chatMessages.id, body: chatMessages.body, status: chatMessages.status, paddle: chatMessages.paddleNumber, lotNumber: chatMessages.lotNumber, showId: chatMessages.showId, showTitle: shows.title, isHouse: shows.isHouse, sellerId: shows.sellerId })
    .from(chatMessages)
    .innerJoin(shows, eq(shows.id, chatMessages.showId))
    .where(eq(chatMessages.id, messageId))
    .limit(1);
  if (!m || m.status !== 'pending') return 0;
  const operatorIds = [m.sellerId];
  if (m.isHouse && operatorWallets().length > 0) {
    const rows = await db.select({ id: profiles.id }).from(profiles).where(inArray(profiles.walletAddress, operatorWallets()));
    operatorIds.push(...rows.map((r) => r.id));
  }
  const links = await linksWanting(operatorIds, 'moderation');
  return deliverAll(ctx, links, 'moderation', m.id, (l) => ({
    text: t(l.locale, 'moderation', { show: m.showTitle, paddle: m.paddle ?? '-', lotPart: m.lotNumber != null ? t(l.locale, 'moderationLot', { lot: m.lotNumber }) : '', body: m.body }),
    markup: {
      inline_keyboard: [[
        { text: t(l.locale, 'approve'), callback_data: signCallback(ctx.cfg.webhookSecret, 'approve', m.id, l.chatId) },
        { text: t(l.locale, 'reject'), callback_data: signCallback(ctx.cfg.webhookSecret, 'reject', m.id, l.chatId) },
        { text: t(l.locale, 'mute', { minutes: MUTE_MINUTES }), callback_data: signCallback(ctx.cfg.webhookSecret, 'mute', m.id, l.chatId) },
      ]],
    },
  }));
}
