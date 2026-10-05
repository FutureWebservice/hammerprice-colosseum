import { and, desc, eq, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Cluster, SummaryResponse } from '@/contracts';
import { lots, settlements } from '@/db/schema';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { getDb } from '@/app/api/auctions/_shared/http';

const sum = (col: AnyPgColumn) => sql<string>`coalesce(sum(${col}), 0)::text`;

/**
 * What the signed-in account bought and sold, from its own SETTLED settlements only (so a payment still open or failed never counts):
 * totals, the average and the best hammer price, and the latest sales with fee and payout. Only this account's rows are read.
 */
export const GET = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('me-summary', session.wallet, 30, 60, { failOpen: true }));
  const db = await getDb();
  const settled = (who: AnyPgColumn) => and(eq(who, profile.id), eq(settlements.status, 'settled'));
  const [[bought], [sold], best, recent] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int`, gross: sum(settlements.grossAmount) }).from(settlements).where(settled(settlements.buyerId)),
    db.select({ n: sql<number>`count(*)::int`, gross: sum(settlements.grossAmount), fees: sum(settlements.platformFee), payout: sum(settlements.sellerAmount) }).from(settlements).where(settled(settlements.sellerId)),
    db.select({ lotName: lots.name, gross: settlements.grossAmount }).from(settlements).innerJoin(lots, eq(lots.id, settlements.lotId)).where(settled(settlements.sellerId)).orderBy(desc(settlements.grossAmount), desc(settlements.id)).limit(1),
    db.select({ id: settlements.id, lotName: lots.name, gross: settlements.grossAmount, fee: settlements.platformFee, payout: settlements.sellerAmount, settledAt: settlements.settledAt, tx: settlements.txSignature, cluster: settlements.cluster })
      .from(settlements).innerJoin(lots, eq(lots.id, settlements.lotId)).where(settled(settlements.sellerId)).orderBy(sql`${settlements.settledAt} desc nulls last`, desc(settlements.id)).limit(20),
  ]);
  const avg = (total: string, n: number) => (n > 0 ? (BigInt(total) / BigInt(n)).toString() : null);
  const body: SummaryResponse = {
    bought: { count: bought.n, totalGross: bought.gross, averageGross: avg(bought.gross, bought.n) },
    sold: {
      count: sold.n, totalGross: sold.gross, totalFees: sold.fees, totalPayout: sold.payout, averageGross: avg(sold.gross, sold.n),
      best: best[0] ? { lotName: best[0].lotName, gross: best[0].gross.toString() } : null,
    },
    recentSales: recent.map((r) => ({
      settlementId: r.id, lotName: r.lotName, gross: r.gross.toString(), fee: r.fee.toString(), payout: r.payout.toString(), settledAt: r.settledAt?.toISOString() ?? null,
      explorerUrl: r.tx ? explorerTxUrl(r.tx, (r.cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet') as Cluster) : null,
    })),
  };
  return json(body);
});
