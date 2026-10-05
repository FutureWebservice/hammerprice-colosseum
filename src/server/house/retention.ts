/**
 * Retention for the house (demo) rooms, run by the daily sweep. The house room rolls over by itself whenever somebody looks, so a busy
 * day writes a new show every ten minutes (6 lots, about 18 house bids, 44 events, 6 lapsed settlements, 3 paddles: roughly 40 KB with
 * its indexes, measured). Nobody needs last week's practice rooms, so after HOUSE_RETENTION_DAYS (default 7) an
 * ended house show goes, and with it (by the foreign keys' cascade) its lots, bids, events, paddles and chat.
 *
 * What is NEVER touched:
 *   - a room that is not the house's (a seller's real room, ended or not),
 *   - a house show that is not ended (live, scheduled, or with a lot still on the block),
 *   - a house show with ANY settlement except the one the house itself writes off: "expired, failure_code house_bidder" (a house bidder
 *     won, no money was ever due). A person's payment, a strike, a failed or a settled sale keeps its room, its lots and its bid log,
 *     because the public /verify page and the buyer's account rebuild from them.
 * Bounded: at most BATCH shows per statement pair and a time budget per run, so one sweep never runs long; the next day continues.
 * The space is reused by new rows (autovacuum); the file only shrinks with a manual VACUUM FULL, which is not needed to stay bounded.
 */
import { sql } from 'drizzle-orm';

export const DEFAULT_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 365;
const BATCH = 200;
const BUDGET_MS = 25_000;
const DAY = 86_400_000;

type Env = Record<string, string | undefined>;

/** HOUSE_RETENTION_DAYS: 1 to 365, default 7; "off" keeps everything; anything else is the default. Returns null when off. */
export function houseRetentionDays(env: Env = process.env): number | null {
  const raw = env.HOUSE_RETENTION_DAYS?.trim().toLowerCase();
  if (raw === 'off') return null;
  if (!raw || !/^\d{1,3}$/.test(raw)) return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return n >= 1 && n <= MAX_RETENTION_DAYS ? n : DEFAULT_RETENTION_DAYS;
}

type Exec = { execute(q: ReturnType<typeof sql>): Promise<unknown> };
const rowsOf = <T,>(r: unknown): T[] => (r as { rows: T[] }).rows;

export interface PurgeResult { shows: number; lots: number; bids: number; events: number }

/** The ids of up to `limit` house shows that may go. Everything the rule above says is in this one predicate. */
async function eligible(x: Exec, cutoff: Date, limit: number): Promise<string[]> {
  return rowsOf<{ id: string }>(await x.execute(sql`
    select s.id from shows s
    where s.is_house and s.status = 'ended' and coalesce(s.ended_at, s.created_at) < ${cutoff.toISOString()}::timestamptz
      and not exists (select 1 from lots l where l.show_id = s.id and l.state = 'open')
      and not exists (
        select 1 from lots l join settlements st on st.lot_id = l.id
        where l.show_id = s.id and (st.status <> 'expired' or st.failure_code is distinct from 'house_bidder'))
    order by s.ended_at nulls first limit ${limit}`)).map((r) => r.id);
}

export async function purgeHouseDemoData(opts: { now?: Date; env?: Env; db?: { transaction<T>(f: (tx: Exec) => Promise<T>): Promise<T> } } = {}): Promise<PurgeResult> {
  const days = houseRetentionDays(opts.env);
  const total: PurgeResult = { shows: 0, lots: 0, bids: 0, events: 0 };
  if (days === null) return total;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * DAY);
  const db = (opts.db ?? (await import('@/db')).db) as unknown as { transaction<T>(f: (tx: Exec) => Promise<T>): Promise<T> };
  const started = Date.now();
  for (;;) {
    const done = await db.transaction(async (tx) => {
      const ids = await eligible(tx, cutoff, BATCH);
      if (ids.length === 0) return null;
      const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
      const counts = rowsOf<{ lots: number; bids: number; events: number }>(await tx.execute(sql`
        select (select count(*)::int from lots where show_id in (${list})) as lots,
               (select count(*)::int from bids b join lots l on l.id = b.lot_id where l.show_id in (${list})) as bids,
               (select count(*)::int from show_events where show_id in (${list})) as events`))[0]!;
      // The house's own written-off settlements reference the lots without a cascade; they are the only kind that can be here.
      await tx.execute(sql`delete from settlements where lot_id in (select id from lots where show_id in (${list}))`);
      await tx.execute(sql`delete from shows where id in (${list})`); // cascades to lots, bids, events, paddles, chat, presence, secrets
      return { shows: ids.length, ...counts };
    });
    if (!done) break;
    total.shows += done.shows; total.lots += done.lots; total.bids += done.bids; total.events += done.events;
    if (done.shows < BATCH || Date.now() - started > BUDGET_MS) break;
  }
  return total;
}
