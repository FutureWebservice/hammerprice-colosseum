import { ApiError, ROUTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { resolveCluster } from '@/lib/chain/config';
import { vrfKey } from '@/server/vrf/key';
import { keyStats } from '@/server/vrf/service';
import { SUITE } from '@/server/vrf/service';
import { requireVrf } from '../_shared';

/**
 * The public key of the draws, announced once (the registration transaction, when the operator published it) and the counters: a commit that
 * is never revealed stays visible here. Public; the CDN may keep it for a minute.
 */
export const GET = route(async (req: Request) => {
  await requireVrf();
  assertRate(await rateLimitIp('vrf-read', req, 120, 60, { failOpen: true }));
  const key = vrfKey();
  if (!key) throw new ApiError('feature_off', 'Not found');
  const reg = process.env.VRF_REGISTRATION_TX?.trim();
  return json({
    publicKey: key.publicKey, suite: SUITE, cluster: resolveCluster(),
    registrationTx: reg && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(reg) ? reg : null,
    stats: await keyStats({ key, env: process.env }),
  }, ROUTES.vrfKey.cache);
});
