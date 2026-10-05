/**
 * Plumbing the pack routes share: the feature gate first (a switched-off feature is a 404 before anything else runs), the chain layer's
 * answers for a bad environment, a read limit for the public GETs, and a body reader with a larger limit than AUTH's 16 KB (a pack carries a
 * pool of cards).
 */
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '@/contracts';
import { assertJson, assertSameOrigin } from '@/lib/http/origin';
import { assertRate, rateLimitIp } from '@/lib/http/ratelimit';
import { chainRoute } from '@/server/settlement/http';
import { assertPacksOn } from './gate';

export const MAX_PACK_BODY_BYTES = 192 * 1024;

export function packRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return chainRoute(async (...args: A) => {
    await assertPacksOn();
    return handler(...args);
  });
}

/** Public reads: at most 120 per minute per address, and a database error does not take the read down. */
export async function readLimit(req: Request): Promise<void> {
  assertRate(await rateLimitIp('packs-read', req, 120, 60, { failOpen: true }));
}

export async function readPackBody<S extends ZodTypeAny>(req: Request, schema: S, maxBytes = MAX_PACK_BODY_BYTES): Promise<z.output<S>> {
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
