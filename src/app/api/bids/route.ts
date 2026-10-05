import { BidRequest } from '@/contracts';
import { fail, json } from '@/lib/http/respond';
import { readBody, route } from '@/lib/auth/route';
import { auctionService } from '@/app/api/auctions/_shared/deps';
import { authorizeIntent } from '@/app/api/auctions/_shared/intent';

/**
 * Place a bid. The signed intent authenticates itself (a cookie is optional), so the order is: size and JSON guard, parse and
 * verify the intent, the paddle's limits, rate limits, the USDC balance read, and only then the engine's transaction. Every
 * rejection is one of the contract's error codes; `bid_too_low` carries `minNext`. The response carries a fresh snapshot.
 */
export const POST = route(async (req: Request) => {
  const body = await readBody(req, BidRequest);
  const a = await authorizeIntent(req, body, { bucket: 'bid' });
  const r = await auctionService().placeBid({
    lotId: body.lotId, amount: BigInt(body.amount), bidderProfileId: a.profileId, bidderWallet: a.wallet, paddleId: a.paddleId, via: a.signer,
    message: body.intent.message, signature: body.intent.signature, nonce: a.nonce, fundsBalance: a.fundsBalance,
  });
  if (!r.ok) return fail(r.code, r.reason, r.minNext === undefined ? {} : { minNext: r.minNext });
  return json({ ok: true, bidId: r.bidId, amount: body.amount, belowReserve: r.belowReserve, closesAt: r.closesAt, extended: r.extended, live: r.live });
});
