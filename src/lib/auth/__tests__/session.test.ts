import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { ApiError } from '@/contracts';
import { SESSION_COOKIE, SESSION_TTL_MS, clearSessionCookie, cookieValue, getSession, readSession, sessionCookie, signSession } from '../session';
import { NOW } from './testkit';

const SECRET = 'test-secret-test-secret-test-secret-0123';
const ENV = { SESSION_SECRET: SECRET };
const who = { wallet: '3Cv8UNdmzgmNFGNo6U7iAMHjf3wv6679SZV3BfTWwdiU', profileId: '4c7d1e92-8a3b-4d56-b0e7-2f9a5c6d1e16' };
const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

afterEach(() => vi.unstubAllEnvs());

describe('session token', () => {
  it('round-trips and carries wallet, profile and a 12 hour lifetime', async () => {
    const token = await signSession(who, NOW, ENV);
    expect(await readSession(token, NOW + 1000, ENV)).toEqual({ wallet: who.wallet, profileId: who.profileId, issuedAt: NOW, expiresAt: NOW + SESSION_TTL_MS });
    expect(SESSION_TTL_MS).toBe(12 * 3600 * 1000);
  });

  it('expires exactly at the end of the lifetime', async () => {
    const token = await signSession(who, NOW, ENV);
    expect(await readSession(token, NOW + SESSION_TTL_MS - 1, ENV)).not.toBeNull();
    expect(await readSession(token, NOW + SESSION_TTL_MS, ENV)).toBeNull();
  });

  it('refuses a token issued in the future and one signed with another secret', async () => {
    const token = await signSession(who, NOW + 10 * 60_000, ENV);
    expect(await readSession(token, NOW, ENV)).toBeNull();
    const other = await signSession(who, NOW, { SESSION_SECRET: 'another-secret-another-secret-another-0123' });
    expect(await readSession(other, NOW, ENV)).toBeNull();
  });

  it('refuses a correctly signed payload that claims a longer life or a bad shape', async () => {
    // forge with the real secret to prove the payload rules, not just the MAC, are checked
    const mk = async (p: object) => {
      const payload = Buffer.from(JSON.stringify(p)).toString('base64url');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))).toString('base64url');
      return `${payload}.${mac}`;
    };
    const base = { v: 1, w: who.wallet, p: who.profileId, iat: NOW, exp: NOW + SESSION_TTL_MS };
    expect(await readSession(await mk(base), NOW, ENV)).not.toBeNull();
    for (const bad of [
      { ...base, exp: NOW + SESSION_TTL_MS + 1 }, { ...base, v: 2 }, { ...base, p: 'not-a-uuid' }, { ...base, w: 5 }, { ...base, iat: 'x' }, { ...base, exp: undefined },
    ]) expect(await readSession(await mk(bad), NOW, ENV)).toBeNull();
  });

  it('any single-character change of the token fails', async () => {
    const token = await signSession(who, NOW, ENV);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.'.split('');
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: token.length - 1 }), fc.constantFrom(...alphabet), async (i, c) => {
        if (token[i] === c) return true;
        return (await readSession(token.slice(0, i) + c + token.slice(i + 1), NOW, ENV)) === null;
      }),
      { numRuns: 500 },
    );
  });

  it('rejects junk', async () => {
    for (const t of ['', 'x', 'a.b', 'a.b.c', '.', 'ä.ö', '...']) expect(await readSession(t, NOW, ENV)).toBeNull();
  });
});

describe('fail closed without a secret', () => {
  it('a deployed build refuses to sign or verify without SESSION_SECRET', async () => {
    for (const env of [{ NODE_ENV: 'production' }, { VERCEL_ENV: 'production' }, { VERCEL_ENV: 'preview' }]) {
      await expect(signSession(who, NOW, env)).rejects.toMatchObject({ code: 'paused' });
      await expect(readSession('a.b', NOW, env)).rejects.toBeInstanceOf(ApiError);
    }
  });

  it('a secret shorter than 32 characters is refused everywhere, even in dev', async () => {
    await expect(signSession(who, NOW, { SESSION_SECRET: 'short' })).rejects.toMatchObject({ code: 'paused' });
    await expect(signSession(who, NOW, { SESSION_SECRET: 'short', NODE_ENV: 'development' })).rejects.toMatchObject({ code: 'paused' });
  });

  it('local dev and test runs get an ephemeral secret that works within the process', async () => {
    const token = await signSession(who, NOW, { NODE_ENV: 'development' });
    expect(await readSession(token, NOW, { NODE_ENV: 'development' })).not.toBeNull();
    // and it is not the configured one
    expect(await readSession(token, NOW, ENV)).toBeNull();
  });

  it('getSession on a request with no cookie does not need the secret at all', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', '');
    expect(await getSession(req('https://x.test/api/me'))).toBeNull();
  });

  it('getSession with a cookie on a misconfigured deployment throws 503 instead of treating it as anonymous', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_SECRET', '');
    await expect(getSession(req('https://x.test/api/me', { cookie: `${SESSION_COOKIE}=a.b` }))).rejects.toMatchObject({ code: 'paused' });
  });
});

describe('cookie', () => {
  it('is HttpOnly, SameSite=Lax, Path=/, 12 h and Secure on a real host', () => {
    const c = sessionCookie('tok', req('https://hammerprice.example/api/auth/verify'));
    expect(c).toBe('hp_session=tok; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax; Secure');
  });

  it('is not Secure on localhost so it works over http in development', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', 'app.localhost:3000']) {
      const c = sessionCookie('tok', req(`http://${host}/api/auth/verify`));
      expect(c).toContain('HttpOnly');
      expect(c).not.toContain('Secure');
    }
  });

  it('logout clears it with the same attributes', () => {
    expect(clearSessionCookie(req('https://hammerprice.example/api/auth/logout'))).toBe('hp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure');
  });

  it('is read by name from a cookie header with other cookies', () => {
    expect(cookieValue(req('https://x.test', { cookie: 'a=1; hp_session=abc.def; b=2' }), SESSION_COOKIE)).toBe('abc.def');
    expect(cookieValue(req('https://x.test', { cookie: 'xhp_session=1' }), SESSION_COOKIE)).toBeNull();
    expect(cookieValue(req('https://x.test'), SESSION_COOKIE)).toBeNull();
  });

  it('getSession reads a valid cookie', async () => {
    vi.stubEnv('SESSION_SECRET', SECRET);
    const token = await signSession(who, Date.now(), ENV);
    const s = await getSession(req('https://x.test/api/me', { cookie: `${SESSION_COOKIE}=${token}` }));
    expect(s?.wallet).toBe(who.wallet);
  });
});
