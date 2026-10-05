/**
 * "Is this card already offered somewhere?" One definition, shared by every place that offers a card: the room (createShow), the pack pool
 * (packs create), the seller's card picker (GET /api/sell/assets, which greys the card out) and the house stock.
 *
 * A card is LISTED while it is
 *   - in a lot that is still queued or on the block (state catalogued or open, in any show, whoever owns the show),
 *   - in a lot that was sold and whose payment round is still running (the card is promised to the buyer),
 *   - in the pool of a pack that is on sale or in preparation (draft, live, paused, sold_out; the card still available or reserved), or
 *   - drawn out of a pack whose delivery to the buyer has not finished (drawn, delivering, undelivered).
 * A card that was sold (and settled), whose lot passed or was withdrawn, whose show was cancelled or whose pack was closed is free again.
 *
 * Races: two requests offering the same card at the same moment are serialised by `lockAssets` (a transaction-scoped advisory lock per
 * card, taken in a fixed order so two multi-card requests cannot deadlock); the check runs under it. No schema change is needed.
 */
import { sql } from 'drizzle-orm';
import { ApiError } from '@/contracts';

type Exec = { execute(q: ReturnType<typeof sql>): Promise<unknown> };
const rowsOf = <T,>(r: unknown): T[] => (r as { rows: T[] }).rows;

/**
 * The lot half of "listed", as a predicate on a `lots l` row (also used by the house stock query, so the rollover never picks a card this
 * helper would refuse). A sold lot counts while its payment round runs: a payment window that has already passed does NOT count (the buyer
 * never paid and the card goes back to the seller), and a house bidder's win does not count either (that card never leaves the house).
 */
export const lotListedSql = sql`(
  l.state in ('catalogued', 'open')
  or (l.state = 'sold' and exists (
    select 1 from settlements st join profiles b on b.id = st.buyer_id
    where st.lot_id = l.id and not b.is_bot and (
      st.status = 'submitted'
      or (st.status in ('awaiting_payment', 'awaiting_seller') and (st.due_at is null or st.due_at > now()))))))`;

export type Listing = { kind: 'lot'; showId: string | null; lotId: string } | { kind: 'pack'; packId: string };

/** Serialises concurrent offers of the same cards for the rest of the transaction. */
export async function lockAssets(x: Exec, mints: readonly string[]): Promise<void> {
  for (const m of [...new Set(mints)].sort()) await x.execute(sql`select pg_advisory_xact_lock(hashtext(${`asset-listing:${m}`}))`);
}

/** The active listing of each card among `mints` (a card with none is absent). `exceptPackId`: that pack's own pool does not count. */
export async function findListings(x: Exec, mints: readonly string[], opts: { exceptPackId?: string } = {}): Promise<Map<string, Listing>> {
  const out = new Map<string, Listing>();
  if (mints.length === 0) return out;
  const list = sql.join(mints.map((m) => sql`${m}`), sql`, `);
  const lotRows = rowsOf<{ mint: string; lotId: string; showId: string | null }>(await x.execute(sql`
    select l.mint_address as mint, l.id as "lotId", l.show_id as "showId" from lots l
    where l.mint_address in (${list}) and ${lotListedSql}`));
  for (const r of lotRows) out.set(r.mint, { kind: 'lot', showId: r.showId, lotId: r.lotId });
  const exceptPack = opts.exceptPackId ?? null;
  const packRows = rowsOf<{ mint: string; packId: string }>(await x.execute(sql`
    select pc.asset as mint, pc.pack_id as "packId" from pack_pool_cards pc join pack_definitions pd on pd.id = pc.pack_id
    where pc.asset in (${list}) and pc.status in ('available', 'reserved') and pd.status in ('draft', 'live', 'paused', 'sold_out') and (${exceptPack}::uuid is null or pc.pack_id <> ${exceptPack}::uuid)
    union all
    select pw.asset as mint, pw.pack_id as "packId" from pack_draws pw
    where pw.asset in (${list}) and pw.status in ('drawn', 'delivering', 'undelivered')`));
  for (const r of packRows) if (!out.has(r.mint)) out.set(r.mint, { kind: 'pack', packId: r.packId });
  return out;
}

const WHERE: Record<Listing['kind'], string> = { lot: 'a room or sale', pack: 'a pack' };

/** Locks, then throws `already_listed` (409) for the first card that is listed. Call it inside the transaction that creates the new listing. */
export async function assertNotListed(x: Exec, mints: readonly string[], opts: { exceptPackId?: string } = {}): Promise<void> {
  await lockAssets(x, mints);
  const found = await findListings(x, mints, opts);
  for (const m of mints) {
    const l = found.get(m);
    if (l) throw new ApiError('already_listed', `The card ${m} is already in ${WHERE[l.kind]}. A card can be offered in one place at a time.`, { mint: m, listing: l });
  }
}
