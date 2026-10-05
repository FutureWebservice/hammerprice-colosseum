/**
 * Who calls `advance`: the rollover right after it creates a drawn-order show (`after()` keeps the work going after the response), the room
 * chip of every viewer (POST /api/vrf/requests/:id/advance), and the sweep. Any of
 * them may run at any time: the lease in service.ts makes concurrent calls harmless.
 */
import { and, eq, isNotNull, notExists, sql } from 'drizzle-orm';
import { db, shows, vrfRequests } from '@/db';
import { featureOn } from '@/lib/features';
import { requestRaffle } from './raffle';
import { advance, defaultDeps, sweepRequests, type VrfDeps } from './service';

/** Runs `fn` after the response when we are inside a request, otherwise right away; never throws into the caller. */
export async function schedule(fn: () => Promise<unknown>): Promise<void> {
  const run = () => fn().catch((e) => console.error('vrf: background step failed:', (e as Error).message));
  try {
    const { after } = await import('next/server');
    after(run);
  } catch {
    void run(); // outside a request scope (a script, a test): just start it
  }
}

/** Kicks off the first advance of a request in the background. */
export const driveInBackground = (requestId: string): Promise<void> => schedule(async () => { await advance(requestId, defaultDeps()); });

/**
 * Thank-you draws for house shows that ended within the last hour and have none yet (needs two or more human bidders, see raffle.ts). Returns the
 * ids of the requests it created. Called when the next house show is created (the rollover hook) and by the sweep.
 */
export async function requestRecentRaffles(d: Pick<VrfDeps, 'key' | 'now' | 'env'>): Promise<string[]> {
  const ended = await db.select({ id: shows.id }).from(shows)
    .where(and(eq(shows.isHouse, true), eq(shows.status, 'ended'), isNotNull(shows.endedAt), sql`${shows.endedAt} > now() - interval '1 hour'`,
      notExists(db.select({ one: sql`1` }).from(vrfRequests).where(and(eq(vrfRequests.purpose, 'raffle'), eq(vrfRequests.subjectId, sql`${shows.id}::text`))))))
    .limit(3);
  const made: string[] = [];
  for (const s of ended) {
    try { const r = await requestRaffle(s.id, d); if (r?.created) made.push(r.id); } catch (e) { console.error('vrf: raffle request failed:', (e as Error).message); }
  }
  return made;
}

/**
 * Cron sweep: finished house shows get their thank-you draw, open draws move along, overdue ones default. Does nothing while FEATURE_VRF is off or
 * there is no key. Returns how many requests it touched.
 */
export async function sweepVrf(): Promise<number> {
  if (!(await featureOn('VRF'))) return 0;
  let d;
  try { d = defaultDeps(); } catch { return 0; }
  await requestRecentRaffles(d);
  return sweepRequests(d);
}
