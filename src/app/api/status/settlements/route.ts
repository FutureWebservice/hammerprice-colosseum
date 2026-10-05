import { desc, and, eq, isNotNull } from 'drizzle-orm';
import { type Cluster, ROUTES, StatusSettlementsQuery } from '@/contracts';
import { lots, settlements } from '@/db/schema';
import { explorerTxUrl } from '@/lib/chain/explorer';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { getDb, parseQuery } from '@/app/api/auctions/_shared/http';

/** The newest settled sales with their explorer links. Only rows the chain layer verified (status settled, with a transaction); nothing is invented. */
export const GET = route(async (req: Request) => {
  const { limit } = parseQuery(req, StatusSettlementsQuery);
  const rows = await (await getDb())
    .select({ at: settlements.settledAt, lotName: lots.name, gross: settlements.grossAmount, tx: settlements.txSignature, cluster: settlements.cluster })
    .from(settlements).innerJoin(lots, eq(lots.id, settlements.lotId))
    .where(and(eq(settlements.status, 'settled'), isNotNull(settlements.txSignature), isNotNull(settlements.settledAt)))
    .orderBy(desc(settlements.settledAt)).limit(limit);
  return json(
    { items: rows.map((r) => ({ at: r.at!.toISOString(), lotName: r.lotName, amount: r.gross.toString(), txSignature: r.tx!, explorerUrl: explorerTxUrl(r.tx!, (r.cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet') as Cluster) })) },
    ROUTES.statusSettlements.cache,
  );
});
