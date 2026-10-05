import type { ShowCore } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertSameOrigin } from '@/lib/http/origin';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { type IdCtx, paramId } from './http';

/** go-live, end and cancel: same-origin write by the signed-in seller (or, on the house show only, an operator wallet; the engine decides). */
export const showAction = (run: (showId: string, actor: { profileId: string; wallet: string }) => Promise<ShowCore>) =>
  route(async (req: Request, ctx: IdCtx) => {
    assertSameOrigin(req);
    const showId = await paramId(ctx, 'Show');
    const { session, profile } = await requireSessionProfile(req);
    return json({ show: await run(showId, { profileId: profile.id, wallet: session.wallet }) });
  });
