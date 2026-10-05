import { requireSessionProfile } from '@/lib/auth/session';
import { json } from '@/lib/http/respond';
import { packRoute } from '@/server/packs/http';
import { getPackService } from '@/server/packs/instance';

/** The caller's own packs on this network, drafts included. */
export const GET = packRoute(async (req: Request) => {
  const { profile } = await requireSessionProfile(req);
  return json({ packs: await getPackService().list({ operatorProfileId: profile.id }) });
});
