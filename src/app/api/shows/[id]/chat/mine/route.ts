import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { assertChatOn, listMine } from '@/server/chat/service';

/** The caller's own messages that are not public yet (waiting for approval, or rejected with the reason), and whether the caller is this room's operator. */
export const GET = route(async (req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  await assertChatOn();
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('chat-mine', session.wallet, 3, 5, { failOpen: true }));
  return json(await listMine(showId, { profileId: profile.id, wallet: session.wallet }));
});
