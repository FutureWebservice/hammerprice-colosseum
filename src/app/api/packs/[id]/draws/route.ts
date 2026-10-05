import { PackDrawsQuery, ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { paramId, parseQuery, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute, readLimit } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** The public log of a pack's draws, newest first. A draw that is still waiting for its payment shows no result. */
export const GET = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'pack');
  const q = parseQuery(req, PackDrawsQuery);
  await readLimit(req);
  return json(await getPackService().listDraws(id, q), ROUTES.packsDraws.cache);
});
