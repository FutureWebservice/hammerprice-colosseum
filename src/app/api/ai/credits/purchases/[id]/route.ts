import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { requireSessionProfile } from '@/lib/auth/session';
import { requireAi } from '@/server/ai/http';
import { getCreditService } from '@/server/credits/service';
import { chainRoute, idParam, type IdCtx } from '@/server/settlement/http';

/** One purchase of the caller's (someone else's is "not found"). Reading it finalizes a submitted payment lazily. */
export const GET = chainRoute(async (req: Request, ctx: IdCtx) => {
  await requireAi();
  const id = await idParam(ctx, 'purchase');
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('ai-purchase', session.wallet, 60, 60, { failOpen: true }));
  assertRate(await rateLimitChain(req, { failOpen: true }));
  return json(await getCreditService().getPurchase(profile.id, id));
});
