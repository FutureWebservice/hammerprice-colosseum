import { ChatReportRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { assertChatOn, reportMessage } from '@/server/chat/service';

/** Report a public message (spam, scam, harassment, illegal, other). Nothing is removed automatically: the room operator sees the count and decides. */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  const messageId = await paramId(ctx, 'Message');
  await assertChatOn();
  const body = await readBody(req, ChatReportRequest);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('chat-report', session.wallet, 5, 3600));
  await reportMessage(messageId, { profileId: profile.id, wallet: session.wallet }, { reason: body.reason, detail: body.detail });
  return json({ ok: true }, 'none', { status: 201 });
});
