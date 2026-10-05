import { ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { paramId, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute, readLimit } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** One pack: its odds, its whole pool and the commitment, visible before anyone buys. A draft is not public. */
export const GET = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'pack');
  await readLimit(req);
  return json(await getPackService().detail(id, null), ROUTES.packsDetail.cache);
});
