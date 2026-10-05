import { VideoToggleRequest } from '@/contracts/stream';
import { json } from '@/lib/http/respond';
import { readBody, route } from '@/lib/auth/route';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { setVideoEnabled } from '@/server/streams/service';

/** The seller switches the optional live video of a show on or off (default off). */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  const { enabled } = await readBody(req, VideoToggleRequest);
  return json({ video: await setVideoEnabled(req, showId, enabled) });
});
