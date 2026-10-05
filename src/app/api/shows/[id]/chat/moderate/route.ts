import { ChatModerateRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { assertChatOn, moderate, publish } from '@/server/chat/service';

/** One operator action: approve or reject (several messages at once), mute or block a bidder number, lift it, or publish a message as the operator. Operator only; every action is audited. */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  const showId = await paramId(ctx, 'Show');
  await assertChatOn();
  const body = await readBody(req, ChatModerateRequest);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('chat-moderate', session.wallet, 60, 60));
  const actor = { profileId: profile.id, wallet: session.wallet };
  if (body.action === 'publish') {
    await publish({ showId, actor, body: body.body, lotNumber: body.lotNumber, clientNonce: body.clientNonce, source: body.source });
    return json({ ok: true, affected: 1 });
  }
  return json({ ok: true, affected: await moderate(showId, actor, body) });
});
