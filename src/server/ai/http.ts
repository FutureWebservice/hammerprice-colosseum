/** Plumbing the AI routes share: the feature gate and a JSON body reader with a bigger cap than the 16 KB of the money routes (photos). */
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '@/contracts';
import { featureOn } from '@/lib/features';
import { assertJson, assertSameOrigin } from '@/lib/http/origin';
import { assertRate, rateLimitIp, rateLimitWallet } from '@/lib/http/ratelimit';
import { aiRateLimits } from './config';

/** FEATURE_AI off (or the ops switch `ai` off) answers as if the route did not exist. */
export async function requireAi(): Promise<void> {
  if (!(await featureOn('AI'))) throw new ApiError('feature_off', 'Not found');
}

/**
 * The shared limit of every AI route, AFTER the wallet session and BEFORE any model call or cost accounting: per wallet AND per address, per
 * minute, hour and day (AI_RATE_PER_MIN / _HOUR / _DAY and AI_RATE_IP_PER_MIN / _HOUR / _DAY, defaults 6/60/300 and 20/100/100). The address layer
 * is what stops one person who brings many wallets (sign-in is free). The counters live in the database and a database error fails the request
 * (closed): a model call is never waved through because the limiter was down.
 */
export async function assertAiRate(req: Request, wallet: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const l = aiRateLimits(env);
  assertRate(await rateLimitWallet('ai-m', wallet, l.wallet.min, 60));
  assertRate(await rateLimitIp('ai-m', req, l.ip.min, 60));
  assertRate(await rateLimitWallet('ai-h', wallet, l.wallet.hour, 3600));
  assertRate(await rateLimitIp('ai-h', req, l.ip.hour, 3600));
  assertRate(await rateLimitWallet('ai-d', wallet, l.wallet.day, 86_400));
  assertRate(await rateLimitIp('ai-d', req, l.ip.day, 86_400));
}

/** Same checks as AUTH's readBody (same origin, JSON), with `maxBytes` instead of 16 KB. */
export async function readBigBody<S extends ZodTypeAny>(req: Request, schema: S, maxBytes: number): Promise<z.output<S>> {
  assertSameOrigin(req);
  assertJson(req);
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) throw new ApiError('validation', 'Request body too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new ApiError('validation', 'Request body too large');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ApiError('validation', 'Body is not valid JSON'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError('validation', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 300));
  return r.data;
}
