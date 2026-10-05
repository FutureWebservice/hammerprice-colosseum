import { json } from '@/lib/http/respond';
import { adminRoute, notFoundResponse } from '@/server/admin/access';
import { isSection, loadSection } from '@/server/admin/data';

/** One admin section as JSON (the same data the page renders): ?page=&q=&tab=. Admin wallets only; everyone else gets 404. */
export const GET = adminRoute(async (_admin, req: Request, ctx: { params: Promise<{ section: string }> }) => {
  const { section } = await ctx.params;
  if (!isSection(section)) return notFoundResponse();
  const sp = new URL(req.url).searchParams;
  return json(await loadSection(section, { page: Number(sp.get('page') ?? 1), q: sp.get('q') ?? '', tab: sp.get('tab') ?? undefined }));
});
