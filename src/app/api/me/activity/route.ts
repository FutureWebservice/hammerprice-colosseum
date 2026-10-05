import { desc, eq, sql } from 'drizzle-orm';
import { ActivityQuery, type Cluster } from '@/contracts';
import { bids, lots, settlements, shows } from '@/db/schema';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { getDb, parseQuery } from '@/app/api/auctions/_shared/http';

const PAGE = 20;
const CONSIGN = ['none', 'pending', 'ready', 'rejected'] as const;
const offsetOf = (cursor: string | undefined): number => (/^o\d{1,6}$/.test(cursor ?? '') ? Number(cursor!.slice(1)) : 0);
const page = <T,>(rows: T[], offset: number) => ({ items: rows.slice(0, PAGE), nextCursor: rows.length > PAGE ? `o${offset + PAGE}` : null });

/** Where a bid stands: leading or outbid while the lot is open; won or lost once it sold; ended when the lot closed without a sale. */
const bidResult = (state: string, isHigh: boolean) => (state === 'open' ? (isHigh ? 'leading' : 'outbid') : state === 'sold' ? (isHigh ? 'won' : 'lost') : 'ended') as 'leading' | 'outbid' | 'won' | 'lost' | 'ended';

/** The signed-in wallet's own bids, wins (every settlement it is the buyer of, with its status) or consignments, newest first. */
export const GET = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('me-activity', session.wallet, 120, 60, { failOpen: true }));
  const q = parseQuery(req, ActivityQuery);
  const offset = offsetOf(q.cursor);
  const db = await getDb();

  if (q.tab === 'bids') {
    const rows = await db
      .select({ bidId: bids.id, lotId: bids.lotId, lotName: lots.name, amount: bids.amount, placedAt: bids.placedAt, state: lots.state, high: lots.highBidderId, closesAt: lots.closesAt })
      .from(bids).innerJoin(lots, eq(lots.id, bids.lotId))
      .where(eq(bids.bidderId, profile.id)).orderBy(desc(bids.placedAt), desc(bids.id)).limit(PAGE + 1).offset(offset);
    const { items, nextCursor } = page(rows, offset);
    return json({ tab: 'bids', items: items.map((r) => ({ bidId: r.bidId, lotId: r.lotId, lotName: r.lotName, amount: r.amount.toString(), placedAt: r.placedAt.toISOString(), leading: r.state === 'open' && r.high === profile.id, result: bidResult(r.state, r.high === profile.id), closesAt: r.closesAt?.toISOString() ?? null, lotState: r.state })), nextCursor });
  }
  if (q.tab === 'wins') {
    const rows = await db
      .select({ lotId: settlements.lotId, lotName: lots.name, gross: settlements.grossAmount, settlementId: settlements.id, status: settlements.status, tx: settlements.txSignature, cluster: settlements.cluster })
      .from(settlements).innerJoin(lots, eq(lots.id, settlements.lotId))
      .where(eq(settlements.buyerId, profile.id)).orderBy(sql`${settlements.dueAt} desc nulls last`, desc(settlements.id)).limit(PAGE + 1).offset(offset);
    const { items, nextCursor } = page(rows, offset);
    return json({
      tab: 'wins',
      items: items.map((r) => ({
        lotId: r.lotId, lotName: r.lotName, gross: r.gross.toString(), settlementId: r.settlementId, status: r.status as 'awaiting_payment',
        explorerUrl: r.tx ? explorerTxUrl(r.tx, (r.cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet') as Cluster) : null,
      })),
      nextCursor,
    });
  }
  const rows = await db
    .select({ lotId: lots.id, lotName: lots.name, mint: lots.mintAddress, state: lots.state, consign: lots.consignStatus })
    .from(lots).leftJoin(shows, eq(shows.id, lots.showId))
    .where(eq(lots.sellerId, profile.id)).orderBy(sql`${shows.createdAt} desc nulls last`, lots.lotNumber, desc(lots.id)).limit(PAGE + 1).offset(offset);
  const { items, nextCursor } = page(rows, offset);
  return json({ tab: 'consignments', items: items.map((r) => ({ ...r, consign: (CONSIGN as readonly string[]).includes(r.consign) ? (r.consign as (typeof CONSIGN)[number]) : 'none' })), nextCursor });
});
