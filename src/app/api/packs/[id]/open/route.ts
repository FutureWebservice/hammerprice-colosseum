import { PackOpenRequest } from '@/contracts';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { paramId, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

export const maxDuration = 30;

/**
 * Buying a pack: records the 18+ confirmation, draws (ECVRF, public proof), reserves the card and opens the signing round. The per-wallet daily
 * cap of the pack is enforced inside the service (it counts every draw); this adds the per-minute limits.
 */
export const POST = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'pack');
  const { session, profile } = await requireSessionProfile(req);
  const input = await readBody(req, PackOpenRequest); // ageConfirmed must be the literal true: a request without it never reaches the service
  assertRate(await rateLimitWallet('pack-open', session.wallet, 5, 60));
  assertRate(await rateLimitChain(req));
  return json(await getPackService().open({ id: profile.id, wallet: profile.walletAddress }, id, input));
});
