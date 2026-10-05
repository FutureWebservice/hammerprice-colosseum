/**
 * Applying a drawn lot order: the lots of a show that has not opened any lot yet get their new numbers, in ONE database transaction with the
 * draw's own state change (service.ts). The unique index on (show, lot number) is the safety net: numbers are moved out of the way first
 * (negated) and then written, so no intermediate state collides.
 */
import { and, eq, sql } from 'drizzle-orm';
import { lots } from '@/db';

/** What the callers pass: a transaction or the database (structurally the same query builder). */
type Exec = Parameters<Parameters<(typeof import('@/db'))['db']['transaction']>[0]>[0];

/**
 * `order` lists lot ids, position 0 first. Applies only when every lot of the show is still catalogued and the show holds exactly these
 * lots (a withdrawn, added or already opened lot means the committed order no longer describes the show). Returns whether it was applied;
 * `false` leaves the catalogue order and is recorded as such in the result (`applied: false`).
 */
export async function applyLotOrder(x: Exec, showId: string, order: readonly string[]): Promise<boolean> {
  const rows = await x.select({ id: lots.id, state: lots.state }).from(lots).where(eq(lots.showId, showId));
  const same = rows.length === order.length && rows.every((r) => order.includes(r.id)) && new Set(order).size === order.length;
  if (!same || rows.some((r) => r.state !== 'catalogued')) return false;
  await x.update(lots).set({ lotNumber: sql`-${lots.lotNumber}` }).where(eq(lots.showId, showId));
  const ids = sql.join(order.map((id) => sql`${id}::uuid`), sql`, `);
  await x.execute(sql`
    update lots l set lot_number = o.pos::int
    from (select t.id, t.pos from unnest(array[${ids}]) with ordinality as t(id, pos)) o
    where l.id = o.id and l.show_id = ${showId}`);
  // Nothing may be left negative: every lot of the show was in `order`.
  const left = await x.select({ id: lots.id }).from(lots).where(and(eq(lots.showId, showId), sql`${lots.lotNumber} < 1`)).limit(1);
  if (left.length > 0) throw new Error('lot renumbering left a lot unnumbered');
  return true;
}
