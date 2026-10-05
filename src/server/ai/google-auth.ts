/**
 * Vertex AI sign-in without a SDK: a service-account JWT (RS256, node:crypto) exchanged for a short-lived access token.
 * The token is kept in memory until 5 minutes before it expires. A failed exchange is not retried in a loop. The private key
 * never leaves this module and never appears in an error.
 */
import { createSign } from 'node:crypto';
import { AiError } from './errors';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface ServiceAccount { clientEmail: string; privateKey: string }

/** Raw JSON or base64 of the JSON. Anything else is `unconfigured`, with no part of the value in the message. */
export function parseServiceAccount(raw: string): ServiceAccount {
  const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
  const v = (tryJson(raw) ?? tryJson(Buffer.from(raw, 'base64').toString('utf8'))) as { client_email?: unknown; private_key?: unknown } | null;
  if (!v || typeof v.client_email !== 'string' || typeof v.private_key !== 'string' || !v.private_key.includes('PRIVATE KEY')) throw new AiError('unconfigured');
  return { clientEmail: v.client_email, privateKey: v.private_key };
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function signJwt(sa: ServiceAccount, nowS: number, aud = TOKEN_URL): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: sa.clientEmail, scope: SCOPE, aud, iat: nowS, exp: nowS + 3600 }));
  try {
    return `${head}.${body}.${b64u(createSign('RSA-SHA256').update(`${head}.${body}`).sign(sa.privateKey))}`;
  } catch {
    throw new AiError('unconfigured'); // an unreadable private key
  }
}

const cache = new Map<string, { token: string; exp: number }>();
export const clearTokenCache = (): void => cache.clear();

export async function accessToken(sa: ServiceAccount, deps: { fetch?: typeof fetch; tokenUrl?: string; now?: () => number } = {}): Promise<string> {
  const now = deps.now ?? Date.now;
  const url = deps.tokenUrl ?? TOKEN_URL;
  const key = `${url}|${sa.clientEmail}`;
  const hit = cache.get(key);
  if (hit && hit.exp - 300_000 > now()) return hit.token;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(sa, Math.floor(now() / 1000), url) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError('network');
  }
  if (!res.ok) throw new AiError('http', res.status);
  const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!j || typeof j.access_token !== 'string') throw new AiError('empty');
  const ttl = typeof j.expires_in === 'number' ? j.expires_in : 3600;
  cache.set(key, { token: j.access_token, exp: now() + ttl * 1000 });
  return j.access_token;
}
