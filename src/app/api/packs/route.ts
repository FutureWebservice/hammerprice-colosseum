import { PackCreateRequest, ROUTES } from '@/contracts';
import { assertClusterReady } from '@/lib/chain/cluster';
import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { assertSellerAllowed } from '@/app/api/shows/seller-allowlist';
import { packRoute, readLimit, readPackBody } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

export const maxDuration = 30;

/** The packs on sale on this network. Reading the list also keeps the platform's own test pack alive on devnet (src/server/packs/house.ts). */
export const GET = packRoute(async (req: Request) => {
  await readLimit(req);
  await (await import('@/server/packs/house')).keepHousePackAlive();
  await getPackService().advanceDue(5).catch(() => undefined); // a pay-first purchase nobody is watching still moves on (delivery, refund); the daily sweep is only the net
  return json({ packs: await getPackService().list() }, ROUTES.packsList.cache);
});

/** An operator defines a pack (a draft with its pool of real cards and its odds); `control: publish` commits it. */
export const POST = packRoute(async (req: Request) => {
  assertClusterReady();
  const { session, profile } = await requireSessionProfile(req);
  assertSellerAllowed(session.wallet);
  const body = await readPackBody(req, PackCreateRequest);
  assertRate(await rateLimitWallet('pack-create', session.wallet, 10, 86_400));
  assertRate(await rateLimitChain(req));
  const pack = await getPackService().create({ id: profile.id, wallet: profile.walletAddress }, body);
  return json({ pack }, 'none', { status: 201 });
});
