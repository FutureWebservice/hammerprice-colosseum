import { ApiError, AuthChallengeRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { loginHosts, requestHost } from '@/lib/http/origin';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { decodePubkey } from '@/lib/auth/ed25519';
import { issueChallenge } from '@/lib/auth/login';
import { readBody, route } from '@/lib/auth/route';

/** Step 1 of sign-in: a single-use nonce and the exact text the wallet must sign. */
export const POST = route(async (req: Request) => {
  assertRate(await rateLimitIp('auth-challenge', req, 10, 60));
  const { wallet } = await readBody(req, AuthChallengeRequest);
  if (!decodePubkey(wallet)) throw new ApiError('validation', 'wallet: not a Solana public key');
  const hosts = loginHosts(req);
  const host = hosts.includes(requestHost(req)) ? requestHost(req) : hosts[0];
  return json(await issueChallenge({ wallet, host }));
});
