import { ApiError, ChatPostRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitIp, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { featureOn } from '@/lib/features';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { assertChatOn, listPublic, postMessage, showExists } from '@/server/chat/service';
import { type ChatList, chatListMemo } from '@/server/chat/memo';

/** The room's public chat: the last 50 approved messages, identical for every viewer (CDN 1 s). `enabled: false` with nothing else when the feature is off. */
export const GET = route(async (req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  if (!(await featureOn('CHAT'))) return json({ enabled: false, messages: [], lastSeq: 0 } satisfies ChatList, { cdnS: 1 });
  assertRate(await rateLimitIp('chat-read', req, 120, 60, { failOpen: true }));
  const list = await chatListMemo.get(showId, async () => {
    if (!(await showExists(showId))) throw new ApiError('not_found', 'Show not found');
    return { enabled: true, ...(await listPublic(showId)) };
  });
  return json(list, { cdnS: 1 });
});

/** Write a message. It comes back as the author's own `pending` message (the room operator's own post is approved at once). */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  await assertChatOn();
  const body = await readBody(req, ChatPostRequest);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('chat', session.wallet, 1, 3));
  assertRate(await rateLimitWallet('chat-min', session.wallet, 12, 60));
  assertRate(await rateLimitIp('chat', req, 40, 60));
  const message = await postMessage({ showId, actor: { profileId: profile.id, wallet: session.wallet }, body: body.body, clientNonce: body.clientNonce, lotNumber: body.lotNumber });
  return json({ message }, 'none', { status: 201 });
});
