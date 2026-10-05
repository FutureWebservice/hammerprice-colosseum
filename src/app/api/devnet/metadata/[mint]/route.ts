import { ApiError, Wallet } from '@/contracts';
import { json } from '@/lib/http/respond';
import { getDevnetService } from '@/server/settlement/devnet';
import { chainRoute, publicOrigin } from '@/server/settlement/http';

/** The metadata JSON a devnet card's on-chain URI points at. Public; the CDN keeps it for an hour (a card's facts never change). */
export const GET = chainRoute(async (req: Request, ctx: { params: Promise<{ mint: string }> }) => {
  const { mint } = await ctx.params;
  if (mint !== 'collection' && !Wallet.safeParse(mint).success) throw new ApiError('not_found', 'No such card');
  const meta = await getDevnetService().metadata(mint, publicOrigin(req));
  if (!meta) throw new ApiError('not_found', 'No such card');
  return json(meta, { cdnS: 3600 });
});
