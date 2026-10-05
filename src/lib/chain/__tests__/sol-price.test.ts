import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSolPriceCache, decodePythPrice, FIRST_READ_BUDGET_MS, getSolUsd, MAX_STALENESS_S, PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED_ID, readSolUsd } from '../../sol-price';

const NOW_S = 1_790_000_000;
/** A PriceUpdateV2 account in the layout Pyth publishes: price 140.12345678 (expo -8), conf 0.05. */
function account(o: Partial<{ owner: string; feed: string; price: bigint; conf: bigint; expo: number; publish: number; verification: 'full' | 'partial'; disc: number[] }> = {}) {
  const d = Buffer.alloc(134);
  Buffer.from(o.disc ?? [34, 241, 35, 99, 157, 126, 244, 205]).copy(d, 0);
  let p = 8 + 32;
  d[p++] = o.verification === 'partial' ? 0 : 1;
  if (o.verification === 'partial') d[p++] = 5;
  Buffer.from(o.feed ?? PYTH_SOL_USD_FEED_ID, 'hex').copy(d, p); p += 32;
  d.writeBigInt64LE(o.price ?? 14_012_345_678n, p); p += 8;
  d.writeBigUInt64LE(o.conf ?? 5_000_000n, p); p += 8;
  d.writeInt32LE(o.expo ?? -8, p); p += 4;
  d.writeBigInt64LE(BigInt(o.publish ?? NOW_S - 3), p);
  return { owner: o.owner ?? PYTH_RECEIVER_PROGRAM, data: new Uint8Array(d) };
}

describe('decodePythPrice', () => {
  it('reads price x 10^expo for a fresh, verified, tight SOL/USD update', () => {
    expect(decodePythPrice(account(), NOW_S)).toBeCloseTo(140.12345678, 6);
  });
  it('accepts exactly the staleness limit and refuses one second beyond (and a publish time from the future)', () => {
    expect(decodePythPrice(account({ publish: NOW_S - MAX_STALENESS_S }), NOW_S)).not.toBeNull();
    expect(decodePythPrice(account({ publish: NOW_S - MAX_STALENESS_S - 1 }), NOW_S)).toBeNull();
    expect(decodePythPrice(account({ publish: NOW_S + MAX_STALENESS_S + 1 }), NOW_S)).toBeNull();
  });
  it('refuses a wide confidence interval (over 1% of the price)', () => {
    expect(decodePythPrice(account({ conf: 140_000_000n }), NOW_S)).not.toBeNull(); // 1.0%
    expect(decodePythPrice(account({ conf: 150_000_000n }), NOW_S)).toBeNull();
  });
  it('refuses another feed, another owner, partial verification, a wrong discriminator and short data', () => {
    expect(decodePythPrice(account({ feed: 'aa'.repeat(32) }), NOW_S)).toBeNull();
    expect(decodePythPrice(account({ owner: '11111111111111111111111111111111' }), NOW_S)).toBeNull();
    expect(decodePythPrice(account({ verification: 'partial' }), NOW_S)).toBeNull();
    expect(decodePythPrice(account({ disc: [1, 2, 3, 4, 5, 6, 7, 8] }), NOW_S)).toBeNull();
    expect(decodePythPrice({ owner: PYTH_RECEIVER_PROGRAM, data: new Uint8Array(40) }, NOW_S)).toBeNull();
    expect(decodePythPrice(null, NOW_S)).toBeNull();
  });
  it('refuses a zero or negative price and a price outside the plausible range', () => {
    expect(decodePythPrice(account({ price: 0n }), NOW_S)).toBeNull();
    expect(decodePythPrice(account({ price: -5n }), NOW_S)).toBeNull();
    expect(decodePythPrice(account({ price: 50_000_000n }), NOW_S)).toBeNull(); // 0.50 dollars
    expect(decodePythPrice(account({ price: 10_000_000_000_000_000n, conf: 1n }), NOW_S)).toBeNull(); // 100 million dollars
  });
  it('honours the exponent', () => {
    expect(decodePythPrice(account({ price: 140_123n, conf: 10n, expo: -3 }), NOW_S)).toBeCloseTo(140.123, 6);
  });
});

/** A fetch that answers per URL prefix. */
const fakeFetch = (routes: Record<string, () => unknown>) => {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) throw new Error('unrouted ' + url);
    const r = routes[key]!();
    if (r instanceof Error) throw r;
    return { ok: true, status: 200, json: async () => r } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
};
const rpcAccount = (a: ReturnType<typeof account>) => ({ result: { value: { owner: a.owner, lamports: 1, data: [Buffer.from(a.data).toString('base64'), 'base64'] } } });
const SOL = 'So11111111111111111111111111111111111111112';
const good = {
  rpc: () => rpcAccount(account()),
  jup: () => ({ [SOL]: { usdPrice: 141.5 } }),
  cb: () => ({ data: { base: 'SOL', currency: 'USD', amount: '139.9' } }),
};

