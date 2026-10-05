import { ApiError, PrepareRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { chainRoute, idParam, type IdCtx } from '@/server/settlement/http';
import { flagOn } from '@/app/api/auctions/_shared/flags';
import { getSettlementService } from '@/server/settlement/service';

/** Opens a signing round (or returns the live one, same message). Buyer or seller only. */
export const POST = chainRoute(async (req: Request, ctx: IdCtx) => {
  const id = await idParam(ctx, 'settlement');
  if (!(await flagOn('settlement'))) throw new ApiError('paused', 'Settlement is switched off for now');
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('settle-prepare', session.wallet, 6, 60));
  assertRate(await rateLimitChain(req));
  await readBody(req, PrepareRequest);
  return json(await getSettlementService().prepareSettlement(id, profile.id));
});
