/**
 * Everything between "a signed intent arrived" and "the engine may record it", in the order the cost of each step allows:
 * parse the text, find the lot, paddle and profile in ONE query, verify the signature, then the paddle's own limits, then the
 * rate limits, and only then the one network call (the USDC balance). Cheap, unauthenticated rejections come first, so junk
 * never spends a wallet's rate budget or an RPC call, and nothing here holds a database lock (the engine takes its own).
 *
 * Who signed is established by the intent itself: 'wallet' by the bidder's key, 'session' by the registered paddle key. A session
 * cookie is optional; when present its wallet must equal the intent's bidder. The paddle is resolved by (show, bidder), and the
 * intent's `paddle` field, when it names one, must agree. The nonce is the replay guard (`bids_bidder_nonce_idx`, enforced by the engine).
 */
import { and, eq } from 'drizzle-orm';
import { ApiError, type BidRequest, type Cluster } from '@/contracts';
import { bids, lots, paddles, profiles } from '@/db/schema';
import { resolveCluster } from '@/lib/chain/config';
import { assertClusterReady } from '@/lib/chain/cluster';
import { assertRate, rateLimitIp, rateLimitWallet } from '@/lib/http/ratelimit';
import { PADDLE_LIMIT_DETAIL, paddleAllows, parseBidIntent, verifyBidIntent } from '@/lib/auth/intent';
import { getSession } from '@/lib/auth/session';
import { chainService } from './deps';
import { flagOn } from './flags';
import { getDb } from './http';

export interface AuthorizedIntent {
  showId: string;
  profileId: string;
  wallet: string;
  paddleId: string;
  signer: 'wallet' | 'session';
  nonce: string;
  fundsBalance: bigint;
}

export async function authorizeIntent(
  req: Request,
  request: BidRequest,
  opts: { /** rate-limit bucket of the wallet window (1 request per 2 s) */ bucket: string; /** Buy Now is a purchase: the wallet itself must sign */ walletOnly?: boolean },
): Promise<AuthorizedIntent> {
  assertClusterReady(); // fail closed: an incomplete or contradictory cluster configuration refuses before any row or balance is read
  const nowMs = Date.now();
  const { intent, lotId } = request;
  if (opts.walletOnly && intent.signer !== 'wallet') throw new ApiError('bad_signature', 'This purchase must be signed by your wallet, not by a paddle key');
  const fields = parseBidIntent(intent.message);
  if (!fields) throw new ApiError('bad_signature', 'The signed text is not a valid bid for this network');

  const db = await getDb();
  const [row] = await db
    .select({
      showId: lots.showId, profileId: profiles.id, banned: profiles.isBanned,
      usedBidId: bids.id, paddleId: paddles.id, sessionPubkey: paddles.sessionPubkey, maxBid: paddles.maxBid, validUntil: paddles.validUntil, revokedAt: paddles.revokedAt,
    })
    .from(lots)
    .leftJoin(profiles, eq(profiles.walletAddress, fields.bidder))
    .leftJoin(paddles, and(eq(paddles.showId, lots.showId), eq(paddles.profileId, profiles.id)))
    .leftJoin(bids, and(eq(bids.bidderId, profiles.id), eq(bids.nonce, fields.nonce)))
    .where(eq(lots.id, lotId));
  if (!row || !row.showId) throw new ApiError('not_found', 'Lot not found');

  const session = await getSession(req, nowMs);
  if (!verifyBidIntent({ request, showId: row.showId, sessionWallet: session?.wallet ?? null, paddleSessionPubkey: row.sessionPubkey ?? null, nowMs })) {
    throw new ApiError('bad_signature', 'The signature does not match this bid, or the bid is stale');
  }
  if (!row.profileId || !row.paddleId || !row.validUntil) throw new ApiError('no_paddle', 'Register a paddle for this show to bid');
  if (fields.paddle !== null && fields.paddle !== row.paddleId) throw new ApiError('no_paddle', 'The bid names a paddle that is not yours in this show');
  if (row.banned) throw new ApiError('banned', 'This account cannot bid');
  // The audit log publishes every accepted intent. Refuse a replay of one here, before the limiter: otherwise anybody could re-send a victim's
  // public bid every 2 s and keep the victim's own wallet window full, so the victim's next bid is answered 429 (a bid-blocking grief).
  if (row.usedBidId) throw new ApiError('replay', 'This bid was already submitted');

  if (intent.signer === 'session') {
    const paddle = { validUntil: row.validUntil, maxBid: row.maxBid, revokedAt: row.revokedAt };
    if (!paddleAllows(paddle, BigInt(request.amount), nowMs)) {
      const overLimit = !row.revokedAt && row.validUntil.getTime() > nowMs;
      // `detail` is an additive field: the code stays no_paddle (older clients keep working); the room tells "over your limit" from "no bidder number" by it.
      throw new ApiError('no_paddle', row.revokedAt ? 'This paddle was revoked' : !overLimit ? 'This paddle has expired' : 'That is above the maximum this paddle key was authorised for', overLimit ? { detail: PADDLE_LIMIT_DETAIL } : {});
    }
  }

  if (!(await flagOn('bidding'))) throw new ApiError('paused', 'Bidding is paused');
  assertRate(await rateLimitWallet(opts.bucket, fields.bidder, 1, 2));
  assertRate(await rateLimitIp('bid', req, 60, 60));

  // The one network call, before the engine's transaction so no row lock spans it. Fail closed: an unreadable balance is "try again".
  let fundsBalance: bigint;
  try {
    fundsBalance = await chainService().getUsdcBalance(fields.bidder, resolveCluster() as Cluster);
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError('balance_unavailable', 'Could not read your USDC balance, try again');
  }
  return { showId: row.showId, profileId: row.profileId, wallet: fields.bidder, paddleId: row.paddleId, signer: intent.signer, nonce: fields.nonce, fundsBalance };
}
