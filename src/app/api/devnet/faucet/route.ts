import { ApiError, FaucetRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { getDevnetService } from '@/server/settlement/devnet';
import { chainRoute } from '@/server/settlement/http';
import { flagOn } from '@/app/api/auctions/_shared/flags';

/** 1,000 test USDC, once per wallet per 24 h and at most 3 requests per address per 24 h. Devnet only. */
export const POST = chainRoute(async (req: Request) => {
  const { session } = await requireSessionProfile(req);
  await readBody(req, FaucetRequest);
  if (!(await flagOn('faucet'))) throw new ApiError('faucet_paused', 'The test faucet is switched off for now');
  return json(await getDevnetService().faucet({ wallet: session.wallet, req }));
});
