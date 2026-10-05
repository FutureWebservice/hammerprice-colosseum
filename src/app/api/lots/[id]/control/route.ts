import { LotControlRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { auctionService } from '@/app/api/auctions/_shared/deps';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';

/** Extend or withdraw a lot. The engine enforces "only while the lot has no bid" under the lot lock, so a bid that lands first always wins the race. */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  const lotId = await paramId(ctx, 'Lot');
  const { profile } = await requireSessionProfile(req);
  const body = await readBody(req, LotControlRequest);
  return json(await auctionService().controlLot({ lotId, actorProfileId: profile.id, action: body.action, seconds: body.seconds }));
});
