import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ApiError } from '@/contracts';
import { makeRpc, resetRpcBreakers, RpcError } from '../rpc';
import { BALANCE_TTL_MS, computeAvailable, getUsdcBalance, invalidateBalance } from '../funds';
import { ataAddress } from '../ix';
import { CIRCLE_DEVNET_USDC_MINT } from '../config';
import { PublicKey } from '@solana/web3.js';

type Reply = { status?: number; body?: unknown; throws?: 'timeout' | 'network' };
/** A fake fetch that answers from a script per URL and records every call. */
const fakeFetch = (script: Record<string, Reply[]>) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const r = script[url]?.shift() ?? { throws: 'network' };
    if (r.throws === 'timeout') { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }
    if (r.throws) throw new TypeError('fetch failed');
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
};
const ok = (result: unknown): Reply => ({ body: { jsonrpc: '2.0', id: 1, result } });
const rpcErr = (code: number, message: string): Reply => ({ body: { jsonrpc: '2.0', id: 1, error: { code, message } } });

describe('rpc failover', () => {
  beforeEach(() => resetRpcBreakers()); // a 429 opens the endpoint's circuit for the next 30 s
  it('uses the primary when it answers', async () => {
    const { f, calls } = fakeFetch({ 'https://a': [ok(7)] });
    expect(await makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'] })('getSlot')).toBe(7);
    expect(calls).toEqual(['https://a']);
  });
  it('retries the primary once, then falls over to the next endpoint', async () => {
    const { f, calls } = fakeFetch({ 'https://a': [{ throws: 'timeout' }, { status: 429 }], 'https://b': [ok('from b')] });
    expect(await makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'] })('getSlot')).toBe('from b');
    expect(calls).toEqual(['https://a', 'https://a', 'https://b']);
  });
  it('treats a 5xx and an unhealthy-node error as transient', async () => {
    const { f } = fakeFetch({ 'https://a': [{ status: 503 }, rpcErr(-32005, 'Node is behind')], 'https://b': [ok(1)] });
    expect(await makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'] })('getSlot')).toBe(1);
  });
  it('a real JSON-RPC error is final: no failover, thrown as RpcError', async () => {
    const { f, calls } = fakeFetch({ 'https://a': [rpcErr(-32602, 'Invalid param: could not find account')], 'https://b': [ok(1)] });
    await expect(makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'] })('getTokenAccountBalance')).rejects.toBeInstanceOf(RpcError);
    expect(calls).toEqual(['https://a']);
  });
  it('every endpoint failing gives ChainError rpc_unavailable', async () => {
    const { f } = fakeFetch({});
    const err = (await makeRpc('devnet', { fetch: f, urls: ['https://a', 'https://b'] })('getSlot').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('rpc_unavailable');
    expect(err.status).toBe(503);
  });
});

describe('getUsdcBalance', () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  beforeEach(() => invalidateBalance());
  const clock = (t0 = 1_000_000) => { let t = t0; return { now: () => t, tick: (ms: number) => { t += ms; } }; };
  const balanceCall = (amounts: (string | Error)[]) => {
    const seen: unknown[][] = [];
    const call = (async (method: string, params: unknown[]) => {
      seen.push([method, ...params]);
      const a = amounts.shift()!;
      if (a instanceof Error) throw a;
      return { value: { amount: a } };
    }) as never;
    return { call, seen };
  };

  it('reads the associated token account of the configured mint at commitment confirmed', async () => {
    const { call, seen } = balanceCall(['250000000']);
    expect(await getUsdcBalance(wallet, 'devnet', { call, now: clock().now })).toBe(250_000_000n);
    expect(seen[0]).toEqual(['getTokenAccountBalance', ataAddress(new PublicKey(CIRCLE_DEVNET_USDC_MINT), new PublicKey(wallet)).toBase58(), { commitment: 'confirmed' }]);
  });
  it('a missing token account is a balance of 0', async () => {
    const { call } = balanceCall([new RpcError(-32602, 'Invalid param: could not find account')]);
    expect(await getUsdcBalance(wallet, 'devnet', { call, now: clock().now })).toBe(0n);
  });
  it('caches for 4 s per (cluster, wallet), then reads again', async () => {
    const c = clock(), { call, seen } = balanceCall(['1', '2', '3']);
    const read = () => getUsdcBalance(wallet, 'devnet', { call, now: c.now });
    expect(await read()).toBe(1n);
    c.tick(BALANCE_TTL_MS - 1);
    expect(await read()).toBe(1n);
    expect(seen.length).toBe(1);
    c.tick(2);
    expect(await read()).toBe(2n);
    expect(await getUsdcBalance(wallet, 'mainnet-beta', { call, now: c.now, usdcMint: CIRCLE_DEVNET_USDC_MINT })).toBe(3n); // other cluster, other key
  });
  it('invalidateBalance drops one wallet (after a faucet mint or a settlement)', async () => {
    const c = clock(), { call } = balanceCall(['1', '2']);
    await getUsdcBalance(wallet, 'devnet', { call, now: c.now });
    invalidateBalance(wallet);
    expect(await getUsdcBalance(wallet, 'devnet', { call, now: c.now })).toBe(2n);
  });
  it('fails closed: every endpoint down is balance_unavailable (503), and a failure is not cached', async () => {
    const { f } = fakeFetch({});
    const call = makeRpc('devnet', { fetch: f, urls: ['https://a'] });
    const err = (await getUsdcBalance(wallet, 'devnet', { call }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('balance_unavailable');
    expect(err.status).toBe(503);
    const { call: good } = balanceCall(['9']);
    expect(await getUsdcBalance(wallet, 'devnet', { call: good })).toBe(9n);
  });
  it('an unexpected RPC error is also balance_unavailable, never a guessed number', async () => {
    const { call } = balanceCall([new RpcError(-32000, 'internal error')]);
    await expect(getUsdcBalance(wallet, 'devnet', { call })).rejects.toMatchObject({ code: 'balance_unavailable' });
  });
  it('a malformed wallet is a validation error, not an RPC call', async () => {
    const { call, seen } = balanceCall([]);
    await expect(getUsdcBalance('nope', 'devnet', { call })).rejects.toMatchObject({ code: 'validation' });
    expect(seen.length).toBe(0);
  });
});

describe('computeAvailable', () => {
  it('balance minus leading bids minus open settlements, never below zero', () => {
    expect(computeAvailable({ balance: 100n, leadingBids: 30n, openSettlements: 20n })).toBe(50n);
    expect(computeAvailable({ balance: 10n, leadingBids: 30n, openSettlements: 20n })).toBe(0n);
    expect(computeAvailable({ balance: 0n, leadingBids: 0n, openSettlements: 0n })).toBe(0n);
  });
});
