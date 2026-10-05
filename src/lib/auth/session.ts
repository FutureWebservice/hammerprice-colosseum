/**
 * The session cookie: `hp_session=<base64url(payload)>.<base64url(HMAC-SHA256)>`, payload
 * `{v:1, w:<wallet>, p:<profileId>, iat, exp}` (ms). WebCrypto only, so it verifies in Node and on the Edge.
 *
 * The cookie proves "this browser signed in as this wallet in the last 12 hours", nothing more. Money still
 * needs a signed bid intent or a wallet-signed transaction. It cannot be revoked before it expires;
 * `requireSession` re-reads the profile, so a ban takes effect on the next request anyway (S10).
 *
 * Fail closed: a deployed build without a usable SESSION_SECRET (32+ characters) refuses to sign or verify
 * (503 `paused`) rather than falling back to anything. Only a local dev or test run gets an ephemeral
 * per-process secret.
 */
import { ApiError, Uuid, type Session } from '@/contracts';
import * as store from './store';

export const SESSION_COOKIE = 'hp_session';
export const SESSION_TTL_MS = 12 * 3_600_000;
const SKEW_MS = 2 * 60_000;
const MIN_SECRET_CHARS = 32;

type Env = Record<string, string | undefined>;

/** Any deployment (production or preview) and any `next start`; only a local `next dev` or test run is not. */
const isDeployedBuild = (env: Env): boolean => env.NODE_ENV === 'production' || env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';

const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function fromB64u(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    return Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const devSecret = (): string => {
  const g = globalThis as { __hpDevSessionSecret?: string };
  return (g.__hpDevSessionSecret ??= b64u(crypto.getRandomValues(new Uint8Array(32))));
};

function secretString(env: Env): string {
  const s = env.SESSION_SECRET;
  if (s && s.length >= MIN_SECRET_CHARS) return s;
  if (!s && !isDeployedBuild(env)) return devSecret();
  throw new ApiError('paused', 'Sign-in is unavailable: SESSION_SECRET is missing or shorter than 32 characters');
}

const keys = new Map<string, Promise<CryptoKey>>();
function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = secretString(env);
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keys.set(secret, k);
  }
  return k;
}

export async function signSession(input: { wallet: string; profileId: string }, nowMs = Date.now(), env: Env = process.env): Promise<string> {
  const payload = b64u(new TextEncoder().encode(JSON.stringify({ v: 1, w: input.wallet, p: input.profileId, iat: nowMs, exp: nowMs + SESSION_TTL_MS })));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(payload));
  return `${payload}.${b64u(new Uint8Array(mac))}`;
}

/** The session a token carries, or null for anything forged, malformed, expired or from the future. */
export async function readSession(token: string, nowMs = Date.now(), env: Env = process.env): Promise<Session | null> {
  const key = await hmacKey(env); // first, so a missing secret is an error for every token, not only well-formed ones
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const mac = fromB64u(parts[1]);
  if (!mac || b64u(mac) !== parts[1]) return null; // one spelling per token
  if (!(await crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(parts[0])))) return null;
  const raw = fromB64u(parts[0]);
  if (!raw) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
    if (p.v !== 1 || typeof p.w !== 'string' || typeof p.p !== 'string' || typeof p.iat !== 'number' || typeof p.exp !== 'number') return null;
    if (!Uuid.safeParse(p.p).success || p.exp <= nowMs || p.iat > nowMs + SKEW_MS || p.exp - p.iat > SESSION_TTL_MS) return null;
    return { wallet: p.w, profileId: p.p, issuedAt: p.iat, expiresAt: p.exp };
  } catch {
    return null;
  }
}

export function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const isLocalHost = (hostname: string): boolean => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');

function cookie(value: string, maxAgeS: number, req: Request): string {
  const secure = isLocalHost(new URL(req.url).hostname) ? '' : '; Secure';
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeS}; HttpOnly; SameSite=Lax${secure}`;
}
/** Set-Cookie value for a fresh session. Secure everywhere except localhost. */
export const sessionCookie = (token: string, req: Request): string => cookie(token, SESSION_TTL_MS / 1000, req);
export const clearSessionCookie = (req: Request): string => cookie('', 0, req);

/** The signed-in wallet from the cookie alone (no database). null when there is no cookie or it is not valid. */
export async function getSession(req: Request, nowMs = Date.now()): Promise<Session | null> {
  const token = cookieValue(req, SESSION_COOKIE);
  return token ? readSession(token, nowMs) : null;
}

/** getSession plus the profile row, refused when missing or banned. Throws ApiError('unauthenticated' | 'banned'). */
export async function requireSessionProfile(req: Request, nowMs = Date.now()): Promise<{ session: Session; profile: store.ProfileRow }> {
  const session = await getSession(req, nowMs);
  if (!session) throw new ApiError('unauthenticated', 'Sign in with your wallet first');
  const profile = await store.getProfile(session.profileId);
  if (!profile || profile.walletAddress !== session.wallet) throw new ApiError('unauthenticated', 'Sign in with your wallet first');
  if (profile.isBanned) throw new ApiError('banned', 'This account is suspended');
  return { session, profile };
}

export const requireSession = async (req: Request, nowMs = Date.now()): Promise<Session> => (await requireSessionProfile(req, nowMs)).session;
