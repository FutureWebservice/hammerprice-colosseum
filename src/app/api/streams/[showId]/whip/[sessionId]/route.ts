import { ApiError } from '@/contracts/errors';
import { noContent } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { isSessionId, whipStop } from '@/server/streams/mediamtx';
import { authorizeSender, showParam } from '@/server/streams/service';

export const runtime = 'nodejs';

/** Ends one sending session. The media-server address is rebuilt from the configuration and the show's own path; the id must be a UUID. */
export const DELETE = route(async (req: Request, ctx: { params: Promise<{ showId: string; sessionId: string }> }) => {
  const showId = await showParam(ctx);
  const { sessionId } = await ctx.params;
  if (!isSessionId(sessionId)) throw new ApiError('validation', 'Bad session id');
  const a = await authorizeSender(req, showId, { allowEnded: true, walletLimitPerMin: 20 });
  if (!(await whipStop(a.cfg, a.path, sessionId))) throw new ApiError('video_unavailable', 'Live video is not available right now');
  return noContent();
});
