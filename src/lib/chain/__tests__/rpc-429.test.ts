/** HTTP 429 handling of the RPC client: Retry-After, bounded backoff with jitter, a circuit per endpoint, and an immediate hop to the next endpoint. */
import { beforeEach, describe, expect, it } from 'vitest';
import { BREAKER_MAX_MS, BREAKER_MIN_MS, getMultipleAccounts, makeRpc, resetRpcBreakers, retryAfterMs } from '../rpc';

type Reply = { status?: number; retryAfter?: string; body?: unknown };
const script = (s: Record<string, Reply[]>) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = s[url]?.shift() ?? { status: 500 };
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: new Headers(r.retryAfter ? { 'retry-after': r.retryAfter } : {}), json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
};
const ok = (result: unknown): Reply => ({ body: { jsonrpc: '2.0', id: 1, result } });
const rig = () => {
  let t = 1_000_000; const slept: number[] = [];
  return { now: () => t, tick: (ms: number) => { t += ms; }, sleep: async (ms: number) => { slept.push(ms); t += ms; }, random: () => 0.5, slept };
};

beforeEach(() => resetRpcBreakers());

describe('a 429 with another endpoint behind it', () => {
  it('moves on at once (no waiting), and leaves the limited endpoint alone for 30 s', async () => {
    const r = rig();
    const { f, calls } = script({ 'https://a': [{ status: 429 }, { status: 429 }], 'https://b': [ok(1), ok(2), ok(3)] });
    const call = makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'], now: r.now, sleep: r.sleep, random: r.random });
    expect(await call('getSlot')).toBe(1);
    expect(calls).toEqual(['https://a', 'https://b']);
    expect(r.slept).toEqual([]);
    expect(await call('getSlot')).toBe(2);
    expect(calls).toEqual(['https://a', 'https://b', 'https://b']); // a is not asked while its circuit is open
    r.tick(BREAKER_MIN_MS + 1);
    await call('getSlot');
    expect(calls.slice(3)).toEqual(['https://a', 'https://b']); // a is tried again afterwards
  });

  it('the circuit follows Retry-After, between 30 and 60 s', async () => {
    const r = rig();
    const { f, calls } = script({ 'https://a': [{ status: 429, retryAfter: '120' }, ok('a again')], 'https://b': [ok(1), ok(2)] });
    const call = makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'], now: r.now, sleep: r.sleep, random: r.random });
    await call('x');
    r.tick(BREAKER_MAX_MS - 1);
    await call('x');
    expect(calls).toEqual(['https://a', 'https://b', 'https://b']); // 120 s asked for, 60 s is the most it stays open
    r.tick(2);
    expect(await call('x')).toBe('a again');
  });
});

describe('a 429 with no other endpoint', () => {
  it('honours a short Retry-After once and succeeds', async () => {
    const r = rig();
    const { f, calls } = script({ 'https://a': [{ status: 429, retryAfter: '1' }, ok('fine')] });
    expect(await makeRpc('devnet', { fetch: f, urls: ['https://a'], now: r.now, sleep: r.sleep, random: r.random })('x')).toBe('fine');
    expect(r.slept).toEqual([1000]);
    expect(calls).toHaveLength(2);
  });

  it('retries twice at most, with exponential jittered waits, then gives up with rpc_unavailable and opens the circuit', async () => {
    const r = rig();
    const { f, calls } = script({ 'https://a': [{ status: 429 }, { status: 429 }, { status: 429 }, ok('never asked')] });
    const call = makeRpc('devnet', { fetch: f, urls: ['https://a'], now: r.now, sleep: r.sleep, random: r.random });
    await expect(call('x')).rejects.toMatchObject({ code: 'rpc_unavailable', message: expect.stringContaining('429') });
    expect(calls).toHaveLength(3); // the first try and two retries
    expect(r.slept).toEqual([250, 500]); // 250 * 2^n * (0.5 + 0.5)
    expect(r.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2000);
    await expect(call('x')).rejects.toMatchObject({ code: 'rpc_unavailable' });
    expect(calls).toHaveLength(3); // while the circuit is open no request is sent at all
  });

  it('never waits past the budget: a Retry-After longer than 2 s is not slept, the call just fails', async () => {
    const r = rig();
    const { f, calls } = script({ 'https://a': [{ status: 429, retryAfter: '30' }] });
    await expect(makeRpc('devnet', { fetch: f, urls: ['https://a'], now: r.now, sleep: r.sleep, random: r.random })('x')).rejects.toMatchObject({ code: 'rpc_unavailable' });
    expect(r.slept).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3', 0)).toBe(3000);
    expect(retryAfterMs(new Date(5000).toUTCString(), 1000)).toBe(4000);
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('soon', 0)).toBeNull();
  });
  it('getMultipleAccounts asks for 100 addresses per request and keeps the order', async () => {
    const asked: number[] = [];
    const call = (async (_m: string, p: unknown[]) => { const a = p[0] as string[]; asked.push(a.length); return { value: a.map((x) => (x === 'missing' ? null : { owner: 'o', lamports: 1, data: ['AQ==', 'base64'] })) }; }) as never;
    const out = await getMultipleAccounts(call, [...Array(150).fill('x'), 'missing']);
    expect(asked).toEqual([100, 51]);
    expect(out).toHaveLength(151);
    expect(out[150]).toBeNull();
    expect(out[0]).toMatchObject({ owner: 'o', data: new Uint8Array([1]) });
  });
});
