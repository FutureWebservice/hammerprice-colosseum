import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';

let t: TestPg | undefined;
let skipReason: string | undefined;
let rl: typeof import('../ratelimit');

beforeAll(async () => {
  const r = await startTestPg();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  rl = await import('../ratelimit');
}, 120_000);
afterAll(async () => {
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); // let the sockets close before the server goes: a FATAL on a closing socket is an uncaught error under load
  await t?.stop();
});
const it_ = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

describe('fixed-window limiter (real Postgres)', () => {
  it_('allows exactly `limit` calls in a window, then refuses with the seconds left', async () => {
    for (let i = 0; i < 3; i++) expect(await rl.rateLimit('k:basic', 3, 60, { nowMs: T0 + 10_000 })).toEqual({ ok: true, retryAfterS: 0 });
    expect(await rl.rateLimit('k:basic', 3, 60, { nowMs: T0 + 10_000 })).toEqual({ ok: false, retryAfterS: 50 });
    expect(await rl.rateLimit('k:basic', 3, 60, { nowMs: T0 + 59_999 })).toEqual({ ok: false, retryAfterS: 1 });
  });

  it_('starts a fresh count in the next window', async () => {
    for (let i = 0; i < 2; i++) await rl.rateLimit('k:window', 1, 60, { nowMs: T0 });
    expect((await rl.rateLimit('k:window', 1, 60, { nowMs: T0 })).ok).toBe(false);
    expect((await rl.rateLimit('k:window', 1, 60, { nowMs: T0 + 60_000 })).ok).toBe(true);
  });

  it_('keeps keys apart', async () => {
    expect((await rl.rateLimit('k:a', 1, 60, { nowMs: T0 })).ok).toBe(true);
    expect((await rl.rateLimit('k:b', 1, 60, { nowMs: T0 })).ok).toBe(true);
    expect((await rl.rateLimit('k:a', 1, 60, { nowMs: T0 })).ok).toBe(false);
  });

  it_('counts exactly under concurrency: 50 parallel calls against a limit of 20 allow 20', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => rl.rateLimit('k:race', 20, 60, { nowMs: T0 })));
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    const { rows } = await t!.pool.query(`select count from rate_limits where key = 'k:race'`);
    expect(rows).toEqual([{ count: 50 }]);
  });

  it_('wallet and IP variants use separate, namespaced keys', async () => {
    vi.stubEnv('VERCEL', '1');
    const req = new Request('https://x.test/', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    await rl.rateLimitWallet('bid', 'WALLET1', 5, 60, { nowMs: T0 });
    await rl.rateLimitIp('bid', req, 5, 60, { nowMs: T0 });
    const { rows } = await t!.pool.query(`select key from rate_limits where key in ('w:bid:WALLET1', 'ip:bid:203.0.113.9') order by key`);
    expect(rows.map((r) => r.key)).toEqual(['ip:bid:203.0.113.9', 'w:bid:WALLET1']);
    vi.unstubAllEnvs();
  });

  it_('purges old windows and keeps recent ones', async () => {
    await rl.rateLimit('k:old', 5, 60, { nowMs: T0 - 3 * 86_400_000 });
    await rl.rateLimit('k:recent', 5, 60, { nowMs: T0 });
    await rl.purgeRateLimits(new Date(T0 - 86_400_000));
    const { rows } = await t!.pool.query(`select key from rate_limits where key in ('k:old', 'k:recent')`);
    expect(rows.map((r) => r.key)).toEqual(['k:recent']);
  });

  it_('assertRate throws the 429 error with retryAfterS and passes a good result', async () => {
    expect(() => rl.assertRate({ ok: true, retryAfterS: 0 })).not.toThrow();
    try {
      rl.assertRate({ ok: false, retryAfterS: 12 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ code: 'rate_limited', status: 429, extra: { retryAfterS: 12 } });
    }
  });
});

