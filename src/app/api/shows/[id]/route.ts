import { ApiError, ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { auctionService } from '@/app/api/auctions/_shared/deps';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';

/** The catalogue of a show: names, images and the seller's terms. They do not change while the show runs, so the CDN may keep it for 10 s. */
export const GET = route(async (_req: Request, ctx: IdCtx) => {
  const detail = await auctionService().getCatalogue(await paramId(ctx, 'Show'));
  if (!detail) throw new ApiError('not_found', 'Show not found');
  return json(detail, ROUTES.showsGet.cache);
});
