/** Small plumbing every LIVE route repeats: the `:id` path parameter, the query string, the database handle. */
import type { ZodTypeAny, z } from 'zod';
import { ApiError } from '@/contracts';
import { isValidUuid } from '@/lib/uuid';

export type IdCtx = { params: Promise<{ id: string }> };

/** The `:id` segment, lower-cased. A malformed id is a 404 (it can never name a row), not a database error. */
export async function paramId(ctx: IdCtx, what: string): Promise<string> {
  const { id } = await ctx.params;
  if (!isValidUuid(id)) throw new ApiError('not_found', `${what} not found`);
  return id.toLowerCase();
}

/** The query string checked against a strict zod schema (unknown keys are refused). */
export function parseQuery<S extends ZodTypeAny>(req: Request, schema: S): z.output<S> {
  const r = schema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!r.success) throw new ApiError('validation', r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; ').slice(0, 300));
  return r.data;
}

/** The database, opened on first use so importing a route never needs DATABASE_URL. */
export async function getDb() {
  return (await import('@/db')).db;
}
