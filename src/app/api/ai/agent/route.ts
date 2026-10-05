import { AiAgentRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { resolveCluster } from '@/lib/chain/config';
import { runAgent } from '@/server/ai/agent';
import { assertAiRate, requireAi } from '@/server/ai/http';
import { chainRoute } from '@/server/settlement/http';

export const maxDuration = 30;

/**
 * The chat agent on /ai: the model picks one of three tools (search lots, draft proposal, bid proposal), the server composes the answer.
 * Nothing here bids, pays or creates anything. Every call needs a signed-in wallet (401 `unauthenticated` otherwise, before any limit, budget or model call). Limited per wallet and per address.
 */
export const POST = chainRoute(async (req: Request) => {
  await requireAi();
  const { session, profile } = await requireSessionProfile(req);
  await assertAiRate(req, session.wallet);
  assertRate(await rateLimitIp('ai-agent-d', req, 40, 86_400));
  const body = await readBody(req, AiAgentRequest);
  const cluster = resolveCluster();
  const { db } = await import('@/db');
  return json(await runAgent(body, { profileId: profile.id }, { db, cluster }));
});
