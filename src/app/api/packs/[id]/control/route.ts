import { PackControlRequest } from '@/contracts';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { paramId, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** The operator's controls: publish (commits the pool), pause, resume, close. Publishing reads every card from the chain. */
export const maxDuration = 60;
export const POST = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'pack');
  const { session, profile } = await requireSessionProfile(req);
  const { action } = await readBody(req, PackControlRequest);
  assertRate(await rateLimitWallet('pack-control', session.wallet, 30, 3600));
  if (action === 'publish') assertRate(await rateLimitChain(req));
  return json({ pack: await getPackService().control(id, profile.id, action) });
});
