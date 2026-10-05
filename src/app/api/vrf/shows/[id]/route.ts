import { ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { showDraws } from '@/server/vrf/service';
import { requireVrf, vrfId, type IdCtx } from '../../_shared';

/** The draws that belong to a show (its lot order, its thank-you draw): the chip and the verify page find their request id here. */
export const GET = route(async (req: Request, ctx: IdCtx) => {
  await requireVrf();
  assertRate(await rateLimitIp('vrf-read', req, 120, 60, { failOpen: true }));
  return json(await showDraws(await vrfId(ctx)), ROUTES.vrfShow.cache);
});
