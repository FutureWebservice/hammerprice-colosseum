/**
 * Which room "the house room" is right now. /room/house resolves it on the server, so the landing page and the nav need no show id.
 * Order: a LIVE house show (bidding open) first; with none, a live timed demo lot (also first when the caller asks for the timed room);
 * then the next scheduled house show (reported as 'scheduled': the caller must NOT send a visitor into it before it goes live); then the last
 * one that ended. A scheduled show never wins while anything is live.
 */
export interface HouseShowRow {
  id: string;
  status: 'scheduled' | 'live' | 'ended';
  /** 'timed' (one card for hours); anything else, or missing, is the live room. */
  kind?: string;
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
}
export interface HouseTarget { id: string; status: HouseShowRow['status']; kind: 'live' | 'timed'; startsAt: string | null }

const t = (d: Date | null, fallback: number) => (d ? d.getTime() : fallback);
const kindOf = (r: HouseShowRow): 'live' | 'timed' => (r.kind === 'timed' ? 'timed' : 'live');
const target = (r: HouseShowRow): HouseTarget => ({ id: r.id, status: r.status, kind: kindOf(r), startsAt: r.status === 'scheduled' && r.scheduledAt ? r.scheduledAt.toISOString() : null });

/** Pure: the best room among `rows` (house shows only), or null when there is none. `prefer: 'timed'` tries a live timed lot before the live room. */
export function pickHouseShow(rows: readonly HouseShowRow[], opts: { prefer?: 'live' | 'timed' } = {}): HouseTarget | null {
  const best = (status: HouseShowRow['status'], kind: 'live' | 'timed', key: (r: HouseShowRow) => number, dir: 1 | -1) =>
    rows.filter((r) => r.status === status && kindOf(r) === kind).sort((a, b) => dir * (key(a) - key(b)))[0];
  const started = (r: HouseShowRow) => t(r.startedAt, 0);
  for (const k of opts.prefer === 'timed' ? (['timed', 'live'] as const) : (['live', 'timed'] as const)) {
    const live = best('live', k, started, -1);
    if (live) return target(live);
  }
  // A timed lot that has not started or has ended is not "the house room": only the live room's scheduled and ended shows count here.
  const next = best('scheduled', 'live', (r) => t(r.scheduledAt, Number.MAX_SAFE_INTEGER), 1);
  if (next) return target(next);
  const last = best('ended', 'live', (r) => t(r.endedAt ?? r.startedAt, 0), -1);
  return last ? target(last) : null;
}

/** The database read behind /room/house. Opens the database lazily so pure imports and tests never need one. */
export async function currentHouseShow(opts: { prefer?: 'live' | 'timed' } = {}): Promise<HouseTarget | null> {
  const { db, shows } = await import('@/db');
  const { eq } = await import('drizzle-orm');
  const rows = await db
    .select({ id: shows.id, status: shows.status, kind: shows.kind, scheduledAt: shows.scheduledAt, startedAt: shows.startedAt, endedAt: shows.endedAt })
    .from(shows)
    .where(eq(shows.isHouse, true));
  return pickHouseShow(rows, opts);
}
