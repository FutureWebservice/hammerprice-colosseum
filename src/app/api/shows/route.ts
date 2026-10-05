import { ApiError, CreateShowRequest, ROUTES, ShowsQuery } from '@/contracts';
import type { AssetReadiness } from '@/contracts';
import { resolveCluster } from '@/lib/chain/config';
import { assertClusterReady } from '@/lib/chain/cluster';
import { json } from '@/lib/http/respond';
import { assertSellerAllowed } from './seller-allowlist';
import { houseSweep } from '@/server/house/sweep';
import { startHousekeeping } from '@/server/housekeeping';
import { createMemo, snapshotMemoMs } from '@/lib/http/memo';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { auctionService, chainService } from '@/app/api/auctions/_shared/deps';
import { getDb, parseQuery } from '@/app/api/auctions/_shared/http';

/** The schedule: live, upcoming and ended shows. Reading it is also what keeps the house room alive (src/server/house/rollover.ts). */
const listings = createMemo<Awaited<ReturnType<ReturnType<typeof auctionService>['listShows']>>>(snapshotMemoMs() * 4);

export const maxDuration = 60; // the background housekeeping pass (src/server/housekeeping.ts) runs inside this request's lifetime

export const GET = route(async (req: Request) => {
  const q = parseQuery(req, ShowsQuery);
  startHousekeeping();
  // Shared for 2 s per distinct query inside an instance (lib/http/memo.ts): a caller who varies cursor or limit to dodge the CDN costs one load per key, not per request.
  const key = JSON.stringify([q.status ?? null, q.kind ?? null, q.house ?? null, q.limit, q.cursor ?? null]);
  return json(await listings.get(key, async () => {
    if (q.status !== 'ended') await houseSweep();
    return auctionService().listShows(q);
  }), ROUTES.showsList.cache);
});

/** Readiness for every mint, five at a time so a 30-lot show stays inside the public RPC's request budget. */
async function readinessMap(mints: string[], seller: string): Promise<Record<string, AssetReadiness>> {
  const cluster = resolveCluster();
  const out: Record<string, AssetReadiness> = {};
  for (let i = 0; i < mints.length; i += 5) {
    const batch = mints.slice(i, i + 5);
    const done = await Promise.all(batch.map((m) => chainService().readiness(m, seller, cluster)));
    batch.forEach((m, n) => { out[m] = done[n]; });
  }
  return out;
}

/** Create a scheduled show with its lots in one transaction. Cards that cannot be consigned are refused with the readiness reason as the code. */
export const POST = route(async (req: Request) => {
  assertClusterReady();
  const { session, profile } = await requireSessionProfile(req);
  assertSellerAllowed(session.wallet);
  const body = await readBody(req, CreateShowRequest);
  // How long a winner has to sign is the platform's term (SETTLEMENT_WINDOW_S, shown in the legal pages), not the seller's: a 60 s window would strike
  // every buyer who is not instantly ready (20 strikes ban the wallet) and a 7 day one would keep a buyer's funds counted as owed for a week.
  if (body.rules?.settlementWindowS !== undefined) throw new ApiError('validation', 'rules.settlementWindowS: the platform sets the settlement window, not the seller');
  // A timed auction is one card per show, so 5 cards are 5 shows: 10 a day (its own counter, so it never uses up the live allowance).
  assertRate(body.kind === 'timed' ? await rateLimitWallet('show-create-timed', session.wallet, 10, 86_400) : await rateLimitWallet('show-create', session.wallet, 3, 86_400));
  assertRate(await rateLimitChain(req));
  const mints = body.lots.map((l) => l.mint);
  const readiness = await readinessMap(mints, session.wallet);
  // Card facts for devnet replicas (name, photo, set, grade) come from devnet_assets; anything else gets the engine's neutral name.
  const { replicaCards, replicaMeta } = await import('@/server/house/inventory');
  const assets = Object.fromEntries((await replicaCards(await getDb(), mints)).map((c) => [c.mint, replicaMeta(c)]));
  const detail = await auctionService().createShow({ ...body, sellerProfileId: profile.id, readiness, assets });
  return json(detail, 'none', { status: 201 });
});
