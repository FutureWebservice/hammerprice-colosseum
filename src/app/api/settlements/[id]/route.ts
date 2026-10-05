import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { requireSessionProfile } from '@/lib/auth/session';
import { chainRoute, idParam, type IdCtx } from '@/server/settlement/http';
import { getSettlementService } from '@/server/settlement/service';

/** One settlement as its buyer or seller sees it. A read finalizes lazily: a transaction that landed becomes `settled` here. */
export const GET = chainRoute(async (req: Request, ctx: IdCtx) => {
  const id = await idParam(ctx, 'settlement');
  const { session, profile } = await requireSessionProfile(req);
  // The room polls this while a round is open; a read is not worth an outage if the limiter's database is down.
  assertRate(await rateLimitWallet('settle-read', session.wallet, 120, 60, { failOpen: true }));
  return json(await getSettlementService().getSettlement(id, profile.id));
});
