/**
 * Which host names are "us", and the CSRF check for cookie-authenticated writes.
 *
 * SameSite=Lax already keeps the session cookie off cross-site POSTs; this is the second lock. A browser
 * always sends `Origin` on a POST (and `Sec-Fetch-Site` on every request), so a write that comes from
 * another site is refused here. A client that sends neither header is not a browser and cannot be tricked
 * into sending our cookie, so curl and scripts keep working.
 */
import { ApiError } from '@/contracts/errors';

type Env = Record<string, string | undefined>;

/** Host names from configuration: NEXT_PUBLIC_SITE_URL and, on Vercel, the production alias. Lowercase, with port. */
export function configuredHosts(env: Env = process.env): string[] {
  const hosts = new Set<string>();
  const site = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (site) {
    try { hosts.add(new URL(site).host.toLowerCase()); } catch { /* an unparseable value names no host */ }
  }
  const prod = env.VERCEL_PROJECT_PRODUCTION_URL?.trim().toLowerCase();
  if (prod && /^[a-z0-9.-]+$/.test(prod)) hosts.add(prod);
  return [...hosts];
}

export const requestHost = (req: Request): string => (req.headers.get('host') ?? new URL(req.url).host).toLowerCase();

/** A production deployment, or a local `next start` (NODE_ENV=production without Vercel). Preview and `next dev` are not. */
export const isProduction = (env: Env = process.env): boolean =>
  env.VERCEL_ENV ? env.VERCEL_ENV === 'production' : env.NODE_ENV === 'production';

/**
 * Hosts a sign-in message may name. Production accepts only the configured site (a phishing site that
 * proxies to us sets its own Host header, so the request's host proves nothing there) and fails closed
 * when none is configured. Elsewhere the request's own host is accepted, which is what localhost and
 * preview URLs need.
 */
export function loginHosts(req: Request, env: Env = process.env): string[] {
  const configured = configuredHosts(env);
  if (isProduction(env)) {
    if (configured.length === 0) throw new ApiError('paused', 'Sign-in is not configured for this host');
    return configured;
  }
  return [...new Set([...configured, requestHost(req)])];
}

/** Refuses a write that a browser sent from another origin (403 forbidden). */
export function assertSameOrigin(req: Request, env: Env = process.env): void {
  const origin = req.headers.get('origin');
  if (origin !== null) {
    let host: string | null = null;
    try { host = new URL(origin).host.toLowerCase(); } catch { /* 'null' and junk fall through to refusal */ }
    if (host === null || (host !== requestHost(req) && !configuredHosts(env).includes(host))) throw new ApiError('forbidden', 'Cross-origin request refused');
    return;
  }
  const site = req.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none') throw new ApiError('forbidden', 'Cross-site request refused');
}

/** State-changing routes take JSON only: a cross-site HTML form cannot send that content type without a preflight. */
export function assertJson(req: Request): void {
  const type = req.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError('validation', 'Content-Type must be application/json');
}
