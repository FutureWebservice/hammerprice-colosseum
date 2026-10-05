/**
 * AI configuration, read from an env object you pass in (default process.env). Pure: no I/O, nothing printed.
 *
 * ONE small adapter, two ways to reach Google: `gemini-api` (the default, an AI Studio API key in
 * GEMINI_API_KEY) or `vertex` (a service account in GCP_SERVICE_ACCOUNT_JSON, raw JSON or base64). Same body, same cost caps.
 * Without credentials (and without AI_MOCK) the features fall back to templates and the FAQ search: they never fail and never cost.
 */
type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const AI_PROVIDERS = ['gemini-api', 'vertex'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/** US dollars per million tokens, i.e. millionths of a dollar per token. Output includes thinking tokens (ai.google.dev pricing page, read 2026-10-02). */
export const PRICES: Record<string, { in: number; out: number }> = {
  'gemini-3.5-flash-lite': { in: 0.3, out: 2.5 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.5 },
};
/** An unknown model id is priced like the dearer table row, so a typo in AI_MODEL can only overestimate. */
export const FALLBACK_PRICE = { in: 0.3, out: 2.5 };

/** The most one listing draft or one question may cost; reserved before the call, replaced by the real cost after. Millionths of a USD. */
export const RESERVE_LISTING_MICRO = 6000;
export const RESERVE_ASK_MICRO = 2000;
export const RESERVE_AGENT_MICRO = 3000;
export const MAX_OUTPUT_LISTING = 1200;
export const MAX_OUTPUT_ASK = 64;
export const MAX_OUTPUT_AGENT = 200;

export interface AiConfig {
  provider: AiProvider;
  model: string;
  /** AI_MOCK=1 (ignored on a Vercel production deployment): a server-side fake model for tests and demos, no network. */
  mock: boolean;
  apiKey: string | null;
  serviceAccountRaw: string | null;
  project: string | null;
  location: string;
  /** Hard budgets in millionths of a USD. */
  dailyMicro: number;
  monthlyMicro: number;
  /** Model calls in flight at once, across all instances (reservations not yet settled). Over it, the template or the FAQ answers. */
  maxConcurrent: number;
  /** The circuit breaker: this many upstream failures (network, timeout, HTTP error) within breakerWindowS stop model calls until they age out. */
  breakerErrors: number;
  breakerWindowS: number;
}

/** A positive whole number from the environment; anything else (empty, 0, negative, text, a decimal) is the fallback. The ceiling keeps a typo from meaning "no limit". */
const posInt = (raw: string | undefined, fallback: number, max = 100_000): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isInteger(n) && n >= 1 ? Math.min(n, max) : fallback;
};

/** Rate limits of every AI route, per wallet and per address, per minute, hour and day (fixed windows). Safe defaults; each is an env override. */
export interface AiRates { wallet: { min: number; hour: number; day: number }; ip: { min: number; hour: number; day: number } }
export function aiRateLimits(env: Env = process.env): AiRates {
  return {
    wallet: { min: posInt(env.AI_RATE_PER_MIN, 6), hour: posInt(env.AI_RATE_PER_HOUR, 60), day: posInt(env.AI_RATE_PER_DAY, 300) },
    ip: { min: posInt(env.AI_RATE_IP_PER_MIN, 20), hour: posInt(env.AI_RATE_IP_PER_HOUR, 100), day: posInt(env.AI_RATE_IP_PER_DAY, 100) },
  };
}

const usd = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000) : Math.round(fallback * 1_000_000);
};

export const mockAllowed = (env: Env = process.env): boolean => env.AI_MOCK === '1' && env.VERCEL_ENV !== 'production';

export function aiConfig(env: Env = process.env): AiConfig {
  const p = env.AI_PROVIDER?.trim();
  const provider: AiProvider = p === 'vertex' ? 'vertex' : 'gemini-api';
  const m = env.AI_MODEL?.trim();
  return {
    provider,
    model: m && /^[a-z0-9][a-z0-9.-]{2,60}$/.test(m) ? m : DEFAULT_MODEL,
    mock: mockAllowed(env),
    apiKey: env.GEMINI_API_KEY?.trim() || null,
    serviceAccountRaw: env.GCP_SERVICE_ACCOUNT_JSON?.trim() || null,
    project: env.GOOGLE_CLOUD_PROJECT?.trim() || null,
    location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
    dailyMicro: usd(env.AI_DAILY_BUDGET_USD, 1),
    monthlyMicro: usd(env.AI_MONTHLY_BUDGET_USD, 10),
    maxConcurrent: posInt(env.AI_MAX_CONCURRENT, 8, 1000),
    breakerErrors: posInt(env.AI_BREAKER_ERRORS, 5, 1000),
    breakerWindowS: posInt(env.AI_BREAKER_WINDOW_S, 120, 3600),
  };
}

/** A model call is possible here: the mock, a key (gemini-api), or a service account plus a project (vertex). */
export function aiConfigured(env: Env = process.env): boolean {
  const c = aiConfig(env);
  if (c.mock) return true;
  return c.provider === 'vertex' ? !!c.serviceAccountRaw && !!c.project : !!c.apiKey;
}

/** AI_FREE (exactly 'true'): AI costs no credits during the judging period. Budgets, rate limits and the kill switch are unchanged. */
export const aiFree = (env: Env = process.env): boolean => env.AI_FREE === 'true';

/** Credit packs one wallet may buy per day: AI_PACKS_PER_WALLET_DAY (default 3) off mainnet; on mainnet a safety ceiling of 50. null never happens. */
export function packsPerWalletDay(mainnet: boolean, env: Env = process.env): number {
  if (mainnet) return 50;
  const n = Number(env.AI_PACKS_PER_WALLET_DAY);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 3;
}

/** Daily cap on credit purchases the settlement authority sponsors (it pays about 0.00001 SOL for each). */
export function saCreditPurchasesPerDay(env: Env = process.env): number {
  const n = Number(env.SA_CREDIT_PURCHASES_PER_DAY);
  return Number.isInteger(n) && n >= 0 ? n : 60;
}

export interface Usage { inputTokens: number; outputTokens: number; thinkingTokens: number }

/** Millionths of a USD for one call: input at the input price, output and thinking tokens at the output price, rounded up. */
export function costMicroUsd(u: Usage, model: string): number {
  const p = PRICES[model] ?? FALLBACK_PRICE;
  return Math.ceil(u.inputTokens * p.in + (u.outputTokens + u.thinkingTokens) * p.out);
}
