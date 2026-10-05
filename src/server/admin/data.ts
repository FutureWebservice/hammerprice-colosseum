/**
 * The admin panel's reads. Every section is the same shape (a titled table of cells, one page of at most 50 rows, an optional search and
 * tabs), so one renderer shows all of them and GET /api/admin/<section> returns exactly the same JSON the pages are built from.
 *
 * Reads only. Every query is bounded by LIMIT/OFFSET and orders by a column that is indexed or small; a count is one extra `count(*)` with the
 * same filter. Known limit: offset pagination and unindexed ORDER BY / ILIKE are fine at this size (thousands of rows); add keyset paging and
 * indexes (additive migration) when a table passes about 100,000 rows.
 */
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import type { Cluster } from '@/contracts';
import { explorerTxUrl } from '@/lib/chain/explorer';

export const PAGE_SIZE = 50;

export type Cell =
  | string | number | null
  | { text: string; href?: string; title?: string }
  | { action: 'waitlist.delete' | 'chat.reject' | 'show.cancel'; id: string; label: string; confirm: string };

export interface Section {
  key: string;
  title: string;
  columns: string[];
  rows: Cell[][];
  total: number;
  page: number;
  pageSize: number;
  q: string;
  tab?: string;
  tabs?: { key: string; label: string }[];
  note?: string;
  exportHref?: string;
}

export interface Query { page?: number; q?: string; tab?: string; filter?: string; locale?: string }

export const SECTIONS = ['overview', 'rooms', 'lots', 'history', 'users', 'cards', 'chats', 'waitlist'] as const;
export type SectionKey = (typeof SECTIONS)[number];

async function getDb() {
  return (await import('@/db')).db;
}
async function tables() {
  return (await import('@/db')).schema;
}

