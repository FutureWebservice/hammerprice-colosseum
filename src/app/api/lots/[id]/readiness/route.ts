import { ReadinessRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { chainRoute, idParam, type IdCtx } from '@/server/settlement/http';
import { getSettlementService } from '@/server/settlement/service';

/**
 * Consign is a read, not a signature: the server looks at the card on chain (owner, frozen, standard, transfer rules) and
 * sets the lot's consign status. An ineligible card is a normal answer (`readiness.eligible: false` with reasons), not an error.
 */
export const POST = chainRoute(async (req: Request, ctx: IdCtx) => {
  const id = await idParam(ctx, 'lot');
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('readiness', session.wallet, 30, 60));
  assertRate(await rateLimitChain(req));
  await readBody(req, ReadinessRequest);
  return json({ ok: true, ...(await getSettlementService().checkReadiness(id, profile.id)) });
});
