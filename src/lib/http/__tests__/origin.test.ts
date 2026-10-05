import { describe, expect, it } from 'vitest';
import { assertJson, assertSameOrigin, configuredHosts, isProduction, loginHosts } from '../origin';

const req = (headers: Record<string, string> = {}, url = 'https://hammerprice.example/api/x') => new Request(url, { method: 'POST', headers });
const code = (fn: () => void) => { try { fn(); return null; } catch (e) { return (e as { code?: string }).code ?? 'other'; } };

describe('assertSameOrigin', () => {
  it('accepts the page own origin, even when the Host header carries it', () => {
    expect(code(() => assertSameOrigin(req({ origin: 'https://hammerprice.example' })))).toBeNull();
  });

  it('refuses another origin, a null origin and junk', () => {
    for (const origin of ['https://evil.example', 'null', 'not a url', 'https://hammerprice.example.evil.example', 'http://hammerprice.example:8080']) {
      expect(code(() => assertSameOrigin(req({ origin }))), origin).toBe('forbidden');
    }
  });

  it('accepts a configured site host even when the request arrived on another (alias)', () => {
    const env = { NEXT_PUBLIC_SITE_URL: 'https://www.hammerprice.example' };
    expect(code(() => assertSameOrigin(req({ origin: 'https://www.hammerprice.example' }), env))).toBeNull();
    expect(code(() => assertSameOrigin(req({ origin: 'https://evil.example' }), env))).toBe('forbidden');
  });

  it('without Origin, goes by Sec-Fetch-Site: same-origin and none pass, same-site and cross-site do not', () => {
    expect(code(() => assertSameOrigin(req({ 'sec-fetch-site': 'same-origin' })))).toBeNull();
    expect(code(() => assertSameOrigin(req({ 'sec-fetch-site': 'none' })))).toBeNull();
    expect(code(() => assertSameOrigin(req({ 'sec-fetch-site': 'same-site' })))).toBe('forbidden');
    expect(code(() => assertSameOrigin(req({ 'sec-fetch-site': 'cross-site' })))).toBe('forbidden');
  });

  it('a non-browser client that sends neither header is allowed (it cannot carry a victim cookie)', () => {
    expect(code(() => assertSameOrigin(req({ 'user-agent': 'curl/8.4.0' })))).toBeNull();
  });

  it('Origin wins over Sec-Fetch-Site', () => {
    expect(code(() => assertSameOrigin(req({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })))).toBe('forbidden');
  });
});

describe('assertJson', () => {
  it('needs application/json, charset allowed, any case', () => {
    expect(code(() => assertJson(req({ 'content-type': 'application/json' })))).toBeNull();
    expect(code(() => assertJson(req({ 'content-type': 'Application/JSON; charset=utf-8' })))).toBeNull();
    for (const t of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
      expect(code(() => assertJson(req({ 'content-type': t }))), t).toBe('validation');
    }
    expect(code(() => assertJson(req()))).toBe('validation');
  });
});

describe('hosts', () => {
  it('reads the configured hosts from the site URL and the Vercel production alias', () => {
    expect(configuredHosts({ NEXT_PUBLIC_SITE_URL: 'https://Hammerprice.example/', VERCEL_PROJECT_PRODUCTION_URL: 'hp.vercel.app' })).toEqual(['hammerprice.example', 'hp.vercel.app']);
    expect(configuredHosts({ NEXT_PUBLIC_SITE_URL: 'not a url' })).toEqual([]);
    expect(configuredHosts({ VERCEL_PROJECT_PRODUCTION_URL: 'evil.com/path' })).toEqual([]);
    expect(configuredHosts({})).toEqual([]);
  });

  it('classifies production', () => {
    expect(isProduction({ VERCEL_ENV: 'production' })).toBe(true);
    expect(isProduction({ VERCEL_ENV: 'preview', NODE_ENV: 'production' })).toBe(false);
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'development' })).toBe(false);
    expect(isProduction({ VERCEL_ENV: 'development', NODE_ENV: 'production' })).toBe(false);
  });

  it('production accepts only the configured site for a sign-in message, whatever Host the request carried', () => {
    const env = { VERCEL_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://hammerprice.example' };
    expect(loginHosts(req({ host: 'evil.example' }, 'https://evil.example/x'), env)).toEqual(['hammerprice.example']);
  });

  it('production with no configured host fails closed (503 paused)', () => {
    expect(code(() => loginHosts(req(), { VERCEL_ENV: 'production' }))).toBe('paused');
    expect(code(() => loginHosts(req(), { NODE_ENV: 'production' }))).toBe('paused');
  });

  it('preview and local runs also accept the request host', () => {
    expect(loginHosts(req({}, 'http://localhost:3000/x'), { NODE_ENV: 'development' })).toEqual(['localhost:3000']);
    expect(loginHosts(req({}, 'https://hp-git-x.vercel.app/x'), { VERCEL_ENV: 'preview', NODE_ENV: 'production', NEXT_PUBLIC_SITE_URL: 'https://hammerprice.example' })).toEqual(['hammerprice.example', 'hp-git-x.vercel.app']);
  });
});
