import { AiCreditsQuoteRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { requireAi } from '@/server/ai/http';
import { getCreditService } from '@/server/credits/service';
import { chainRoute } from '@/server/settlement/http';

/** An unsigned transaction (fee payer = the settlement authority, signers {SA, buyer}) the buyer checks and signs. A live quote is reused. */
export const POST = chainRoute(async (req: Request) => {
  await requireAi();
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('ai-quote', session.wallet, 6, 60));
  assertRate(await rateLimitChain(req));
  await readBody(req, AiCreditsQuoteRequest);
  return json(await getCreditService().quote(profile));
});
