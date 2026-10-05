/**
 * What the browser checks BEFORE a wallet is asked to sign a credit purchase, from facts it knows itself, never from the quote's own say-so:
 * the amount is the pack price, the buyer is the connected wallet, the memo is the one of the purchase, the mint is the cluster's (the real
 * USDC mint on mainnet, the configured test mint on devnet), the fee wallet is the one the build was configured with (when it was). Pure.
 */
import { AI_PACK_PRICE_USDC, type AiCreditsQuoteResponse, type Cluster } from '@/contracts';
import type { z } from 'zod';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { creditMemo, ExpectedCredit } from '@/lib/chain/credit-tx';

type Quote = z.infer<typeof AiCreditsQuoteResponse>;

export class QuoteRefused extends Error {
  constructor(readonly why: string) { super(why); this.name = 'QuoteRefused'; }
}

export interface Pinned { mint?: string; feeWallet?: string }
/** Direct `process.env.NEXT_PUBLIC_*` reads, because only those are inlined into the browser bundle. */
export const pinnedFromBuild = (): Pinned => ({ mint: process.env.NEXT_PUBLIC_USDC_MINT || undefined, feeWallet: process.env.NEXT_PUBLIC_PLATFORM_WALLET_ADDRESS || undefined });

export function expectedFromQuote(q: Quote, o: { wallet: string; cluster: Cluster; pinned?: Pinned }): ExpectedCredit {
  const refuse = (why: string): never => { throw new QuoteRefused(why); };
  if (q.expected.buyer !== o.wallet) refuse('buyer is not the connected wallet');
  if (q.expected.amount !== AI_PACK_PRICE_USDC) refuse('amount is not the pack price');
  if (q.expected.memo !== creditMemo(q.purchaseId)) refuse('memo is not the purchase memo');
  if (o.cluster === 'mainnet-beta' && q.expected.mint !== MAINNET_USDC_MINT) refuse('mint is not the mainnet USDC mint');
  if (o.pinned?.mint && q.expected.mint !== o.pinned.mint) refuse('mint differs from this build');
  if (o.pinned?.feeWallet && q.expected.feeWallet !== o.pinned.feeWallet) refuse('fee wallet differs from this build');
  const parsed = ExpectedCredit.safeParse({
    purchaseId: q.purchaseId, cluster: o.cluster, buyer: q.expected.buyer, feePayer: q.expected.feePayer, feeWallet: q.expected.feeWallet, usdcMint: q.expected.mint, amount: q.expected.amount, memo: q.expected.memo,
  });
  return parsed.success ? parsed.data : refuse('expected purchase is invalid');
}
