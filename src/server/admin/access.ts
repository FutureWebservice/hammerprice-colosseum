/**
 * Who may open the admin panel: a signed-in wallet listed in ADMIN_WALLETS (falls back to OPERATOR_WALLETS when ADMIN_WALLETS is unset or
 * empty). Everyone else, signed in or not, gets the same 404 as for a path that does not exist, so the panel does not reveal itself.
 * Server only: neither variable has a NEXT_PUBLIC_ prefix. Every admin page and every admin API route calls this itself.
 */
import { operatorWallets } from '@/lib/auctioneer';
import { fail, fromError } from '@/lib/http/respond';
import { assertSameOrigin } from '@/lib/http/origin';
import { getSession } from '@/lib/auth/session';
import { audit } from '@/lib/auth/store';

type Env = Record<string, string | undefined>;

export function adminWallets(env: Env = process.env): string[] {
  const own = (env.ADMIN_WALLETS ?? '').split(',').map((w) => w.trim()).filter(Boolean);
  return own.length > 0 ? own : operatorWallets(env);
}

export interface Admin { wallet: string; profileId: string }

/** The admin behind this request, or null for no session, a bad session, a wallet not on the list, and an unusable server configuration. Never throws. */
export async function adminFrom(req: Request): Promise<Admin | null> {
  try {
    const session = await getSession(req);
    if (!session || !adminWallets().includes(session.wallet)) return null;
    return { wallet: session.wallet, profileId: session.profileId };
  } catch {
    return null;
  }
}

/** The cookie header of a page request (next/headers) as a Request, so pages use the same check as the API. */
export const pageRequest = (cookieHeader: string): Request => new Request('http://localhost/', { headers: { cookie: cookieHeader } });

export const notFoundResponse = (): Response => fail('not_found', 'Not found');

/**
 * Route wrapper for the admin API: 404 unless the caller is an admin; a write (`write: true`) also needs a same-origin request. ApiErrors of
 * the handler become their response. Responses are never cached (respond.json sets no-store).
 */
export function adminRoute<A extends unknown[]>(
  handler: (admin: Admin, req: Request, ...rest: A) => Promise<Response>,
  opts: { write?: boolean } = {},
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const admin = await adminFrom(req);
    if (!admin) return notFoundResponse();
    try {
      if (opts.write) assertSameOrigin(req);
      return await handler(admin, req, ...rest);
    } catch (e) {
      return fromError(e);
    }
  };
}

/** Every admin write leaves a row in audit_logs under `admin.*`. Never put an email address in `detail`. */
export const auditAdmin = (admin: Admin, action: string, target: string, detail?: unknown): Promise<void> => audit(`admin.${action}`, admin.wallet, target, detail);
