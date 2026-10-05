/**
 * The Telegram half of the housekeeping pass (src/server/housekeeping.ts). It is the safety net for everything the hooks send at the moment a state
 * changes: it sends what a hook missed (a crash, a rate limit, Telegram being down for a minute), the payment deadline reminders (these exist only
 * here), and a best-effort "ending soon" for lots that close within 15 minutes. Every notifier is idempotent through the sent-markers, so running it
 * twice, or at the same time as a hook, sends nothing twice. It does nothing while the feature is off. One failing step does not stop the others.
 */
import { and, eq, gt, lt, lte } from 'drizzle-orm';
import { lots, shows, telegramLinkTokens, telegramSent, telegramWatches } from '@/db/schema';
import { notifyDeadlines, notifyEndingSoon, notifyLotsOpened, notifySettled, notifyShowStarted, notifyWatchEnded, notifyWon, type Deps } from './notify';
import { telegramConfig } from './config';

const DAY_MS = 86_400_000;
/** How far back the sweep looks for events a hook missed. Older ones are not worth a message any more. */
export const LOOKBACK_MS = 3 * DAY_MS;
export const SENT_KEEP_MS = 45 * DAY_MS;
/** The sweep stops sending after this long (the cron function has 60 s and the other halves ran first). */
export const SWEEP_BUDGET_MS = 30_000;

export interface TelegramSweepResult { won: number; settled: number; showStart: number; endingSoon: number; deadline: number; lotWatch: number; purged: number }

export async function sweepTelegram(given: Deps = {}): Promise<TelegramSweepResult> {
  const zero: TelegramSweepResult = { won: 0, settled: 0, showStart: 0, endingSoon: 0, deadline: 0, lotWatch: 0, purged: 0 };
  if (!(await telegramConfig())) return zero;
  const out = { ...zero };
  const deps: Deps = { deadline: Date.now() + SWEEP_BUDGET_MS, ...given };
  const now = deps.now ?? new Date();
  const step = async (name: string, fn: () => Promise<number>): Promise<number> => {
    try { return await fn(); } catch (e) { console.error(`telegram sweep: ${name} failed:`, (e as Error).message); return 0; }
  };
  const db = (await import('@/db')).db;

  out.won = await step('won', () => notifyWon({ sinceMs: LOOKBACK_MS }, deps));
  out.settled = await step('settled', () => notifySettled({ sinceMs: LOOKBACK_MS }, deps));
  out.deadline = await step('deadline', () => notifyDeadlines(deps));
  out.showStart = await step('show start', async () => {
    const live = await db.select({ id: shows.id }).from(shows).where(and(eq(shows.status, 'live'), gt(shows.startedAt, new Date(now.getTime() - 6 * 3_600_000)))).limit(50);
    let n = 0;
    for (const s of live) n += await notifyShowStarted(s.id, deps);
    return n;
  });
  out.endingSoon = await step('ending soon', async () => {
    const open = await db.select({ id: lots.id, name: lots.name, showId: lots.showId, closesAt: lots.closesAt, highBid: lots.highBid }).from(lots)
      .where(and(eq(lots.state, 'open'), gt(lots.closesAt, now), lte(lots.closesAt, new Date(now.getTime() + 15 * 60_000)))).limit(50);
    let n = 0;
    for (const l of open) if (l.showId && l.closesAt) n += await notifyEndingSoon({ lotId: l.id, lotName: l.name, showId: l.showId, closesAt: l.closesAt, highBid: l.highBid }, { ...deps, withinMs: 15 * 60_000 });
    return n;
  });
  // Watched rooms: what the hook missed (lots that opened in the last 15 minutes), and the watches of shows that ended.
  out.lotWatch = await step('lot watch', async () => {
    const watched = await db.selectDistinct({ id: telegramWatches.showId, status: shows.status }).from(telegramWatches).innerJoin(shows, eq(shows.id, telegramWatches.showId)).limit(50);
    let n = 0;
    for (const w of watched) n += w.status === 'ended' ? await notifyWatchEnded(w.id, deps) : await notifyLotsOpened(w.id, deps);
    return n;
  });
  out.purged = await step('purge', async () => {
    const a = await db.delete(telegramLinkTokens).where(lt(telegramLinkTokens.expiresAt, new Date(now.getTime() - DAY_MS))).returning({ h: telegramLinkTokens.tokenHash });
    const b = await db.delete(telegramSent).where(lt(telegramSent.sentAt, new Date(now.getTime() - SENT_KEEP_MS))).returning({ r: telegramSent.ref });
    return a.length + b.length;
  });
  return out;
}
