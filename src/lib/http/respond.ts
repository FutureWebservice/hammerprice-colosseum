/**
 * Response helpers for API routes: one place that decides cache headers and error bodies.
 *
 * Cache modes (contracts/api.ts RouteDef.cache): `'none'` answers `Cache-Control: no-store`;
 * `{ cdnS }` adds `Vercel-CDN-Cache-Control: max-age=<cdnS>` so Vercel's CDN may reuse the response
 * for that long while the browser still gets no-store. There is deliberately no stale-while-revalidate:
 * a lone viewer would always see the previous poll's state. next.config.js no longer sets a blanket
 * Cache-Control for /api, because a config header overrides the route's own.
 */
import { ApiError, ERROR_STATUS, errorBody, type ErrorCode } from '@/contracts/errors';

export type CacheMode = 'none' | { cdnS: number };

export function cacheHeaders(mode: CacheMode = 'none'): Record<string, string> {
  const h: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (mode !== 'none') h['Vercel-CDN-Cache-Control'] = `max-age=${Math.max(1, Math.floor(mode.cdnS))}`;
  return h;
}

/** A JSON success response. */
export function json(data: unknown, mode: CacheMode = 'none', init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...cacheHeaders(mode), ...init.headers },
  });
}

/** The 204 answer (logout, paddle release). */
export const noContent = (): Response => new Response(null, { status: 204, headers: cacheHeaders('none') });

/** The one error shape, with the status from ERROR_STATUS and Retry-After for rate limits. Never cached. */
export function fail(code: ErrorCode, reason: string, extra: Record<string, unknown> = {}): Response {
  const headers: Record<string, string> = {};
  if (code === 'rate_limited' && typeof extra.retryAfterS === 'number') headers['Retry-After'] = String(Math.ceil(extra.retryAfterS));
  return json(errorBody(code, reason, extra), 'none', { status: ERROR_STATUS[code], headers });
}

/** Turns a thrown ApiError into its response; anything else is a bug and is rethrown for Next to log as a 500. */
export function fromError(e: unknown): Response {
  if (e instanceof ApiError) return fail(e.code, e.message, e.extra);
  throw e;
}
