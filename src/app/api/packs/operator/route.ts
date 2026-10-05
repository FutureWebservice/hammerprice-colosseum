import { getSession } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { describeSellerAccess } from '@/app/api/shows/seller-allowlist';
import { packRoute, readLimit } from '@/server/packs/http';

/** Who may offer a pack on this deployment, from the same allowlist logic as `POST /api/packs`; `allowed` for the signed-in wallet (null when nobody is signed in). */
export const GET = packRoute(async (req: Request) => {
  await readLimit(req);
  const session = await getSession(req);
  return json(describeSellerAccess(session?.wallet ?? null), 'none');
});