describe('client address', () => {
  const ip = (h: Record<string, string>) => new Request('https://x.test/', { headers: h });
  const VERCEL = { VERCEL: '1' };
  it('on Vercel prefers the platform header, then x-real-ip, then the first forwarded address, and never throws', async () => {
    const { clientIp } = await import('../ratelimit');
    expect(clientIp(ip({ 'x-vercel-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }), VERCEL)).toBe('1.1.1.1');
    expect(clientIp(ip({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' }), VERCEL)).toBe('2.2.2.2');
    expect(clientIp(ip({ 'x-forwarded-for': ' 3.3.3.3 , 4.4.4.4' }), VERCEL)).toBe('3.3.3.3');
    expect(clientIp(ip({}), VERCEL)).toBe('unknown');
    expect(clientIp(ip({ 'x-forwarded-for': 'a'.repeat(500) }), VERCEL).length).toBe(64);
  });
  it('SEC: off Vercel the client-controlled headers are ignored, so a caller cannot pick its own rate-limit key', async () => {
    const { clientIp } = await import('../ratelimit');
    const spoofed = (n: number) => ip({ 'x-vercel-forwarded-for': `9.9.9.${n}`, 'x-real-ip': `8.8.8.${n}`, 'x-forwarded-for': `7.7.7.${n}` });
    expect(new Set([1, 2, 3, 4].map((n) => clientIp(spoofed(n), {}))).size).toBe(1);
    expect(clientIp(spoofed(1), {})).toBe('unknown');
  });
  it('behind a proxy the operator declares, x-real-ip or the LAST forwarded hop counts, never the first (client-written) one', async () => {
    const { clientIp } = await import('../ratelimit');
    const env = { TRUST_PROXY_HEADERS: 'true' };
    expect(clientIp(ip({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), env)).toBe('203.0.113.9');
    expect(clientIp(ip({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6' }), env)).toBe('203.0.113.7');
    expect(clientIp(ip({ 'x-vercel-forwarded-for': '6.6.6.6' }), env)).toBe('unknown');
  });
  it('SEC: IPv6 callers are keyed by /64, IPv4-mapped addresses by their IPv4', async () => {
    const { clientIp, normalizeIp } = await import('../ratelimit');
    const a = clientIp(ip({ 'x-vercel-forwarded-for': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }), VERCEL);
    const b = clientIp(ip({ 'x-vercel-forwarded-for': '2001:0db8:0001:0002::1' }), VERCEL);
    const c = clientIp(ip({ 'x-vercel-forwarded-for': '2001:db8:1:3::1' }), VERCEL);
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeIp('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('[2001:db8:1:2::9]')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('not an ip')).toBe('not an ip');
  });
});

describe('the shared per-address budget on routes that spend our RPC calls', () => {
  it_('refuses the call after the limit whichever wallet asks, and gives each address its own budget', async () => {
    const at = (ip: string) => new Request('http://localhost/x', { headers: { 'x-forwarded-for': ip } });
    const a = at('198.51.100.21'), b = at('198.51.100.22');
    for (let i = 0; i < 3; i++) expect((await rl.rateLimitChain(a, { limit: 3, nowMs: T0 })).ok).toBe(true);
    expect((await rl.rateLimitChain(a, { limit: 3, nowMs: T0 })).ok).toBe(false);
    expect((await rl.rateLimitChain(b, { limit: 3, nowMs: T0 })).ok).toBe(true);
  });

  it('is applied by every signed-in route that makes an RPC call (a route added later without it fails here)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../../app/api');
    for (const f of ['lots/[id]/readiness', 'sell/assets', 'settlements/[id]/prepare', 'settlements/[id]/sign', 'shows/[id]/paddle', 'shows']) {
      expect(fs.readFileSync(path.join(root, f, 'route.ts'), 'utf8'), f).toContain('rateLimitChain(req');
    }
  });
});

describe('when the database is down', () => {
  async function broken() {
    vi.resetModules();
    vi.doMock('@/db', () => ({ db: { insert: () => { throw new Error('connection refused'); } } }));
    return import('../ratelimit');
  }

  it('a WRITE path fails closed: the error propagates, the request is not waved through', async () => {
    const b = await broken();
    await expect(b.rateLimit('k:w', 5, 60)).rejects.toThrow('connection refused');
  });

  it('a READ path (failOpen) is allowed and a warning is logged', async () => {
    const b = await broken();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await b.rateLimit('me:w', 5, 60, { failOpen: true })).toEqual({ ok: true, retryAfterS: 0 });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    vi.doUnmock('@/db');
  });
});
