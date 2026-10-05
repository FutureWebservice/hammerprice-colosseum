import { and, desc, eq, sql } from 'drizzle-orm';
import { ShowsQuery, type ShowSummary } from '@/contracts';
import { lots, shows } from '@/db/schema';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { getDb, parseQuery } from '@/app/api/auctions/_shared/http';

/** The shows this wallet runs (as seller), newest first, in the same summary shape as the public schedule. */
export const GET = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('me-shows', session.wallet, 120, 60, { failOpen: true }));
  const q = parseQuery(req, ShowsQuery);
  const offset = /^o\d{1,6}$/.test(q.cursor ?? '') ? Number(q.cursor!.slice(1)) : 0;
  const db = await getDb();
  const rows = await db
    .select({
      id: shows.id, title: shows.title, status: shows.status, scheduledAt: shows.scheduledAt, startedAt: shows.startedAt, endedAt: shows.endedAt, cluster: shows.cluster, isHouse: shows.isHouse, kind: shows.kind,
      lotCount: sql<number>`count(${lots.id})::int`,
      soldCount: sql<number>`(count(${lots.id}) filter (where ${lots.state} = 'sold'))::int`,
      hammerTotal: sql<string>`coalesce(sum(${lots.highBid}) filter (where ${lots.state} = 'sold'), 0)::text`,
      thumbs: sql<string[]>`coalesce((array_agg(${lots.imageUrl} order by ${lots.lotNumber}) filter (where ${lots.imageUrl} is not null))[1:4], '{}')`,
    })
    .from(shows).leftJoin(lots, eq(lots.showId, shows.id))
    .where(and(eq(shows.sellerId, profile.id), q.status ? eq(shows.status, q.status) : undefined, q.kind ? eq(shows.kind, q.kind) : undefined))
    .groupBy(shows.id).orderBy(desc(shows.createdAt), desc(shows.id)).limit(q.limit + 1).offset(offset);
  const list: ShowSummary[] = rows.slice(0, q.limit).map((r) => ({
    id: r.id, title: r.title, status: r.status, scheduledAt: r.scheduledAt?.toISOString() ?? null, startedAt: r.startedAt?.toISOString() ?? null, endedAt: r.endedAt?.toISOString() ?? null,
    lotCount: Number(r.lotCount), soldCount: Number(r.soldCount), hammerTotal: String(r.hammerTotal),
    cluster: r.cluster === 'devnet' || r.cluster === 'mainnet-beta' ? r.cluster : null, isHouse: r.isHouse, thumbs: r.thumbs ?? [], kind: r.kind === 'timed' ? 'timed' : 'live',
  }));
  return json({ shows: list, nextCursor: rows.length > q.limit ? `o${offset + q.limit}` : null });
});
