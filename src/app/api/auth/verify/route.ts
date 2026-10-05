import { AuthVerifyRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { loginHosts } from '@/lib/http/origin';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { completeLogin } from '@/lib/auth/login';
import { readBody, route } from '@/lib/auth/route';
import { sessionCookie, signSession } from '@/lib/auth/session';

/** Step 2 of sign-in: verify the signed text, burn the nonce, set the hp_session cookie. */
export const POST = route(async (req: Request) => {
  assertRate(await rateLimitIp('auth-verify', req, 10, 60));
  const body = await readBody(req, AuthVerifyRequest);
  const result = await completeLogin({ ...body, hosts: loginHosts(req) });
  const token = await signSession({ wallet: result.wallet, profileId: result.profile.id });
  return json(result, 'none', { headers: { 'Set-Cookie': sessionCookie(token, req) } });
});
