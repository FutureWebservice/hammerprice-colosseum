/**
 * The thank-you draw (WP1b): after a show has ended, one of the people who bid is drawn with the same provable randomness as the lot order.
 * No money, no card, no chain action: the prize is a badge entry shown on the proof page. Nobody has to take part or pay for anything.
 *
 * Entrants: the paddle numbers of everyone who placed at least one bid in the show, without the house bots, without bids the house placed
 * itself and without the seller. Fewer than two entrants: no draw (a draw among one person proves nothing).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { bids, lots, paddles, profiles, shows } from '@/db';
import { db } from '@/db';
import { createRequest, raffleParams, type VrfDeps } from './service';

/** Distinct paddle numbers (ascending) of the human bidders of a show. */
export async function raffleEntrants(showId: string): Promise<number[]> {
  const rows = await db.selectDistinct({ number: paddles.number }).from(bids)
    .innerJoin(lots, eq(lots.id, bids.lotId))
    .innerJoin(shows, eq(shows.id, lots.showId))
    .innerJoin(paddles, and(eq(paddles.showId, shows.id), eq(paddles.profileId, bids.bidderId)))
    .innerJoin(profiles, eq(profiles.id, bids.bidderId))
    .where(and(eq(shows.id, showId), eq(profiles.isBot, false), sql`${bids.via} <> 'house'`, sql`${bids.bidderId} <> ${shows.sellerId}`));
  return rows.map((r) => r.number).sort((a, b) => a - b);
}

/**
 * Creates the draw of an ended show (once; calling again returns the same request). null when the show is not ended, is unknown, or has
 * fewer than two entrants. The caller drives it with `advance` like any other request.
 */
export async function requestRaffle(showId: string, d: Pick<VrfDeps, 'key' | 'now' | 'env'> & { revealWindowS?: number }): Promise<{ id: string; created: boolean } | null> {
  const [s] = await db.select({ status: shows.status }).from(shows).where(and(eq(shows.id, showId), inArray(shows.status, ['ended'])));
  if (!s) return null;
  const entrants = await raffleEntrants(showId);
  if (entrants.length < 2) return null;
  const window = d.revealWindowS ?? (Number(d.env.VRF_REVEAL_WINDOW_HOUSE_S) > 0 ? Number(d.env.VRF_REVEAL_WINDOW_HOUSE_S) : 120);
  return createRequest({ purpose: 'raffle', showId, params: raffleParams(showId, entrants), revealWindowS: window }, d);
}
