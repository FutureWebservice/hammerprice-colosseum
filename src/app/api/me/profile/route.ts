import { ProfileUpdateRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { readProfile, updateProfile } from '@/server/profile/service';

/**
 * The signed-in user's public profile: display name, bio and avatar address. A wallet-signed session is required for both
 * methods; a user only ever reads and changes their own. PATCH is a same-origin JSON write, checked and cleaned by the server's profile rules, and limited to
 * 10 changes an hour so a name cannot be flipped back and forth under a moderator's eyes.
 */
export const GET = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('profile-read', session.wallet, 60, 60, { failOpen: true }));
  return json({ profile: await readProfile(profile.id) });
});

export const PATCH = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  const body = await readBody(req, ProfileUpdateRequest);
  assertRate(await rateLimitWallet('profile-update', session.wallet, 10, 3600));
  return json({ profile: await updateProfile(profile.id, session.wallet, body) });
});
