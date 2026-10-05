import { ChatQueueQuery } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { type IdCtx, paramId, parseQuery } from '@/app/api/auctions/_shared/http';
import { assertChatOn, queue } from '@/server/chat/service';

/** The operator's view: every message (pending, approved, rejected, reported) with the author's wallet, the counts and the silenced wallets. Operator only. */
export const GET = route(async (req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  await assertChatOn();
  const query = parseQuery(req, ChatQueueQuery);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('chat-queue', session.wallet, 4, 5, { failOpen: true }));
  return json(await queue(showId, { profileId: profile.id, wallet: session.wallet }, query));
});
