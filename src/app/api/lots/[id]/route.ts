import { PatchLotRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { auctionService } from '@/app/api/auctions/_shared/deps';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';

/** The seller edits reserve and terms of a lot that has not opened yet (`wrong_state` once it has). */
export const PATCH = route(async (req: Request, ctx: IdCtx) => {
  const lotId = await paramId(ctx, 'Lot');
  const { profile } = await requireSessionProfile(req);
  const terms = await readBody(req, PatchLotRequest);
  return json({ lot: await auctionService().patchLot({ lotId, actorProfileId: profile.id, terms }) });
});
