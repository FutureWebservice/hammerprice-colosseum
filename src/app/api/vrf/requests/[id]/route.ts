import { ApiError, ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { getView } from '@/server/vrf/service';
import { requireVrf, vrfId, type IdCtx } from '../../_shared';

/** The public face of one draw: everything a visitor needs to recompute it (no transaction bytes, no lease). */
export const GET = route(async (req: Request, ctx: IdCtx) => {
  await requireVrf();
  assertRate(await rateLimitIp('vrf-read', req, 120, 60, { failOpen: true }));
  const view = await getView(await vrfId(ctx));
  if (!view) throw new ApiError('not_found', 'No such draw');
  return json(view, ROUTES.vrfRequest.cache);
});
