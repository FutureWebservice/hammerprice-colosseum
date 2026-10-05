import { describe, it, expect } from 'vitest';
import { addOffsetSample, formatCountdown, medianOffset, msUntil, serverTime } from '../clock';

describe('clock offset', () => {
  it('uses the midpoint of the round trip', () => {
    // sent at 1000, received at 1200 (rtt 200), server said 5000: offset = 5000 - (1200 - 100)
    expect(addOffsetSample([], 5000, 1000, 1200)).toEqual([3900]);
  });
  it('keeps the last five samples and takes the median', () => {
    let s: number[] = [];
    for (const off of [10, 1000, 20, 30, 40, 50]) s = addOffsetSample(s, off + 100, 100, 100);
    expect(s).toHaveLength(5);
    expect(medianOffset(s)).toBe(40); // 1000 is an outlier but inside the window; median of [1000,20,30,40,50]
  });
  it('is zero without samples and averages the middle pair for an even count', () => {
    expect(medianOffset([])).toBe(0);
    expect(medianOffset([10, 30])).toBe(20);
  });
  it('counts down on the server clock', () => {
    const closes = new Date(1_000_000 + 7_000).toISOString();
    expect(msUntil(closes, 500, 1_000_000 - 500)).toBe(7_000); // client clock 500 ms behind the server
    expect(msUntil(null, 0, 0)).toBeNull();
    expect(msUntil('not a date', 0, 0)).toBeNull();
  });
  it('gives whole milliseconds for the signed texts even when the offset is fractional (odd rtt halves it)', () => {
    const offset = medianOffset(addOffsetSample([], 1_000_050, 1_000_000, 1_000_001)); // rtt 1 ms -> offset ends in .5
    expect(Number.isInteger(offset)).toBe(false);
    expect(Number.isInteger(serverTime(offset, 1_790_000_000_000))).toBe(true);
    expect(`valid: ${serverTime(0.25, 1_790_000_000_000)}`).toMatch(/^valid: [1-9][0-9]{12}$/);
  });
  it('formats without going negative', () => {
    expect(formatCountdown(7_000)).toBe('0:07');
    expect(formatCountdown(400)).toBe('0:01');
    expect(formatCountdown(-5_000)).toBe('0:00');
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(null)).toBe('--:--');
  });
});
