import { ApiError, SellAssetsQuery } from '@/contracts';
import { resolveCluster } from '@/lib/chain/config';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { requireSessionProfile } from '@/lib/auth/session';
import { chainRoute } from '@/server/settlement/http';
import { getSellService } from '@/server/settlement/sell';

/**
 * The signed-in seller's cards, each flagged eligible or not with reason codes. The cluster is the deployment's own: asking
 * for the other one is refused (a wallet on the wrong network is the classic demo failure, so say it plainly).
 */
export const GET = chainRoute(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('sell-assets', session.wallet, 30, 60, { failOpen: true }));
  assertRate(await rateLimitChain(req, { failOpen: true }));
  const raw = new URL(req.url).searchParams.get('cluster');
  const q = SellAssetsQuery.safeParse(raw === null ? {} : { cluster: raw });
  if (!q.success) throw new ApiError('validation', 'cluster: must be devnet or mainnet-beta');
  const cluster = resolveCluster();
  if (q.data.cluster && q.data.cluster !== cluster) throw new ApiError('validation', `This site runs on ${cluster}, not ${q.data.cluster}`);
  return json({ assets: await getSellService().listAssets({ wallet: session.wallet, profileId: profile.id, cluster }) });
});
