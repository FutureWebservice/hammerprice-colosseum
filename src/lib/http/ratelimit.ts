/**
 * Fixed-window rate limits in the `rate_limits` table, shared by every serverless instance (the in-memory
 * limiter this replaces counted per isolate, so it limited nothing).
 *
 * One statement per check: INSERT ... ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
 * RETURNING count. Concurrent requests serialise on the row, so the count is exact. The known ceiling of a
 * fixed window: a caller can spend the limit at the end of one window and again at the start of the next.
 *
 * A write path fails CLOSED (the database error propagates and the request fails, it is not waved through).
 * A read path may pass `failOpen: true`: then a database error is logged and the request is allowed,
 * because limiting a read is not worth an outage.
 */
import { isIPv6 } from 'node:net';
import { sql } from 'drizzle-orm';
import { ApiError } from '@/contracts/errors';
import { rateLimits } from '@/db/schema';

export interface RateResult { ok: boolean; retryAfterS: number }
export interface RateOptions { nowMs?: number; failOpen?: boolean }

async function getDb() {
  return (await import('@/db')).db;
}

export async function rateLimit(key: string, limit: number, windowS: number, opts: RateOptions = {}): Promise<RateResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = windowS * 1000;
  const start = Math.floor(nowMs / windowMs) * windowMs;
  try {
    const db = await getDb();
    const [row] = await db
      .insert(rateLimits)
      .values({ key, windowStart: new Date(start), count: 1 })
      .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } })
      .returning({ count: rateLimits.count });
    // Old windows are dead weight; one request in a hundred sweeps them so the table stays small without a cron.
    if (Math.random() < 0.01) void purgeRateLimits(new Date(nowMs - 86_400_000)).catch(() => {});
    return row.count <= limit ? { ok: true, retryAfterS: 0 } : { ok: false, retryAfterS: Math.max(1, Math.ceil((start + windowMs - nowMs) / 1000)) };
  } catch (e) {
    if (!opts.failOpen) throw e;
    console.warn('rate limit check failed, allowing the read', key.split(':')[0], (e as Error).message);
    return { ok: true, retryAfterS: 0 };
  }
}

export async function purgeRateLimits(before: Date): Promise<void> {
  const db = await getDb();
  await db.delete(rateLimits).where(sql`${rateLimits.windowStart} < ${before}`);
}

/** IPv6 callers are keyed by their /64 (the smallest block a home or phone connection is handed), so one attacker cannot mint 2^64 "different" addresses. */
export function normalizeIp(raw: string): string {
  const s = (raw.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1]!;
  if (!isIPv6(s)) return s.slice(0, 64);
  const [head = '', tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g || '0', 16).toString(16)).join(':')}::/64`;
}

/**
 * The caller's address. On Vercel the platform overwrites x-vercel-forwarded-for, x-real-ip and x-forwarded-for with the address
 * it saw, so they are the caller's real address and cannot be chosen by the caller. Anywhere else every one of those headers is
 * whatever the client sent, so they are ignored (one shared key, which only ever limits more) unless the operator states that a
 * proxy of theirs sets them (TRUST_PROXY_HEADERS=true); then x-real-ip, or the LAST x-forwarded-for hop (the one that proxy
 * appended; an attacker can only add hops before it).
 */
export function clientIp(req: Request, env: Record<string, string | undefined> = process.env): string {
  const h = req.headers;
  let ip: string | null | undefined;
  if (env.VERCEL) ip = h.get('x-vercel-forwarded-for') ?? h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0];
  else if (env.TRUST_PROXY_HEADERS === 'true') ip = h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',').at(-1);
  return normalizeIp(ip ?? '') || 'unknown';
}

/** Per wallet: `bucket` names the route (`bid`, `paddle`, ...), so two routes never share a counter. */
export const rateLimitWallet = (bucket: string, wallet: string, limit: number, windowS: number, opts?: RateOptions): Promise<RateResult> =>
  rateLimit(`w:${bucket}:${wallet}`, limit, windowS, opts);

export const rateLimitIp = (bucket: string, req: Request, limit: number, windowS: number, opts?: RateOptions): Promise<RateResult> =>
  rateLimit(`ip:${bucket}:${clientIp(req)}`, limit, windowS, opts);

/**
 * One shared per-address budget for every route where a signed-in caller makes US spend RPC calls (readiness, card list, paddle balance read,
 * show creation, settlement prepare/sign). Per-wallet limits alone are not a bound: sign-in is free, so one address can bring any number of wallets.
 */
export const rateLimitChain = (req: Request, opts: RateOptions & { limit?: number } = {}): Promise<RateResult> => rateLimitIp('rpc', req, opts.limit ?? 300, 60, opts);

/** Turns a refused check into the 429 (`Retry-After` is set by respond.fail from `retryAfterS`). */
export function assertRate(r: RateResult): void {
  if (!r.ok) throw new ApiError('rate_limited', 'Too many requests, try again shortly', { retryAfterS: r.retryAfterS });
}
