import { ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { paramId, type IdCtx } from '@/app/api/auctions/_shared/http';
import { packRoute, readLimit } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

export const maxDuration = 30;

/** One draw. A read finalizes a landed payment lazily and expires an overdue draw; it never fails because the chain is slow. */
export const GET = packRoute(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'draw');
  await readLimit(req);
  return json(await getPackService().getDraw(id), ROUTES.packsDraw.cache);
});
