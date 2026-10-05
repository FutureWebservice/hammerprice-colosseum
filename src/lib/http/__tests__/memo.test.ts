import { describe, expect, it, vi } from 'vitest';
import { createMemo, snapshotMemoMs } from '../memo';

const clock = () => { let t = 1_000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };

describe('createMemo', () => {
  it('SEC: 200 concurrent requests for one key run ONE load (database work does not grow with viewers)', async () => {
    const m = createMemo<number>(500);
    const load = vi.fn(async () => { await new Promise((r) => setTimeout(r, 20)); return 7; });
    const out = await Promise.all(Array.from({ length: 200 }, () => m.get('show-1', load)));
    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(out)).toEqual(new Set([7]));
  });

  it('shares the answer for ttl after it was produced, then loads again', async () => {
    const c = clock();
    const m = createMemo<number>(500, 200, c.now);
    let n = 0;
    const load = async () => ++n;
    expect(await m.get('k', load)).toBe(1);
    c.tick(499);
    expect(await m.get('k', load)).toBe(1);
    c.tick(2);
    expect(await m.get('k', load)).toBe(2);
  });

  it('a failure is not remembered: the next request loads again', async () => {
    const m = createMemo<number>(500);
    await expect(m.get('k', async () => { throw new Error('db down'); })).rejects.toThrow('db down');
    expect(await m.get('k', async () => 1)).toBe(1);
  });

  it('keys are independent, and a flood of distinct keys holds at most `max` entries', async () => {
    const m = createMemo<string>(10_000, 3);
    const load = vi.fn(async () => 'x');
    for (const k of ['a', 'b', 'c', 'd', 'e']) await m.get(k, load);
    expect(load).toHaveBeenCalledTimes(5);
    await m.get('e', load); // still held
    expect(load).toHaveBeenCalledTimes(5);
    await m.get('a', load); // evicted long ago
    expect(load).toHaveBeenCalledTimes(6);
  });

  it('ttl 0 remembers nothing but still shares requests that are in flight together', async () => {
    const m = createMemo<number>(0);
    const load = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)); return 1; });
    await Promise.all([m.get('k', load), m.get('k', load), m.get('k', load)]);
    expect(load).toHaveBeenCalledTimes(1);
    await m.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('snapshotMemoMs defaults to 500, honours LIVE_SNAPSHOT_MEMO_MS, and caps it at 2 s', () => {
    expect(snapshotMemoMs({})).toBe(500);
    expect(snapshotMemoMs({ LIVE_SNAPSHOT_MEMO_MS: '0' })).toBe(0);
    expect(snapshotMemoMs({ LIVE_SNAPSHOT_MEMO_MS: '250' })).toBe(250);
    expect(snapshotMemoMs({ LIVE_SNAPSHOT_MEMO_MS: '999999' })).toBe(2000);
    expect(snapshotMemoMs({ LIVE_SNAPSHOT_MEMO_MS: 'abc' })).toBe(500);
  });
});
