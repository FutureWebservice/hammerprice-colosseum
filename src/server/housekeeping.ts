import { ApiError } from '@/contracts';
import { createMemo } from '@/lib/http/memo';
import { auctionService, settlementService } from '@/app/api/auctions/_shared/deps';

/**
 * The housekeeping pass. Nothing depends on it (every read advances its own show lazily); it only makes sure shows nobody is watching
 * still close, the house room still rolls over, due settlements expire and landed ones finalize, and that retention, draws, packs and
 * Telegram reminders keep moving. Idempotent: running it twice, or while readers advance the same shows, changes nothing the second time.
 *
 * One pass, two triggers: the daily Vercel Cron (vercel.json, GET /api/cron/sweep) and, for hosts without a scheduler (a local build included),
 * a read of the schedule (GET /api/shows), which starts it in the background at most once per HOUSEKEEPING_INTERVAL_S (default 900 s,
 * 0 = off) per server instance, so it also runs while anyone, a judge included, is looking at the site.
 */
export interface HousekeepingResult { advanced: number; expired: number; finalized: number }

export async function runHousekeeping(): Promise<HousekeepingResult> {
  const swept = await auctionService().sweep();
  let settled = { expired: 0, finalized: 0 };
  try {
    settled = await settlementService().sweep(new Date());
  } catch (e) {
    // Paused payments (no keys) or an unreachable chain must not stop the show sweep; this half reports zeros and nobody is struck.
    if (!(e instanceof ApiError && e.code === 'paused')) console.error('housekeeping: settlement sweep failed', (e as Error).message);
  }
  let created = 0;
  try {
    created = (await (await import('@/server/house/rollover')).keepHouseShowAlive({ maxMint: 3 })) === 'created' ? 1 : 0;
  } catch (e) {
    console.error('housekeeping: house rollover failed', (e as Error).message);
  }
  const step = async (name: string, run: () => Promise<unknown>) => {
    try { await run(); } catch (e) { console.error(`housekeeping: ${name} failed`, (e as Error).message); }
  };
  await step('chat purge', async () => (await import('@/server/chat/purge')).purgeChat()); // retention for the room chat
  await step('house retention', async () => (await import('@/server/house/retention')).purgeHouseDemoData()); // ended house (demo) rooms older than HOUSE_RETENTION_DAYS (default 7); never a real room or a real settlement
  await step('vrf sweep', async () => (await import('@/server/vrf/driver')).sweepVrf()); // draws nobody is watching still progress; overdue ones default (a no-op while FEATURE_VRF is off)
  await step('pack sweep', async () => (await import('@/server/packs/sweep')).sweepPacks()); // expiry and the devnet test pack (a no-op while FEATURE_PACKS is off)
  await step('telegram sweep', async () => (await import('@/server/telegram/sweep')).sweepTelegram()); // messages a hook missed and the payment deadline reminders (a no-op while FEATURE_TELEGRAM is off)
  return { advanced: swept.advanced + created, ...settled };
}

export const housekeepingIntervalMs = (env: Record<string, string | undefined> = process.env): number => {
  const raw = env.HOUSEKEEPING_INTERVAL_S;
  const n = raw === undefined || raw === '' ? 900 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 86_400) * 1000 : 900_000;
};

/** A trigger that runs `run` at most once per `intervalMs` (and never twice at the same time) and never throws. 0 turns it off. */
export function createHousekeeping(run: () => Promise<unknown>, intervalMs: number): () => Promise<void> {
  if (intervalMs <= 0) return async () => undefined;
  const memo = createMemo<void>(intervalMs, 1);
  return () => memo.get('pass', async () => { try { await run(); } catch (e) { console.error('housekeeping failed', (e as Error).message); } });
}

const trigger = createHousekeeping(runHousekeeping, housekeepingIntervalMs());

/** Starts the pass in the background of the current request. Never throws and never delays the response. */
export function startHousekeeping(): void {
  const work = trigger();
  void import('next/server').then(({ after }) => { try { after(() => work); } catch { /* outside a request: the promise simply runs on */ } }).catch(() => undefined);
}
