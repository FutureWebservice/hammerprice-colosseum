/**
 * Plumbing the CHAIN routes share. AUTH's `route()` already turns an ApiError into the one error response; this adds
 * the two cases that belong to the chain layer: a bad or missing environment value is "payments are paused" (503, logged
 * by message only, which never holds a secret), and an id in the path that is not a uuid is "not found" before any query.
 */
import { ApiError } from '@/contracts';
import { route } from '@/lib/auth/route';
import { ConfigError } from '@/lib/chain/errors';
import { isValidUuid } from '@/lib/uuid';

export type IdCtx = { params: Promise<{ id: string }> };

export function chainRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response>): (...args: A) => Promise<Response> {
  return route(async (...args: A) => {
    try {
      return await handler(...args);
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error('chain configuration:', e.message);
        throw new ApiError('paused', 'Payments are paused: the server is not set up correctly. Try again later.');
      }
      throw e;
    }
  });
}

export async function idParam(ctx: IdCtx, what: string): Promise<string> {
  const { id } = await ctx.params;
  if (!isValidUuid(id)) throw new ApiError('not_found', `No such ${what}`);
  return id.toLowerCase();
}

/**
 * The origin that on-chain metadata URIs and links are built from: the configured site when there is one (NEXT_PUBLIC_SITE_URL),
 * otherwise this request's own origin (previews and local runs).
 */
export function publicOrigin(req: Request, env: Record<string, string | undefined> = process.env): string {
  const site = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) {
    try { return new URL(site).origin; } catch { /* an unparseable value names no origin */ }
  }
  return new URL(req.url).origin;
}
