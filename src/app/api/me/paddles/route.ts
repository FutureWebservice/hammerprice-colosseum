import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { paddles, shows } from '@/db/schema';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { MIN_PADDLE_USDC } from '@/lib/auth/me';
import { route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { chainService } from '@/app/api/auctions/_shared/deps';
import { getDb } from '@/app/api/auctions/_shared/http';

/** The wallet's paddles that still work (not revoked, not expired), newest first. `funded` is the live balance check, same for all of them; an unreadable balance means false, never a failure. */
export const GET = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('me-paddles', session.wallet, 120, 60, { failOpen: true }));
  const db = await getDb();
  const [rows, funded] = await Promise.all([
    db
      .select({ showId: paddles.showId, showTitle: shows.title, number: paddles.number, validUntil: paddles.validUntil })
      .from(paddles).innerJoin(shows, eq(shows.id, paddles.showId))
      .where(and(eq(paddles.profileId, profile.id), isNull(paddles.revokedAt), gt(paddles.validUntil, new Date())))
      .orderBy(desc(paddles.registeredAt)).limit(50),
    chainService().getUsdcBalance(session.wallet).then((b) => b >= MIN_PADDLE_USDC, () => false),
  ]);
  return json({ paddles: rows.map((r) => ({ showId: r.showId, showTitle: r.showTitle, number: r.number, validUntil: r.validUntil.toISOString(), funded })) });
});
