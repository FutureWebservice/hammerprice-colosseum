import type { WalletResponse } from '@/contracts';
import { resolveCluster } from '@/lib/chain/config';
import { getUsdcBalance } from '@/lib/chain/funds';
import { getBalanceLamports, makeRpc } from '@/lib/chain/rpc';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';

/** The signed-in wallet's own SOL and USDC balance on this site's cluster. A balance the network does not answer right now is null, never a guess. */
export const GET = route(async (req: Request) => {
  const { session } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('me-wallet', session.wallet, 30, 60, { failOpen: true }));
  const cluster = resolveCluster();
  const [usdc, sol] = await Promise.all([
    getUsdcBalance(session.wallet, cluster).then((v) => v.toString(), () => null),
    getBalanceLamports(makeRpc(cluster), session.wallet).then((v) => v.toString(), () => null),
  ]);
  const body: WalletResponse = { wallet: session.wallet, cluster, sol, usdc };
  return json(body);
});
