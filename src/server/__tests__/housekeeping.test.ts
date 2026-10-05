import { describe, expect, it, vi } from 'vitest';
import { createHousekeeping, housekeepingIntervalMs } from '../housekeeping';

describe('housekeeping trigger', () => {
  it('runs the pass once per interval, however often it is triggered, and never twice at the same time', async () => {
    let now = 0;
    const run = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const trigger = createHousekeeping(run, 1000);
    await Promise.all([trigger(), trigger(), trigger()]);
    expect(run).toHaveBeenCalledTimes(1);
    now = 999; await trigger();
    expect(run).toHaveBeenCalledTimes(1);
    now = 1005; await trigger();
    expect(run).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it('never throws, even when a pass fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const run = vi.fn(async () => { throw new Error('boom'); });
    const trigger = createHousekeeping(run, 1000);
    await expect(trigger()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('is off at 0', async () => {
    const run = vi.fn(async () => undefined);
    await createHousekeeping(run, 0)();
    expect(run).not.toHaveBeenCalled();
  });

  it('reads HOUSEKEEPING_INTERVAL_S: 900 s by default, 0 is off, nonsense falls back', () => {
    expect(housekeepingIntervalMs({})).toBe(900_000);
    expect(housekeepingIntervalMs({ HOUSEKEEPING_INTERVAL_S: '60' })).toBe(60_000);
    expect(housekeepingIntervalMs({ HOUSEKEEPING_INTERVAL_S: '0' })).toBe(0);
    expect(housekeepingIntervalMs({ HOUSEKEEPING_INTERVAL_S: 'abc' })).toBe(900_000);
    expect(housekeepingIntervalMs({ HOUSEKEEPING_INTERVAL_S: '-5' })).toBe(900_000);
  });
});
