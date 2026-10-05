/**
 * Browser-side calls to the AI routes. Every answer is parsed with its contract schema, so a changed server shape fails loudly here and
 * not in the middle of a screen. Errors become `AiCallError` with the server's code; the components map codes to texts (`errorKey`).
 */
import { AiAgentResponse, AiAskResponse, AiCreditsQuoteResponse, AiCreditsResponse, AiListingResponse, AiPurchaseView, PaymentRequiredBody } from '@/contracts';
import { readFailure } from '@/lib/client/bidder';

export class AiCallError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryAfterS?: number, readonly payment?: ReturnType<typeof PaymentRequiredBody.parse>) {
    super(code);
    this.name = 'AiCallError';
  }
}

async function call<T>(method: 'GET' | 'POST', url: string, parse: (v: unknown) => T, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method, cache: 'no-store', ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) });
  } catch {
    throw new AiCallError('network', 0);
  }
  if (!res.ok) {
    if (res.status === 402) {
      const j = await res.clone().json().catch(() => null);
      const p = PaymentRequiredBody.safeParse(j);
      throw new AiCallError('payment_required', 402, undefined, p.success ? p.data : undefined);
    }
    const f = await readFailure(res);
    throw new AiCallError(typeof f.code === 'string' ? f.code : 'unknown', res.status, f.retryAfterS);
  }
  const json = await res.json().catch(() => null);
  try { return parse(json); } catch { throw new AiCallError('shape', res.status); }
}

export const fetchCredits = () => call('GET', '/api/ai/credits', (v) => AiCreditsResponse.parse(v));
export const fetchQuote = () => call('POST', '/api/ai/credits/quote', (v) => AiCreditsQuoteResponse.parse(v), {});
export const postPay = (purchaseId: string, signedTxBase64: string) => call('POST', '/api/ai/credits/pay', (v) => AiPurchaseView.parse(v), { purchaseId, signedTxBase64 });
export const fetchPurchase = (id: string) => call('GET', `/api/ai/credits/purchases/${encodeURIComponent(id)}`, (v) => AiPurchaseView.parse(v));
export const postListing = (body: unknown) => call('POST', '/api/ai/listing', (v) => AiListingResponse.parse(v), body);
export const postAgent = (body: { message: string; locale: 'de' | 'en'; lastResults?: { lotId: string; name: string; lotNumber?: number }[] }) => call('POST', '/api/ai/agent', (v) => AiAgentResponse.parse(v), body);
export const postAsk = (question: string, locale: 'de' | 'en') => call('POST', '/api/ai/ask', (v) => AiAskResponse.parse(v), { question, locale });

/** Which `ai.json` key explains a failed call. */
export function errorKey(e: unknown, scope: 'listing' | 'ask' | 'credits' | 'agent'): string {
  const code = e instanceof AiCallError ? e.code : 'unknown';
  if (scope === 'agent') return code === 'rate_limited' ? 'agent.rate' : code === 'validation' ? 'agent.tooLong' : 'agent.failed';
  if (scope === 'ask') return code === 'rate_limited' ? 'ask.rate' : code === 'validation' ? 'ask.tooLong' : 'ask.failed';
  if (scope === 'listing') return code === 'rate_limited' ? 'listing.errors.rate' : code === 'validation' ? 'listing.errors.notACard' : code === 'wrong_state' ? 'listing.errors.already' : 'listing.errors.generic';
  return ({ rate_limited: 'credits.limitReached', insufficient_usdc: 'credits.insufficient', round_expired: 'credits.expired', blockhash_expired: 'credits.expired', tx_mismatch: 'credits.mismatch', rpc_unavailable: 'credits.unavailable', network: 'credits.unavailable', paused: 'credits.unavailable', mainnet_config_incomplete: 'credits.unavailable', cluster_config_conflict: 'credits.unavailable' } as Record<string, string>)[code] ?? 'credits.failed';
}
