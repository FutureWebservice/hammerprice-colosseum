/**
 * The small amount of plumbing every AUTH route repeats: a bounded JSON body checked against its zod
 * schema, and a wrapper that turns a thrown ApiError into the one error response.
 */
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '@/contracts/errors';
import { fromError } from '@/lib/http/respond';
import { assertJson, assertSameOrigin } from '@/lib/http/origin';

export const MAX_BODY_BYTES = 16 * 1024;

/** A write from a browser page we served: same origin, JSON, at most 16 KB, valid against `schema`. */
export async function readBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.output<S>> {
  assertSameOrigin(req);
  assertJson(req);
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError('validation', 'Request body too large');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError('validation', 'Request body too large');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new ApiError('validation', 'Body is not valid JSON'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError('validation', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 300));
  return r.data;
}

/** Route handler wrapper: ApiError becomes its response, anything else is a bug and propagates as a 500. */
export function route<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return async (...args) => {
    try {
      return await handler(...args);
    } catch (e) {
      return fromError(e);
    }
  };
}
