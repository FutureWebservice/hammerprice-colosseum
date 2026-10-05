import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { requireSessionProfile } from '@/lib/auth/session';
import { requireAi } from '@/server/ai/http';
import { getCreditService } from '@/server/credits/service';
import { chainRoute } from '@/server/settlement/http';

/** Balance, the pack (10 drafts for 1 USDC), how many packs are left today, the cluster and whether a model is configured. */
export const GET = chainRoute(async (req: Request) => {
  await requireAi();
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('ai-credits', session.wallet, 60, 60, { failOpen: true }));
  return json(await getCreditService().overview(profile.id));
});
