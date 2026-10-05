import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHouseSweep, HOUSE_SWEEP_MS } from '../sweep';

describe('the shared house check', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T12:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('runs once for lists that ask together, and again only after the window', async () => {
    const run = vi.fn(async () => 'none' as const);
    const sweep = createHouseSweep(run);
    await Promise.all([sweep(), sweep(), sweep(), sweep()]);
    expect(run).toHaveBeenCalledTimes(1);
    await sweep();
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + HOUSE_SWEEP_MS + 1);
    await sweep();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('hands every caller the answer of the one check', async () => {
    let n = 0;
    const sweep = createHouseSweep(async () => (++n === 1 ? 'created' : 'none'));
    expect(await Promise.all([sweep(), sweep()])).toEqual(['created', 'created']);
  });
});