describe('readSolUsd: sources in order, every failure falls through', () => {
  const now = () => NOW_S * 1000;
  it('uses Pyth when it is acceptable and does not touch the others', async () => {
    const { f, calls } = fakeFetch({ 'https://rpc.test': good.rpc, 'https://lite-api.jup.ag': good.jup, 'https://api.coinbase.com': good.cb });
    const r = await readSolUsd({ fetch: f, now, rpcUrl: 'https://rpc.test' });
    expect(r?.source).toBe('pyth');
    expect(r?.usd).toBeCloseTo(140.12, 1);
    expect(calls).toEqual(['https://rpc.test']);
  });
  it('a stale Pyth update falls back to Jupiter', async () => {
    const { f } = fakeFetch({ 'https://rpc.test': () => rpcAccount(account({ publish: NOW_S - 600 })), 'https://lite-api.jup.ag': good.jup, 'https://api.coinbase.com': good.cb });
    expect(await readSolUsd({ fetch: f, now, rpcUrl: 'https://rpc.test' })).toEqual({ usd: 141.5, source: 'jupiter' });
  });
  it('RPC down and Jupiter broken falls back to Coinbase', async () => {
    const { f } = fakeFetch({ 'https://rpc.test': () => new Error('down'), 'https://lite-api.jup.ag': () => ({}), 'https://api.coinbase.com': good.cb });
    expect(await readSolUsd({ fetch: f, now, rpcUrl: 'https://rpc.test' })).toEqual({ usd: 139.9, source: 'coinbase' });
  });
  it('an implausible fallback price is refused; nothing acceptable is null', async () => {
    const { f } = fakeFetch({ 'https://rpc.test': () => new Error('down'), 'https://lite-api.jup.ag': () => ({ [SOL]: { usdPrice: 0.00003 } }), 'https://api.coinbase.com': () => ({ data: { amount: 'NaN' } }) });
    expect(await readSolUsd({ fetch: f, now, rpcUrl: 'https://rpc.test' })).toBeNull();
  });
  it('Hermes is never contacted', async () => {
    const { f, calls } = fakeFetch({ 'https://rpc.test': () => new Error('down'), 'https://lite-api.jup.ag': () => new Error('down'), 'https://api.coinbase.com': () => new Error('down') });
    await readSolUsd({ fetch: f, now, rpcUrl: 'https://rpc.test' });
    expect(calls.some((u) => /hermes/i.test(u))).toBe(false);
  });
});

describe('getSolUsd', () => {
  beforeEach(() => { clearSolPriceCache(); vi.unstubAllGlobals(); });
  it('caches for a minute and keeps the old number-or-null contract', async () => {
    const f = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('coinbase') ? good.cb() : url.includes('jup') ? {} : { error: { code: -32000, message: 'x' } }) }) as Response);
    vi.stubGlobal('fetch', f);
    expect(await getSolUsd()).toBe(139.9);
    const n = f.mock.calls.length;
    expect(await getSolUsd()).toBe(139.9);
    expect(f.mock.calls.length).toBe(n);
  });
  it('is null when every source fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await getSolUsd()).toBeNull();
  });
  it('after the first read a stale rate is shown at once while one fresh read runs; the first read has a time budget', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
      const f = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('coinbase') ? good.cb() : url.includes('jup') ? {} : { error: { code: -32000, message: 'x' } }) }) as Response);
      vi.stubGlobal('fetch', f);
      expect(await getSolUsd()).toBe(139.9);
      const first = f.mock.calls.length;
      vi.setSystemTime(Date.now() + 5 * 60_000); // older than the minute, younger than the fallback age
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      f.mockImplementation(async () => { await gate; return { ok: true, status: 200, json: async () => good.cb() } as Response; });
      const a = getSolUsd();
      const b = getSolUsd();
      expect(await a).toBe(139.9); // the old rate, without waiting for the new read
      expect(await b).toBe(139.9);
      expect(f.mock.calls.length).toBeLessThan(first + 4); // one read, not one per caller
      release();

      clearSolPriceCache();
      f.mockImplementation(() => new Promise<Response>(() => { /* a source that never answers */ }));
      const cold = getSolUsd();
      await vi.advanceTimersByTimeAsync(FIRST_READ_BUDGET_MS + 1);
      expect(await cold).toBeNull(); // the page goes on with USDC alone
    } finally { vi.useRealTimers(); }
  });
});
