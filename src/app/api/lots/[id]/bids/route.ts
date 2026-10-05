import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { ApiError, type LotBidsResponse, ROUTES } from '@/contracts';
import { bids, lots, paddles, profiles, settlements, shows } from '@/db/schema';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { type IdCtx, getDb, paramId } from '@/app/api/auctions/_shared/http';

type Body = z.infer<typeof LotBidsResponse>;
const ms = (d: Date) => d.getTime();

/**
 * The audit data behind /verify/[lotId]: every accepted bid's signed text, signature and the key that made it, in the same
 * order the bid-log hash uses ((placed_at at millisecond precision, then id), so the page can recompute the hash), and the lot's
 * settlement anchor. Public and identical for every viewer; paddle numbers only appear next to a bid, never a profile.
 * A 'house' bid was signed by the house bidder's own wallet key, so it is reported as a wallet signature.
 */
export const GET = route(async (_req: Request, ctx: IdCtx) => {
  const lotId = await paramId(ctx, 'Lot');
  const db = await getDb();
  const [lot] = await db
    .select({ id: lots.id, number: lots.lotNumber, name: lots.name, showId: lots.showId, isHouse: shows.isHouse })
    .from(lots)
    .leftJoin(shows, eq(shows.id, lots.showId))
    .where(eq(lots.id, lotId));
  if (!lot || !lot.showId) throw new ApiError('not_found', 'Lot not found');

  const [rows, [settlement]] = await Promise.all([
    db
      .select({
        id: bids.id, amount: bids.amount, placedAt: bids.placedAt, via: bids.via, message: bids.message, signature: bids.signature,
        wallet: profiles.walletAddress, paddle: paddles.number, sessionPubkey: paddles.sessionPubkey,
      })
      .from(bids)
      .innerJoin(profiles, eq(profiles.id, bids.bidderId))
      .leftJoin(paddles, eq(paddles.id, bids.paddleId))
      .where(eq(bids.lotId, lotId)),
    // A live settlement wins over an expired one; otherwise the latest.
    db
      .select({ id: settlements.id, hash: settlements.bidLogHash, tx: settlements.txSignature, cluster: settlements.cluster })
      .from(settlements)
      .where(eq(settlements.lotId, lotId))
      .orderBy(sql`(${settlements.status} in ('awaiting_payment','awaiting_seller','submitted','settled')) desc`, sql`${settlements.dueAt} desc nulls last`)
      .limit(1),
  ]);

  const ordered = [...rows].sort((a, b) => ms(a.placedAt) - ms(b.placedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const body: Body = {
    lot: { id: lot.id, number: lot.number, name: lot.name, showId: lot.showId, isHouse: lot.isHouse === true },
    bids: ordered.map((b) => {
      const session = b.via === 'session' && b.sessionPubkey !== null;
      return {
        id: b.id, amount: b.amount.toString(), placedAt: b.placedAt.toISOString(), paddle: b.paddle ?? null, message: b.message, signature: b.signature,
        signer: session ? ('session' as const) : ('wallet' as const), signerPubkey: session ? b.sessionPubkey! : b.wallet,
      };
    }),
    settlement: settlement?.hash
      ? { id: settlement.id, bidLogHash: settlement.hash, txSignature: settlement.tx, cluster: settlement.cluster === 'devnet' || settlement.cluster === 'mainnet-beta' ? settlement.cluster : null }
      : null,
  };
  return json(body, ROUTES.lotBids.cache);
});
