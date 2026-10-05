import { ApiError } from '@/contracts';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { readAvatar } from '@/server/profile/service';

/**
 * A profile picture by profile id (the id is not a secret and appears nowhere with a wallet). The picture was uploaded by its owner to be
 * shown, so this needs no session. It is served with the type the server decided from the bytes, `nosniff`, and a policy that lets the browser
 * do nothing with it but draw it. `?v=<version>` (from the profile) makes the answer immutable, so a browser or CDN keeps it for a year;
 * without it the answer is kept for a minute.
 */
export const GET = route(async (req: Request, ctx: IdCtx) => {
  const id = await paramId(ctx, 'Picture');
  assertRate(await rateLimitIp('avatar', req, 240, 60, { failOpen: true }));
  const found = await readAvatar(id);
  if (!found) throw new ApiError('not_found', 'Picture not found');
  const versioned = /^\d{1,16}$/.test(new URL(req.url).searchParams.get('v') ?? '');
  return new Response(new Uint8Array(found.bytes), {
    status: 200,
    headers: {
      'Content-Type': found.type,
      'Content-Length': String(found.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=60',
    },
  });
});
