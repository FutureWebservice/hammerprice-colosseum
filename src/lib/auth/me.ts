/**
 * What `GET /api/me` answers: who the viewer is and, with `?show=`, where they stand in that show.
 * Everything beyond the identity is best effort: a slow RPC or an unwired service leaves that field
 * out (`funds.usdc: null`, no `paddle`, no `standing`), it never fails the request.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { MeResponse } from '@/contracts';
import { bids, lots, paddles, settlements } from '@/db/schema';
import { auctionService, chainApi } from './deps';
import type { ProfileRow } from './store';

/** A paddle badge means something only while the wallet holds at least this much USDC (1 USDC, 6 dp). */
export const MIN_PADDLE_USDC = 1_000_000n;

async function getDb() {
  return (await import('@/db')).db;
}

/** Wallet USDC minus what this profile already owes (leading bids, unpaid wins); null when either is unreadable. */
async function availableUsdc(wallet: string, profileId: string): Promise<bigint | null> {
  try {
    const [balance, committed] = await Promise.all([chainApi().getUsdcBalance(wallet), auctionService().commitmentsFor(profileId)]);
    return balance > committed ? balance - committed : 0n;
  } catch {
    return null;
  }
}

export async function buildMe(profile: ProfileRow, showId: string | undefined, nowMs = Date.now()): Promise<MeResponse> {
  const db = await getDb();
  const now = new Date(nowMs);

  const [available, paddleRow, pending] = await Promise.all([
    availableUsdc(profile.walletAddress, profile.id),
    showId
      ? db.select({ id: paddles.id, number: paddles.number, validUntil: paddles.validUntil }).from(paddles)
          .where(and(eq(paddles.showId, showId), eq(paddles.profileId, profile.id), isNull(paddles.revokedAt), gt(paddles.validUntil, now))).limit(1)
      : Promise.resolve([]),
    db.select({ id: settlements.id, lotId: settlements.lotId, showId: lots.showId, buyerId: settlements.buyerId, buyerSignature: settlements.buyerSignature, status: settlements.status, dueAt: settlements.dueAt, gross: settlements.grossAmount })
      .from(settlements)
      .innerJoin(lots, eq(lots.id, settlements.lotId))
      .where(and(
        or(eq(settlements.buyerId, profile.id), eq(settlements.sellerId, profile.id)),
        inArray(settlements.status, ['awaiting_payment', 'awaiting_seller', 'submitted']),
        isNotNull(settlements.dueAt),
        gt(settlements.dueAt, now),
      ))
      .orderBy(asc(settlements.dueAt)).limit(20),
  ]);

  const me: MeResponse = {
    wallet: profile.walletAddress,
    profile: { id: profile.id, isSeller: profile.isSeller, strikes: profile.strikes },
    funds: { usdc: available === null ? null : available.toString() },
    pending: pending.map((p) => ({
      settlementId: p.id,
      lotId: p.lotId,
      showId: p.showId!,
      role: p.buyerId === profile.id ? 'buyer' as const : 'seller' as const,
      status: p.status as MeResponse['pending'][number]['status'],
      dueAt: p.dueAt!.toISOString(),
      gross: p.gross.toString(),
      buyerSigned: !!p.buyerSignature,
    })),
  };

  const paddle = paddleRow[0];
  if (showId && paddle) {
    me.paddle = { number: paddle.number, validUntil: paddle.validUntil.toISOString(), funded: available !== null && available >= MIN_PADDLE_USDC };
    try {
      const snap = await auctionService().getLiveSnapshot(showId);
      const lotId = snap?.current?.lotId;
      const lot = snap?.lots.find((l) => l.id === lotId);
      if (lotId && lot) {
        if (lot.highBidder?.paddle === paddle.number) me.standing = { lotId, status: 'leading' };
        else {
          const [mineBid] = await db.select({ id: bids.id }).from(bids).where(and(eq(bids.lotId, lotId), eq(bids.bidderId, profile.id))).limit(1);
          if (mineBid) me.standing = { lotId, status: 'outbid' };
        }
      }
    } catch { /* no standing without the snapshot */ }
  }
  return me;
}
