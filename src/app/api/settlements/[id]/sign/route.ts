import { ApiError, SignInput } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { chainRoute, idParam, type IdCtx } from '@/server/settlement/http';
import { flagOn } from '@/app/api/auctions/_shared/flags';
import { getSettlementService } from '@/server/settlement/service';

/** The second signature sends the transaction and polls up to 20 s for it to land. */
export const maxDuration = 30;

/**
 * Stores this party's signature over the prepared message. The role in the body must be the session's own side of the
 * settlement (the service compares the session profile with the settlement's buyer and seller and answers not_party
 * otherwise); the body alone never decides who is signing.
 */
export const POST = chainRoute(async (req: Request, ctx: IdCtx) => {
  const id = await idParam(ctx, 'settlement');
  if (!(await flagOn('settlement'))) throw new ApiError('paused', 'Settlement is switched off for now');
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('settle-sign', session.wallet, 20, 60)); // each stored pair of signatures costs RPC calls
  assertRate(await rateLimitChain(req));
  const input = await readBody(req, SignInput);
  return json(await getSettlementService().signSettlement(id, profile.id, input));
});
