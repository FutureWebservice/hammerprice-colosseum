/**
 * The server half of /room/house: make sure the house room is running, then say which room a visitor should land in.
 *
 *   1. keepHouseShowAlive: starts the next house show when none is running (never throws).
 *   2. every house show that is live or scheduled is advanced, so a show that is DUE goes live now instead of waiting for the next sweep
 *      (this also runs when the rollover is unconfigured, and for a show whose rollover call lost the race).
 *   3. pickHouseShow (src/lib/house-room.ts): live house show, else a live timed lot, else the next scheduled one, else the last ended one.
 *
 * A 'scheduled' answer means the show has NOT started: the page explains and links instead of redirecting into a room nobody can bid in.
 */
import { currentHouseShow, type HouseTarget } from '@/lib/house-room';

export interface ResolveDeps {
  keepAlive(): Promise<unknown>;
  /** Ids of the house shows that are live or scheduled. */
  openHouseShowIds(): Promise<string[]>;
  advance(showId: string): Promise<unknown>;
  current(opts: { prefer?: 'live' | 'timed' }): Promise<HouseTarget | null>;
}

async function defaultDeps(): Promise<ResolveDeps> {
  const [{ keepHouseShowAlive }, { db }, { sql }, auction] = await Promise.all([import('./rollover'), import('@/db'), import('drizzle-orm'), import('@/server/auction/service')]);
  return {
    keepAlive: () => keepHouseShowAlive(),
    openHouseShowIds: async () => ((await db.execute(sql`select id from shows where is_house and status in ('live', 'scheduled') order by created_at desc limit 10`)) as unknown as { rows: { id: string }[] }).rows.map((r) => r.id),
    advance: (id) => auction.advanceShow(id),
    current: currentHouseShow,
  };
}

/** Never throws: a failing step is skipped and the answer is whatever the database says. */
export async function resolveHouseRoom(opts: { prefer?: 'live' | 'timed'; deps?: Partial<ResolveDeps> } = {}): Promise<HouseTarget | null> {
  const d = { ...(await defaultDeps()), ...opts.deps };
  await d.keepAlive().catch(() => null);
  try {
    for (const id of await d.openHouseShowIds()) await d.advance(id).catch(() => null);
  } catch { /* the pick below still works */ }
  return d.current({ prefer: opts.prefer }).catch(() => null);
}
