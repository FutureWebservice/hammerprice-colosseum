import { ApiError, MintCardRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { readBody } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { getDevnetService } from '@/server/settlement/devnet';
import { chainRoute, publicOrigin } from '@/server/settlement/http';
import { flagOn } from '@/app/api/auctions/_shared/flags';

/** Mints one demo card (a labelled replica of a real vault card) to the caller. 3 per wallet per day. Devnet only. */
export const POST = chainRoute(async (req: Request) => {
  const { session } = await requireSessionProfile(req);
  const body = await readBody(req, MintCardRequest);
  if (!(await flagOn('mint'))) throw new ApiError('mint_paused', 'Minting demo cards is switched off for now');
  return json(await getDevnetService().mintCard({ wallet: session.wallet, req, origin: publicOrigin(req), template: body.template }));
});
