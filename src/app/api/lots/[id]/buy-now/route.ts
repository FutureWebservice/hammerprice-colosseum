import { BuyNowRequest } from '@/contracts';
import { json } from '@/lib/http/respond';
import { readBody, route } from '@/lib/auth/route';
import { auctionService } from '@/app/api/auctions/_shared/deps';
import { type IdCtx, paramId } from '@/app/api/auctions/_shared/http';
import { authorizeIntent } from '@/app/api/auctions/_shared/intent';

/** Buy Now: a wallet-signed intent for exactly the buy-now price wins the lot through the same sale path as a timed close. */
export const POST = route(async (req: Request, ctx: IdCtx) => {
  const lotId = await paramId(ctx, 'Lot');
  const body = await readBody(req, BuyNowRequest);
  const a = await authorizeIntent(req, { lotId, ...body }, { bucket: 'buy-now', walletOnly: true });
  const { settlementId } = await auctionService().buyNow({
    lotId, buyerProfileId: a.profileId, buyerWallet: a.wallet, amount: BigInt(body.amount), fundsBalance: a.fundsBalance,
    message: body.intent.message, signature: body.intent.signature, nonce: a.nonce,
  });
  return json({ ok: true, settlementId });
});
