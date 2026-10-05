import { cacheHeaders } from '@/lib/http/respond';
import { assertSameOrigin } from '@/lib/http/origin';
import { route } from '@/lib/auth/route';
import { clearSessionCookie } from '@/lib/auth/session';

/** Clears the cookie. Works with an expired or missing session too: there is nothing to refuse. */
export const POST = route(async (req: Request) => {
  assertSameOrigin(req);
  return new Response(null, { status: 204, headers: { ...cacheHeaders('none'), 'Set-Cookie': clearSessionCookie(req) } });
});
