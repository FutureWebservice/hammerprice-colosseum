import { PrepareRequest } from '@/contracts';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { paramId, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** Opens a signing round (or returns the live one, same message). The buyer or the operator of the draw only. */
export const POST = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'draw');
  const { session, profile } = await requireSessionProfile(req);
  await readBody(req, PrepareRequest);
  assertRate(await rateLimitWallet('pack-prepare', session.wallet, 6, 60));
  assertRate(await rateLimitChain(req));
  return json(await getPackService().prepareDraw(id, profile.id));
});
