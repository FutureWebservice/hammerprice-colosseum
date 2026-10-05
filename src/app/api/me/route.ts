import { ApiError, MeQuery } from '@/contracts';
import { json, noContent } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { buildMe } from '@/lib/auth/me';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';

/**
 * The signed-in viewer, and with `?show=<id>` their paddle and standing in that show. `funds.usdc` is the spendable balance.
 * No (or a stale) session is not an error here: it answers 204, so an anonymous visitor's console and network log stay clean.
 */
export const GET = route(async (req: Request) => {
  let auth;
  try {
    auth = await requireSessionProfile(req);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'unauthenticated') return noContent();
    throw e;
  }
  const { session, profile } = auth;
  // A read: if the limiter's database is down the request is allowed (logged), not refused.
  assertRate(await rateLimitWallet('me', session.wallet, 120, 60, { failOpen: true }));
  const show = new URL(req.url).searchParams.get('show');
  const q = MeQuery.safeParse(show === null ? {} : { show });
  if (!q.success) throw new ApiError('validation', 'show: not a uuid');
  return json(await buildMe(profile, q.data.show?.toLowerCase()));
});
