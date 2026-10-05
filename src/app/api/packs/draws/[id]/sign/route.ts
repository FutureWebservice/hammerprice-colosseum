import { SignInput } from '@/contracts';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { paramId, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** The second signature sends the transaction and polls up to 20 s for it to land. */
export const maxDuration = 30;

/** Stores this party's signature over the prepared message; `role: 'seller'` is the pack operator. The session decides who is signing, the body alone never does. */
export const POST = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'draw');
  const { session, profile } = await requireSessionProfile(req);
  const input = await readBody(req, SignInput);
  assertRate(await rateLimitWallet('pack-sign', session.wallet, 20, 60));
  assertRate(await rateLimitChain(req));
  return json(await getPackService().signDraw(id, profile.id, input));
});
