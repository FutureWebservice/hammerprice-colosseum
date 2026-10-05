/** The failure backoff (clock injected) and the readiness cache with its stale-ok path, on an in-memory store. */
import { describe, expect, it, vi } from 'vitest';
import { ChainError } from '@/lib/chain/errors';
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, READY_STALE_MS, READY_TTL_MS, backoffDelayMs, createHouseReadiness, createRolloverBackoff, readRolloverState, type FlagStore } from '../rollover-guard';

const memStore = () => {
  const m = new Map<string, unknown>();
  const store: FlagStore = { load: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null), save: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); } };
  return { store, m };
};
const clock = (t0 = 1_000_000) => { let t = t0; return { now: () => t, tick: (ms: number) => { t += ms; } }; };

describe('failure backoff', () => {
  it('waits 60 s after the first failure, doubles, and stops at 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000, 600_000]);
    expect(BACKOFF_MIN_MS).toBe(60_000);
    expect(BACKOFF_MAX_MS).toBe(600_000);
  });

  it('blocks attempts inside the window, allows them after it, and doubles on the next failure', async () => {
    const c = clock(); const { store } = memStore();
    const b = createRolloverBackoff(store, c.now);
    expect(await b.allowed()).toBe(true);
    await b.fail('every RPC endpoint failed (HTTP 429)');
    c.tick(59_999);
    expect(await b.allowed()).toBe(false);
    c.tick(2);
    expect(await b.allowed()).toBe(true);
    await b.fail('again');
    c.tick(119_000);
    expect(await b.allowed()).toBe(false); // the second window is 120 s
    c.tick(2_000);
    expect(await b.allowed()).toBe(true);
  });

  it('a success resets it', async () => {
    const c = clock(); const { store } = memStore();
    const b = createRolloverBackoff(store, c.now);
    await b.fail('x'); await b.fail('x'); await b.fail('x');
    c.tick(BACKOFF_MAX_MS);
    await b.ok();
    expect(await b.allowed()).toBe(true);
    await b.fail('x');
    c.tick(60_001);
    expect(await b.allowed()).toBe(true); // back to 60 s, not 8 minutes
    const s = await readRolloverState(store);
    expect(s).toMatchObject({ failures: 1, lastError: 'x' });
  });

  it('another instance sees the failure through the store (and keeps counting from it)', async () => {
    const c = clock(); const { store } = memStore();
    const a = createRolloverBackoff(store, c.now);
    const other = createRolloverBackoff(store, c.now);
    await a.fail('429');
    expect(await other.allowed()).toBe(false);
    c.tick(61_000);
    await other.fail('429 again'); // second failure overall: 120 s
    expect((await readRolloverState(store))?.failures).toBe(2);
    c.tick(61_000);
    expect(await a.allowed()).toBe(false);
  });

  it('a store that reads nothing (no table, closed pool) leaves the memory state in charge', async () => {
    const c = clock();
    const b = createRolloverBackoff({ load: async () => null, save: async () => undefined }, c.now);
    await b.fail('x');
    expect(await b.allowed()).toBe(false);
    c.tick(60_001);
    expect(await b.allowed()).toBe(true);
  });
});

describe('the admin overview line', () => {
  it('says last ok / last error / next retry, with dashes for what has not happened', async () => {
    const { houseRolloverLine } = await import('@/server/admin/data');
    expect(houseRolloverLine(null)).toBe('- / - / -');
    const at = Date.UTC(2026, 9, 4, 12, 30);
    expect(houseRolloverLine({ lastOkAt: at, lastError: null, lastErrorAt: null, nextRetryAt: 0 })).toBe('2026-10-04 12:30 UTC / - / -');
    expect(houseRolloverLine({ lastOkAt: null, lastError: 'HTTP 429', lastErrorAt: at, nextRetryAt: Date.now() + 60_000 })).toMatch(/^- \/ 2026-10-04 12:30 UTC \(HTTP 429\) \/ \d{4}-/);
  });
});

