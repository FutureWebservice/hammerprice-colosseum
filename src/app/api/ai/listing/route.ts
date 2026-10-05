import { AiListingRequest, ApiError, AI_PACK_PRICE_USDC, type Cluster } from '@/contracts';
import { json } from '@/lib/http/respond';
import { assertRate, rateLimitIp, rateLimitWallet } from '@/lib/http/ratelimit';
import { requireSessionProfile } from '@/lib/auth/session';
import { feeWalletAddress, resolveCluster, usdcMintFor } from '@/lib/chain/config';
import { settlementAuthority } from '@/lib/chain/keys';
import { assertAiRate, requireAi, readBigBody } from '@/server/ai/http';
import { createListing, PaymentRequired } from '@/server/ai/listing';
import { CREDIT_ROUND_S } from '@/server/credits/service';
import { chainRoute } from '@/server/settlement/http';

export const maxDuration = 30;
/** Body cap: three photos of at most 600 KB (as base64) plus the fields. */
const MAX_BODY = 1_500_000;

/** The 402 answer: the terms of the credit pack, x402-style (the transport headers of the x402 specification are not claimed). */
async function paymentRequired(cluster: Cluster): Promise<Response> {
  const feeWallet = feeWalletAddress();
  if (!feeWallet) throw new ApiError('paused', 'Credits are paused: the platform wallet is not configured.');
  return json({
    ok: false, code: 'payment_required', reason: 'You have no listing draft credits left. A pack of 10 costs 1 USDC.',
    scheme: 'exact', network: cluster, amount: AI_PACK_PRICE_USDC, asset: usdcMintFor(cluster), payTo: feeWallet, maxTimeoutSeconds: CREDIT_ROUND_S,
    extra: { feePayer: settlementAuthority().publicKey.toBase58() }, quoteUrl: '/api/ai/credits/quote',
  }, 'none', { status: 402 });
}

/** A listing draft (AI, or the template when there is no key, no budget or Google fails). Costs one credit only when the model answered. */
export const POST = chainRoute(async (req: Request) => {
  await requireAi();
  const { session, profile } = await requireSessionProfile(req);
  await assertAiRate(req, session.wallet);
  assertRate(await rateLimitWallet('ai-listing-m', session.wallet, 3, 60));
  assertRate(await rateLimitWallet('ai-listing-d', session.wallet, 30, 86_400));
  assertRate(await rateLimitIp('ai-listing-d', req, 20, 86_400));
  const body = await readBigBody(req, AiListingRequest, MAX_BODY);
  const cluster = resolveCluster();
  const { db } = await import('@/db');
  try {
    return json(await createListing(profile, body, { db, cluster }));
  } catch (e) {
    if (e instanceof PaymentRequired) return paymentRequired(cluster);
    throw e;
  }
});
