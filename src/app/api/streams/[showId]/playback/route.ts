import { ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { playback, showParam, type ShowCtx } from '@/server/streams/service';

/** Whether this show has live video right now. Public; the CDN and a 3 s memo absorb the polling. Never carries a host, a path or a credential. */
export const GET = route(async (_req: Request, ctx: ShowCtx) => json(await playback(await showParam(ctx)), ROUTES.streamPlayback.cache));
