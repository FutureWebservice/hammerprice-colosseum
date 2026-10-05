import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { packRoute } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** The sales of the caller's packs that still wait for the operator to deliver the drawn card (A14). Only the operator sees the card here. */
export const GET = packRoute(async (req: Request) => {
  const { profile } = await requireSessionProfile(req);
  return json({ deliveries: await getPackService().listDeliveries(profile.id) });
});
