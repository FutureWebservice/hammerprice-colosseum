import { ApiError, PaddleRequest } from '@/contracts';
import { isValidUuid } from '@/lib/uuid';
import { json, noContent } from '@/lib/http/respond';
import { assertSameOrigin } from '@/lib/http/origin';
import { assertRate, rateLimitChain, rateLimitWallet } from '@/lib/http/ratelimit';
import { auctionService, chainApi } from '@/lib/auth/deps';
import { paddleValidityIssue, parsePaddleAuth, verifyPaddleAuth } from '@/lib/auth/intent';
import { MIN_PADDLE_USDC } from '@/lib/auth/me';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { revokePaddle } from '@/lib/auth/store';
import { assertClusterReady } from '@/lib/chain/cluster';

type Ctx = { params: Promise<{ id: string }> };

async function showIdOf(ctx: Ctx): Promise<string> {
  const { id } = await ctx.params;
  if (!isValidUuid(id)) throw new ApiError('not_found', 'Show not found');
  return id.toLowerCase();
}

/**
 * Register a paddle: the wallet's signed PaddleAuthV1 text authorises one ephemeral key for this show.
 * The key, ceiling and expiry are read from the signed text itself; the body may repeat them but never differ.
 */
export const POST = route(async (req: Request, ctx: Ctx) => {
  const showId = await showIdOf(ctx);
  assertClusterReady();
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('paddle', session.wallet, 5, 60));
  assertRate(await rateLimitChain(req));
  const body = await readBody(req, PaddleRequest);

  const nowMs = Date.now();
  // The show comes first: how long a paddle key may live depends on its kind (6 hours live, 7 days timed, and then with a maximum bid).
  const snapshot = await auctionService().getLiveSnapshot(showId);
  if (!snapshot) throw new ApiError('not_found', 'Show not found');
  if (snapshot.show.status === 'ended') throw new ApiError('show_ended', 'This show has ended');
  const kind = snapshot.show.kind;

  const auth = verifyPaddleAuth({ message: body.message, signature: body.signature, wallet: session.wallet, showId, nowMs, kind }) ? parsePaddleAuth(body.message) : null;
  if (!auth) {
    const signed = parsePaddleAuth(body.message);
    if (signed && paddleValidityIssue(kind, signed, nowMs) === 'max_required') throw new ApiError('validation', 'A paddle that lasts longer than 6 hours needs a maximum bid amount');
    throw new ApiError('bad_signature', 'The paddle authorisation is invalid, expired or not for this show and wallet');
  }
  if (body.sessionPubkey !== undefined && body.sessionPubkey !== auth.session) throw new ApiError('validation', 'sessionPubkey differs from the signed text');
  if (body.maxBid !== undefined && (auth.max === null || BigInt(body.maxBid) !== auth.max)) throw new ApiError('validation', 'maxBid differs from the signed text');

  // Fail closed: an unreadable balance is "try again", never a paddle handed out on a guess.
  let balance: bigint;
  try {
    balance = await chainApi().getUsdcBalance(session.wallet);
  } catch (e) {
    throw e instanceof ApiError ? e : new ApiError('balance_unavailable', 'Could not read your USDC balance, try again');
  }
  if (balance < MIN_PADDLE_USDC) throw new ApiError('insufficient_funds', 'A paddle needs at least 1 USDC in your wallet');

  const paddle = await auctionService().registerPaddle({
    showId,
    profileId: profile.id,
    sessionPubkey: auth.session,
    maxBid: auth.max,
    validUntil: new Date(auth.valid),
    authMessage: body.message,
    authSignature: body.signature,
  });
  return json({ paddleId: paddle.id, number: paddle.number, validUntil: paddle.validUntil }, 'none', { status: 201 });
});

/** Revoke this wallet's paddle in the show: its session key can no longer sign bids. Idempotent. */
export const DELETE = route(async (req: Request, ctx: Ctx) => {
  const showId = await showIdOf(ctx);
  assertSameOrigin(req);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('paddle-revoke', session.wallet, 10, 60));
  await revokePaddle(showId, profile.id, new Date());
  return noContent();
});
