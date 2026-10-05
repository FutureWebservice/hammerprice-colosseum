import { ApiError, AVATAR_MAX_BYTES } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertSameOrigin } from '@/lib/http/origin';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { clearAvatar, setAvatar } from '@/server/profile/service';

/**
 * The signed-in user's picture. POST takes the raw image as the body (png, jpeg or webp, at most 200 KB; the content type is only a hint, the
 * server decides from the bytes, see src/server/profile/avatar.ts) and answers the profile. DELETE removes it. Both are same-origin writes
 * limited to 10 per hour per wallet; a user only ever changes their own picture (found by the session, never by an id in the request).
 */
export const POST = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertSameOrigin(req);
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > AVATAR_MAX_BYTES + 1024) throw new ApiError('validation', 'The picture is too large (200 KB at most)', { field: 'avatar', rule: 'avatar_size' });
  assertRate(await rateLimitWallet('profile-avatar', session.wallet, 10, 3600));
  const body = new Uint8Array(await req.arrayBuffer());
  return json({ profile: await setAvatar(profile.id, session.wallet, body) });
});

export const DELETE = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertSameOrigin(req);
  assertRate(await rateLimitWallet('profile-avatar', session.wallet, 10, 3600));
  return json({ profile: await clearAvatar(profile.id, session.wallet) });
});
