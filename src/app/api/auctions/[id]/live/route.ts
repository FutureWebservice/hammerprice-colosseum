import { ApiError, ROUTES, type LiveSnapshot } from '@/contracts';
import { json } from '@/lib/http/respond';
import { createMemo, snapshotMemoMs } from '@/lib/http/memo';
import { route } from '@/lib/auth/route';
import { auctionService } from '@/app/api/auctions/_shared/deps';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';

const snapshots = createMemo<LiveSnapshot | null>(snapshotMemoMs());

/**
 * The polled snapshot. Identical for every viewer, so Vercel's CDN may serve it for 1 s
 * (`Vercel-CDN-Cache-Control: max-age=1`, no stale-while-revalidate: a lone viewer must never see the previous poll's state)
 * while the browser always asks again. The engine closes a due lot lazily on this read: one cheap query to see whether anything
 * is due, then the two snapshot queries. On the house show an idle lot may also get a house bid (src/server/house/bots-service.ts),
 * which costs no query unless the pure decision says a bid is due.
 * The whole answer is shared per show for 500 ms inside an instance (LIVE_SNAPSHOT_MEMO_MS), so database work no longer grows with viewers.
 */
export const GET = route(async (_req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  // One load per show per half second per instance, however many viewers (or cache-busting query strings) ask: see lib/http/memo.ts.
  const body = await snapshots.get(showId, async () => {
    const snapshot = await auctionService().getLiveSnapshot(showId);
    if (!snapshot) return null;
    const live = snapshot.show.isHouse && snapshot.show.status !== 'ended' ? await (await import('@/server/house/bots-service')).maybeHouseBid(snapshot) : null;
    return live ?? snapshot;
  });
  if (!body) throw new ApiError('not_found', 'Show not found');
  return json(body, ROUTES.auctionLive.cache);
});