const like = (q: string): string => `%${q.replace(/[\\%_]/g, '\\$&')}%`;
export const ts = (d: Date | null): string => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
const usdc = (v: bigint | string | null): string => {
  if (v === null || v === undefined) return '';
  const n = BigInt(v);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} USDC`;
};
const wallet = (w: string | null): Cell => (w ? { text: `${w.slice(0, 4)}...${w.slice(-4)}`, title: w } : null);
const roomHref = (locale: string | undefined, id: string): string => `/${locale === 'de' ? 'de' : 'en'}/room/${id}`;

function clampPage(p: number | undefined): number {
  return Number.isFinite(p) && (p as number) >= 1 ? Math.min(Math.floor(p as number), 100_000) : 1;
}

interface Shape { key: SectionKey; title: string; columns: string[]; tabs?: Section['tabs']; note?: string; exportHref?: string }
function section(s: Shape, query: Query, rows: Cell[][], total: number): Section {
  return { ...s, rows, total, page: clampPage(query.page), pageSize: PAGE_SIZE, q: (query.q ?? '').slice(0, 100), tab: query.tab };
}
const paging = (query: Query) => ({ limit: PAGE_SIZE, offset: (clampPage(query.page) - 1) * PAGE_SIZE });
const search = (query: Query): string => (query.q ?? '').trim().slice(0, 100);

/** Runs `rows` and a count with the same filter side by side. */
async function counted<T>(count: () => Promise<number>, rows: () => Promise<T[]>): Promise<[number, T[]]> {
  return Promise.all([count(), rows()]);
}
const n = (v: number | string | null | undefined): number => Number(v ?? 0);

/** "last ok / last error / next retry" of the house rollover (rollover-guard.ts); a dash where nothing has happened yet. */
export function houseRolloverLine(s: { lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null; nextRetryAt: number } | null): string {
  const at = (ms: number | null) => (ms ? ts(new Date(ms)) : '-');
  const err = s?.lastError ? `${at(s.lastErrorAt)} (${s.lastError.slice(0, 80)})` : '-';
  return `${at(s?.lastOkAt ?? null)} / ${err} / ${s && s.nextRetryAt > Date.now() ? at(s.nextRetryAt) : '-'}`;
}

// ---------------------------------------------------------------------------------------------

export async function overview(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const count = async (table: PgTable, where?: SQL) => n((await db.select({ c: sql<number>`count(*)::int` }).from(table).where(where))[0]?.c);
  const [users, showsLive, showsScheduled, showsEnded, lots, bids, settlements, settled, waitlist, chatPending, aiToday, events, houseShows, aiRows, dbBytes, rollover] = await Promise.all([
    count(t.profiles, sql`not ${t.profiles.isBot}`),
    count(t.shows, eq(t.shows.status, 'live')),
    count(t.shows, eq(t.shows.status, 'scheduled')),
    count(t.shows, eq(t.shows.status, 'ended')),
    count(t.lots),
    count(t.bids),
    count(t.settlements),
    count(t.settlements, eq(t.settlements.status, 'settled')),
    count(t.waitlist),
    count(t.chatMessages, eq(t.chatMessages.status, 'pending')),
    db.select({ calls: sql<number>`count(*)::int`, cost: sql<number>`coalesce(sum(${t.aiUsage.costMicroUsd}), 0)::bigint` }).from(t.aiUsage)
      .where(sql`${t.aiUsage.createdAt} >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`),
    count(t.showEvents),
    count(t.shows, eq(t.shows.isHouse, true)),
    count(t.aiUsage),
    db.execute(sql`select pg_database_size(current_database())::bigint as bytes`).then((r) => n((r as unknown as { rows: { bytes: string }[] }).rows[0]?.bytes)),
    import('@/server/house/rollover-guard').then((g) => g.readRolloverState(g.dbFlagStore(db))),
  ]);
  const ai = aiToday[0];
  const rows: Cell[][] = [
    ['Users (without house bots)', users],
    ['Shows live', showsLive],
    ['Shows scheduled', showsScheduled],
    ['Shows ended (or cancelled)', showsEnded],
    ['Lots', lots],
    ['Bids', bids],
    ['Settlements (all / settled)', `${settlements} / ${settled}`],
    ['Waiting list entries', waitlist],
    ['Chat messages waiting for approval', chatPending],
    ['AI calls today (UTC)', n(ai?.calls)],
    ['AI cost today (UTC)', `${(n(ai?.cost) / 1_000_000).toFixed(4)} USD`],
    // Capacity: what grows. The house rooms are pruned by the daily sweep after HOUSE_RETENTION_DAYS (default 7).
    ['House (demo) shows kept', houseShows],
    ['House rollover (last ok / last error / next retry)', houseRolloverLine(rollover)],
    ['Show events (rows)', events],
    ['AI usage rows', aiRows],
    ['Database size (MB, as Postgres counts it; compare with the plan limit on the Neon dashboard)', Math.round(dbBytes / 1_048_576)],
  ];
  return section({ key: 'overview', title: 'Overview', columns: ['What', 'Count'] }, query, rows, rows.length);
}

export async function rooms(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const q = search(query);
  const where = q ? or(ilike(t.shows.title, like(q)), ilike(t.profiles.walletAddress, like(q))) : undefined;
  const [total, list] = await counted(
    async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.shows).innerJoin(t.profiles, eq(t.profiles.id, t.shows.sellerId)).where(where))[0]?.c),
    () => db.select({
      id: t.shows.id, title: t.shows.title, status: t.shows.status, kind: t.shows.kind, isHouse: t.shows.isHouse, cancelledAt: t.shows.cancelledAt,
      createdAt: t.shows.createdAt, seller: t.profiles.walletAddress,
      lots: sql<number>`(select count(*)::int from lots l where l.show_id = ${t.shows.id})`,
      hammer: sql<string>`(select coalesce(sum(l.high_bid), 0)::text from lots l where l.show_id = ${t.shows.id} and l.state = 'sold')`,
    }).from(t.shows).innerJoin(t.profiles, eq(t.profiles.id, t.shows.sellerId)).where(where).orderBy(desc(t.shows.createdAt)).limit(paging(query).limit).offset(paging(query).offset),
  );
  const rows = list.map((r): Cell[] => [
    { text: r.title, href: roomHref(query.locale, r.id), title: r.id },
    r.cancelledAt ? 'cancelled' : r.status, r.isHouse ? 'house' : r.kind, wallet(r.seller), n(r.lots), usdc(r.hammer), ts(r.createdAt),
    r.status === 'scheduled' && !r.cancelledAt ? { action: 'show.cancel', id: r.id, label: 'Cancel show', confirm: 'Cancel this show? Its seller is told it was cancelled.' } : null,
  ]);
  return section({ key: 'rooms', title: 'Rooms', columns: ['Room', 'Status', 'Kind', 'Seller', 'Lots', 'Hammer total', 'Created', ''] }, query, rows, total);
}

export async function lots(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const winner = alias(t.profiles, 'winner');
  const seller = alias(t.profiles, 'lot_seller');
  const q = search(query);
  const where = q ? or(ilike(t.lots.name, like(q)), ilike(t.lots.mintAddress, like(q)), ilike(seller.walletAddress, like(q)), ilike(t.shows.title, like(q))) : undefined;
  const live = inArray(t.settlements.status, ['awaiting_payment', 'awaiting_seller', 'submitted', 'settled']);
  const [total, list] = await counted(
    async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.lots).innerJoin(seller, eq(seller.id, t.lots.sellerId)).leftJoin(t.shows, eq(t.shows.id, t.lots.showId)).where(where))[0]?.c),
    () => db.select({
      id: t.lots.id, showId: t.lots.showId, showTitle: t.shows.title, number: t.lots.lotNumber, name: t.lots.name, state: t.lots.state, highBid: t.lots.highBid,
      winner: winner.walletAddress, settlement: t.settlements.status, tx: t.settlements.txSignature, cluster: t.settlements.cluster,
    }).from(t.lots)
      .innerJoin(seller, eq(seller.id, t.lots.sellerId))
      .leftJoin(t.shows, eq(t.shows.id, t.lots.showId))
      .leftJoin(winner, eq(winner.id, t.lots.highBidderId))
      .leftJoin(t.settlements, and(eq(t.settlements.lotId, t.lots.id), live))
      .where(where)
      .orderBy(sql`coalesce(${t.lots.openedAt}, ${t.lots.closedAt}) desc nulls last`, t.lots.id)
      .limit(paging(query).limit).offset(paging(query).offset),
  );
  const rows = list.map((r): Cell[] => [
    r.showId ? { text: r.showTitle ?? r.showId, href: roomHref(query.locale, r.showId) } : '', r.number, r.name, r.state, usdc(r.highBid), wallet(r.winner), r.settlement ?? '',
    r.tx ? { text: 'transaction', href: explorerTxUrl(r.tx, (r.cluster ?? 'devnet') as Cluster) } : null,
  ]);
  return section({ key: 'lots', title: 'Auctions and lots', columns: ['Room', 'No.', 'Card', 'State', 'Current bid', 'Winner', 'Settlement', 'Tx'] }, query, rows, total);
}

export async function history(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const tab = ['settlements', 'bids', 'audit'].includes(query.tab ?? '') ? (query.tab as string) : 'settlements';
  const q = search(query);
  const tabs = [{ key: 'settlements', label: 'Settlements' }, { key: 'bids', label: 'Bids' }, { key: 'audit', label: 'Audit log' }];
  const shape = (columns: string[]): Shape => ({ key: 'history', title: 'History', columns, tabs });
  const { limit, offset } = paging(query);
  const cnt = async (from: Promise<{ c: number }[]>) => n((await from)[0]?.c);

  if (tab === 'bids') {
    const where = q ? or(ilike(t.profiles.walletAddress, like(q)), ilike(t.lots.name, like(q))) : undefined;
    const [total, list] = await counted(
      () => cnt(db.select({ c: sql<number>`count(*)::int` }).from(t.bids).innerJoin(t.profiles, eq(t.profiles.id, t.bids.bidderId)).innerJoin(t.lots, eq(t.lots.id, t.bids.lotId)).where(where)),
      () => db.select({ at: t.bids.placedAt, lot: t.lots.name, bidder: t.profiles.walletAddress, amount: t.bids.amount, via: t.bids.via }).from(t.bids)
        .innerJoin(t.profiles, eq(t.profiles.id, t.bids.bidderId)).innerJoin(t.lots, eq(t.lots.id, t.bids.lotId)).where(where).orderBy(desc(t.bids.placedAt)).limit(limit).offset(offset),
    );
    return section(shape(["Placed", "Card", "Bidder", "Amount", "Via"]), { ...query, tab }, list.map((r): Cell[] => [ts(r.at), r.lot, wallet(r.bidder), usdc(r.amount), r.via]), total);
  }
  if (tab === 'audit') {
    const where = q ? or(ilike(t.auditLogs.action, like(q)), ilike(t.auditLogs.actorWallet, like(q)), ilike(t.auditLogs.target, like(q))) : undefined;
    const [total, list] = await counted(
      () => cnt(db.select({ c: sql<number>`count(*)::int` }).from(t.auditLogs).where(where)),
      () => db.select().from(t.auditLogs).where(where).orderBy(desc(t.auditLogs.createdAt)).limit(limit).offset(offset),
    );
    return section(shape(['When', 'Action', 'Actor', 'Target', 'Detail']), { ...query, tab }, list.map((r): Cell[] => [ts(r.createdAt), r.action, wallet(r.actorWallet), r.target ?? '', r.detail == null ? '' : JSON.stringify(r.detail).slice(0, 160)]), total);
  }
  const buyer = alias(t.profiles, 'buyer');
  const seller = alias(t.profiles, 'seller');
  const where = q ? or(ilike(buyer.walletAddress, like(q)), ilike(seller.walletAddress, like(q)), ilike(t.lots.name, like(q)), ilike(t.settlements.txSignature, like(q))) : undefined;
  const [total, list] = await counted(
    () => cnt(db.select({ c: sql<number>`count(*)::int` }).from(t.settlements).innerJoin(t.lots, eq(t.lots.id, t.settlements.lotId)).innerJoin(buyer, eq(buyer.id, t.settlements.buyerId)).innerJoin(seller, eq(seller.id, t.settlements.sellerId)).where(where)),
    () => db.select({
      lot: t.lots.name, buyer: buyer.walletAddress, seller: seller.walletAddress, gross: t.settlements.grossAmount, fee: t.settlements.platformFee, status: t.settlements.status,
      settledAt: t.settlements.settledAt, dueAt: t.settlements.dueAt, tx: t.settlements.txSignature, cluster: t.settlements.cluster,
    }).from(t.settlements).innerJoin(t.lots, eq(t.lots.id, t.settlements.lotId)).innerJoin(buyer, eq(buyer.id, t.settlements.buyerId)).innerJoin(seller, eq(seller.id, t.settlements.sellerId))
      .where(where).orderBy(sql`coalesce(${t.settlements.settledAt}, ${t.settlements.dueAt}) desc nulls last`, t.settlements.id).limit(limit).offset(offset),
  );
  return section(shape(['Card', 'Buyer', 'Seller', 'Gross', 'Fee', 'Status', 'Settled', 'Tx']), { ...query, tab }, list.map((r): Cell[] => [
    r.lot, wallet(r.buyer), wallet(r.seller), usdc(r.gross), usdc(r.fee), r.status, ts(r.settledAt),
    r.tx ? { text: 'transaction', href: explorerTxUrl(r.tx, (r.cluster ?? 'devnet') as Cluster) } : null,
  ]), total);
}

export async function users(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const q = search(query);
  const where = q ? or(ilike(t.profiles.walletAddress, like(q)), ilike(t.profiles.username, like(q)), ilike(t.profiles.displayName, like(q))) : undefined;
  const [total, list] = await counted(
    async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.profiles).where(where))[0]?.c),
    () => db.select({
      wallet: t.profiles.walletAddress, username: t.profiles.username, displayName: t.profiles.displayName, isSeller: t.profiles.isSeller, isBanned: t.profiles.isBanned,
      isBot: t.profiles.isBot, strikes: t.profiles.strikes, createdAt: t.profiles.createdAt, lastSeen: t.profiles.updatedAt,
      bids: sql<number>`(select count(*)::int from bids b where b.bidder_id = profiles.id)`,
      wins: sql<number>`(select count(*)::int from lots l where l.high_bidder_id = profiles.id and l.state = 'sold')`,
    }).from(t.profiles).where(where).orderBy(desc(t.profiles.createdAt)).limit(paging(query).limit).offset(paging(query).offset),
  );
  return section({ key: 'users', title: 'Users', columns: ['Wallet', 'Profile', 'Seller', 'Strikes', 'Created', 'Last sign-in', 'Bids', 'Wins'] }, query, list.map((r): Cell[] => [
    r.wallet, [r.displayName ?? r.username ?? '', r.isBot ? '(house bot)' : '', r.isBanned ? '(banned)' : ''].filter(Boolean).join(' '), r.isSeller ? 'yes' : '', r.strikes, ts(r.createdAt), ts(r.lastSeen), n(r.bids), n(r.wins),
  ]), total);
}

export async function cards(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const tab = query.tab === 'minted' ? 'minted' : 'lots';
  const tabs = [{ key: 'lots', label: 'In lots' }, { key: 'minted', label: 'Minted (devnet)' }];
  const q = search(query);
  const { limit, offset } = paging(query);
  if (tab === 'minted') {
    const where = q ? or(ilike(t.devnetAssets.name, like(q)), ilike(t.devnetAssets.mint, like(q)), ilike(t.devnetAssets.ownerWallet, like(q))) : undefined;
    const [total, list] = await counted(
      async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.devnetAssets).where(where))[0]?.c),
      () => db.select().from(t.devnetAssets).where(where).orderBy(desc(t.devnetAssets.mintedAt)).limit(limit).offset(offset),
    );
    return section({ key: 'cards', title: 'Cards', columns: ['Card', 'Mint', 'Owner (minted to)', 'Minted'], tabs }, { ...query, tab }, list.map((r): Cell[] => [r.name, { text: `${r.mint.slice(0, 4)}...${r.mint.slice(-4)}`, title: r.mint }, wallet(r.ownerWallet), ts(r.mintedAt)]), total);
  }
  const seller = alias(t.profiles, 'card_seller');
  const buyer = alias(t.profiles, 'card_buyer');
  const where = q ? or(ilike(t.lots.name, like(q)), ilike(t.lots.mintAddress, like(q)), ilike(seller.walletAddress, like(q))) : undefined;
  const [total, list] = await counted(
    async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.lots).innerJoin(seller, eq(seller.id, t.lots.sellerId)).where(where))[0]?.c),
    () => db.select({
      name: t.lots.name, setName: t.lots.setName, grade: t.lots.grade, gradingCompany: t.lots.gradingCompany, mint: t.lots.mintAddress, state: t.lots.state, consign: t.lots.consignStatus,
      seller: seller.walletAddress, buyer: buyer.walletAddress,
    }).from(t.lots)
      .innerJoin(seller, eq(seller.id, t.lots.sellerId))
      .leftJoin(t.settlements, and(eq(t.settlements.lotId, t.lots.id), eq(t.settlements.status, 'settled')))
      .leftJoin(buyer, eq(buyer.id, t.settlements.buyerId))
      .where(where).orderBy(sql`coalesce(${t.lots.openedAt}, ${t.lots.closedAt}) desc nulls last`, t.lots.id).limit(limit).offset(offset),
  );
  // The owner is the buyer once the sale settled on chain, otherwise still the seller.
  return section({ key: 'cards', title: 'Cards', columns: ['Card', 'Grade', 'Mint', 'Owner', 'State', 'Consignment'], tabs }, { ...query, tab }, list.map((r): Cell[] => [
    [r.name, r.setName].filter(Boolean).join(', '), [r.gradingCompany, r.grade].filter(Boolean).join(' '), { text: `${r.mint.slice(0, 4)}...${r.mint.slice(-4)}`, title: r.mint }, wallet(r.buyer ?? r.seller), r.state, r.consign,
  ]), total);
}

export async function chats(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const author = alias(t.profiles, 'chat_author');
  const filter = ['pending', 'reported', 'rejected', 'approved'].includes(query.tab ?? '') ? (query.tab as string) : 'all';
  const tabs = [{ key: 'all', label: 'All' }, { key: 'pending', label: 'Pending' }, { key: 'reported', label: 'Reported' }, { key: 'rejected', label: 'Rejected' }, { key: 'approved', label: 'Approved' }];
  const q = search(query);
  const reported = sql`exists (select 1 from chat_reports r where r.message_id = ${t.chatMessages.id} and r.status = 'open')`;
  const where = and(
    filter === 'reported' ? reported : filter === 'all' ? undefined : eq(t.chatMessages.status, filter),
    q ? or(ilike(t.chatMessages.body, like(q)), ilike(t.shows.title, like(q)), ilike(author.walletAddress, like(q))) : undefined,
  );
  const [total, list] = await counted(
    async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.chatMessages).innerJoin(t.shows, eq(t.shows.id, t.chatMessages.showId)).innerJoin(author, eq(author.id, t.chatMessages.authorId)).where(where))[0]?.c),
    () => db.select({
      id: t.chatMessages.id, showId: t.chatMessages.showId, showTitle: t.shows.title, at: t.chatMessages.createdAt, status: t.chatMessages.status, body: t.chatMessages.body,
      author: author.walletAddress, role: t.chatMessages.role,
      reports: sql<number>`(select count(*)::int from chat_reports r where r.message_id = ${t.chatMessages.id} and r.status = 'open')`,
    }).from(t.chatMessages).innerJoin(t.shows, eq(t.shows.id, t.chatMessages.showId)).innerJoin(author, eq(author.id, t.chatMessages.authorId))
      .where(where).orderBy(desc(t.chatMessages.createdAt)).limit(paging(query).limit).offset(paging(query).offset),
  );
  return section({ key: 'chats', title: 'Chats', columns: ['When', 'Room', 'Author', 'Status', 'Reports', 'Message', ''], tabs }, { ...query, tab: filter }, list.map((r): Cell[] => [
    ts(r.at), { text: r.showTitle, href: roomHref(query.locale, r.showId) }, wallet(r.author), r.status, n(r.reports), r.body,
    r.status === 'rejected' ? null : { action: 'chat.reject', id: r.id, label: 'Reject', confirm: 'Hide this message? The author sees it as rejected.' },
  ]), total);
}

export const WAITLIST_EXPORT_MAX = 10_000;

export async function waitlist(query: Query): Promise<Section> {
  const db = await getDb();
  const t = await tables();
  const q = search(query);
  const where = q ? ilike(t.waitlist.email, like(q)) : undefined;
  const [total, list] = await counted(
    async () => n((await db.select({ c: sql<number>`count(*)::int` }).from(t.waitlist).where(where))[0]?.c),
    () => db.select().from(t.waitlist).where(where).orderBy(desc(t.waitlist.createdAt)).limit(paging(query).limit).offset(paging(query).offset),
  );
  return section({ key: 'waitlist', title: 'Waiting list', columns: ['Email', 'Date', 'Language', 'Source', ''], exportHref: '/api/admin/waitlist/export', note: `${total} ${q ? 'matching ' : ''}entries` }, query, list.map((r): Cell[] => [
    r.email, ts(r.createdAt), r.locale, r.source ?? '', { action: 'waitlist.delete', id: r.id, label: 'Delete', confirm: 'Delete this entry for good?' },
  ]), total);
}

/** The whole list as CSV (newest first, at most WAITLIST_EXPORT_MAX rows). A cell that a spreadsheet would read as a formula gets a leading apostrophe. */
export async function waitlistCsv(): Promise<string> {
  const db = await getDb();
  const t = await tables();
  const list = await db.select().from(t.waitlist).orderBy(desc(t.waitlist.createdAt)).limit(WAITLIST_EXPORT_MAX);
  const cell = (v: string): string => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  return ['email,created_at,locale,source', ...list.map((r) => [r.email, r.createdAt.toISOString(), r.locale, r.source ?? ''].map(cell).join(','))].join('\r\n') + '\r\n';
}

const LOADERS: Record<SectionKey, (q: Query) => Promise<Section>> = { overview, rooms, lots, history, users, cards, chats, waitlist };
export const isSection = (s: string): s is SectionKey => (SECTIONS as readonly string[]).includes(s);
export const loadSection = (key: SectionKey, query: Query): Promise<Section> => LOADERS[key](query);
