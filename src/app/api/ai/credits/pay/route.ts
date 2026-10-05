import { AiCreditsPayRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { requireAi } from '@/server/ai/http';
import { getCreditService } from '@/server/credits/service';
import { chainRoute } from '@/server/settlement/http';

export const maxDuration = 30;

/** The buyer's signed transaction: checked against the prepared message, SA signs last, simulated, sent, verified on chain, then the credits are booked. */
export const POST = chainRoute(async (req: Request) => {
  await requireAi();
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('ai-pay', session.wallet, 10, 60));
  assertRate(await rateLimitChain(req));
  const body = await readBody(req, AiCreditsPayRequest);
  return json(await getCreditService().pay(profile.id, body));
});