const ready = { eligible: true, reasons: [] };
const down = () => new ChainError('rpc_unavailable', 'every RPC endpoint failed (HTTP 429)');

describe('readiness cache', () => {
  it('asks the chain once for a list, and not again for 10 minutes', async () => {
    const c = clock(); const { store } = memStore();
    const r = createHouseReadiness({ store, now: c.now });
    const read = vi.fn(async (m: string[]) => m.map(() => ready));
    const first = await r.check(['a', 'b', 'c'], read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toEqual(['a', 'b', 'c']); // one batch for all
    expect([...first.verdicts.values()].every((v) => v.eligible)).toBe(true);
    c.tick(READY_TTL_MS - 1);
    await r.check(['a', 'b', 'c'], read);
    expect(read).toHaveBeenCalledTimes(1);
    c.tick(2);
    await r.check(['a', 'b', 'c'], read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('only the cards without a fresh verdict are sent', async () => {
    const c = clock(); const { store } = memStore();
    const r = createHouseReadiness({ store, now: c.now });
    const read = vi.fn(async (m: string[]) => m.map(() => ready));
    await r.check(['a'], read);
    await r.check(['a', 'b'], read);
    expect(read.mock.calls[1][0]).toEqual(['b']);
  });

  it('shares verdicts between instances through the store', async () => {
    const c = clock(); const { store } = memStore();
    await createHouseReadiness({ store, now: c.now }).check(['a'], async (m) => m.map(() => ready));
    const read = vi.fn(async (m: string[]) => m.map(() => ready));
    await createHouseReadiness({ store, now: c.now }).check(['a'], read);
    expect(read).not.toHaveBeenCalled();
  });

  it('stale-ok: when the chain cannot answer, a card that passed within 24 hours still counts (one warning); a card never seen does not', async () => {
    const c = clock(); const { store } = memStore();
    const warn = vi.fn();
    const r = createHouseReadiness({ store, now: c.now, warn });
    await r.check(['a', 'b'], async (m) => m.map(() => ready));
    c.tick(READY_TTL_MS + 1); // no longer fresh, still inside the day
    const res = await r.check(['a', 'b'], async () => { throw down(); });
    expect(res.error).toBeNull();
    expect(res.verdicts.get('a')?.eligible).toBe(true);
    const mixed = await r.check(['a', 'new'], async () => { throw down(); });
    expect(mixed.verdicts.get('a')?.eligible).toBe(true);
    expect(mixed.verdicts.has('new')).toBe(false);
    expect(mixed.error).toBeInstanceOf(ChainError); // the caller decides: enough cards, or back off
    expect(warn).toHaveBeenCalledTimes(1); // once, not on every read
  });

  it('after 24 hours a verdict no longer vouches for a card: no cached verdict, the error comes back', async () => {
    const c = clock(); const { store } = memStore();
    const r = createHouseReadiness({ store, now: c.now, warn: () => undefined });
    await r.check(['a'], async (m) => m.map(() => ready));
    c.tick(READY_STALE_MS + 1);
    const res = await r.check(['a'], async () => { throw down(); });
    expect(res.verdicts.size).toBe(0);
    expect(res.error).toBeInstanceOf(ChainError);
  });

  it('a card the chain now refuses loses its verdict, and an error that is not "the chain is down" is not hidden', async () => {
    const c = clock(); const { store } = memStore();
    const r = createHouseReadiness({ store, now: c.now, warn: () => undefined });
    await r.check(['a'], async (m) => m.map(() => ready));
    c.tick(READY_TTL_MS + 1);
    const bad = await r.check(['a'], async (m) => m.map(() => ({ eligible: false, reasons: ['frozen' as const] })));
    expect(bad.verdicts.get('a')?.eligible).toBe(false);
    const after = await r.check(['a'], async () => { throw down(); });
    expect(after.verdicts.size).toBe(0); // no resurrection from the stale path
    await expect(r.check(['z'], async () => { throw new TypeError('decode bug'); })).rejects.toThrow('decode bug');
  });
});
