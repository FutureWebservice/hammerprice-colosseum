import { ApiError, ROUTES, VrfAdvanceRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { readBody, route } from '@/lib/auth/route';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { assertClusterReady } from '@/lib/chain/cluster';
import { ConfigError } from '@/lib/chain/errors';
import { advance, defaultDeps, getRow } from '@/server/vrf/service';
import { requireVrf, vrfId, type IdCtx } from '../../../_shared';

export const maxDuration = 60;

/**
 * Moves a draw one or more steps along its own state machine. Public and idempotent: it can only do what the draw's rules already require
 * (send the commit, send the reveal, record the outcome), and a lease makes parallel callers harmless. The room chip calls it every few
 * seconds while a draw is open, so a show does not depend on a scheduled job.
 */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  await requireVrf();
  assertRate(await rateLimitIp('vrf-advance', req, 20, 60));
  await readBody(req, VrfAdvanceRequest);
  const id = await vrfId(ctx);
  const row = await getRow(id);
  if (!row) throw new ApiError('not_found', 'No such draw');
  assertClusterReady(row.cluster as 'devnet' | 'mainnet-beta'); // 503 mainnet_config_incomplete before any chain call; never drives another cluster's row
  let view;
  try {
    view = await advance(id, defaultDeps());
  } catch (e) {
    if (e instanceof ConfigError) throw new ApiError('mainnet_config_incomplete', 'This deployment is not set up for draws yet.');
    throw e;
  }
  if (!view) throw new ApiError('not_found', 'No such draw');
  return json(view, ROUTES.vrfAdvance.cache);
});
