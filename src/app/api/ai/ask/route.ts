import { AiAskRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { resolveCluster } from '@/lib/chain/config';
import { ask } from '@/server/ai/ask';
import { assertAiRate, requireAi } from '@/server/ai/http';
import { chainRoute } from '@/server/settlement/http';

export const maxDuration = 30;

/** The room assistant: picks a FAQ entry, returns its fixed text. Needs a signed-in wallet (401 `unauthenticated` otherwise, before any limit or model call). Limited per wallet and per address. */
export const POST = chainRoute(async (req: Request) => {
  await requireAi();
  const { session, profile } = await requireSessionProfile(req);
  await assertAiRate(req, session.wallet);
  assertRate(await rateLimitIp('ai-ask-d', req, 40, 86_400));
  const body = await readBody(req, AiAskRequest);
  const cluster = resolveCluster();
  const { db } = await import('@/db');
  return json(await ask(body, { profileId: profile.id, cluster }, { db, cluster }));
});
