import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { assertCron } from '@/app/api/auctions/_shared/cron';
import { runHousekeeping } from '@/server/housekeeping';

export const maxDuration = 60;

/**
 * The daily safety net (vercel.json): the same single pass a read of the schedule starts lazily (src/server/housekeeping.ts). Nothing depends
 * on it (every read advances its own show lazily); it only makes sure shows nobody is watching still close, the house room still rolls over,
 * due settlements expire and landed ones finalize. Idempotent: running it twice, or while readers are advancing the same shows, changes nothing
 * the second time.
 */
export const GET = route(async (req: Request) => {
  assertCron(req);
  return json(await runHousekeeping());
});
