import { describe, expect, it } from 'vitest';
import { formatCountdown } from '@/lib/client/clock';
import { formatDurationLong, formatDurationS, formatEndsAt, formatExtension, formatRemaining } from '../time-format';

const S = 1000;
const H = 3600 * S;
const D = 24 * H;

describe('formatRemaining', () => {
  it('days: "2 T 03:12:44" in German, "2 d 03:12:44" in English', () => {
    const ms = 2 * D + 3 * H + 12 * 60 * S + 44 * S;
    expect(formatRemaining(ms, 'de')).toBe('2 T 03:12:44');
    expect(formatRemaining(ms, 'en')).toBe('2 d 03:12:44');
  });
  it('hours: "3 h 12 min", seconds dropped', () => {
    expect(formatRemaining(3 * H + 12 * 60 * S + 44 * S, 'de')).toBe('3 h 12 min');
    expect(formatRemaining(H, 'en')).toBe('1 h 0 min');
  });
  it('under an hour: m:ss', () => {
    expect(formatRemaining(7 * 60 * S + 3 * S, 'en')).toBe('7:03');
    expect(formatRemaining(7 * S, 'de')).toBe('0:07');
  });
  it('tier boundaries (seconds round up first)', () => {
    expect(formatRemaining(D, 'en')).toBe('1 d 00:00:00');
    expect(formatRemaining(D - 1, 'en')).toBe('1 d 00:00:00');
    expect(formatRemaining(D - 60 * S, 'en')).toBe('23 h 59 min');
    expect(formatRemaining(H - 1, 'en')).toBe('1 h 0 min');
    expect(formatRemaining(H - 1000, 'en')).toBe('59:59');
  });
  it('rounds seconds up, never negative, null reads --:--', () => {
    expect(formatRemaining(400)).toBe('0:01');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5000)).toBe('0:00');
    expect(formatRemaining(null)).toBe('--:--');
    expect(formatRemaining(Number.NaN)).toBe('--:--');
  });
  it('under an hour it is exactly what the live room printed before (formatCountdown)', () => {
    for (let s = 0; s < 3600; s += 7) for (const extra of [0, 1, 400, 999]) {
      const ms = s * S + extra;
      expect(formatRemaining(ms, 'en')).toBe(formatCountdown(ms));
    }
    expect(formatRemaining(3599 * S + 1, 'en')).toBe('1 h 0 min'); // rounds up into the hour tier
  });
  it('is monotone: a later moment never prints a larger duration tier value than an earlier one (days then hours then minutes)', () => {
    const tier = (ms: number) => (ms >= D ? 2 : ms >= H ? 1 : 0);
    let last = 3;
    for (let ms = 3 * D; ms > 0; ms -= 7 * 60 * S + 13 * S) { const t = tier(Math.ceil(ms / 1000) * 1000); expect(t).toBeLessThanOrEqual(last); last = t; }
  });
});

describe('formatEndsAt', () => {
  it('names the instant in the given zone, in the viewer language', () => {
    const t = Date.UTC(2026, 9, 9, 19, 15); // 2026-10-09 19:15 UTC
    expect(formatEndsAt(t, 'de', 'Europe/Berlin')).toMatch(/Fr.*9\. Okt.*21:15/);
    expect(formatEndsAt(t, 'en', 'Europe/Berlin')).toMatch(/Fri.*9 Oct.*21:15/);
    expect(formatEndsAt(t, 'en', 'UTC')).toMatch(/19:15/);
  });
});

describe('formatDurationS', () => {
  it('the picker presets', () => {
    expect([3600, 6 * 3600, 86_400, 3 * 86_400, 7 * 86_400].map((s) => formatDurationS(s, 'en'))).toEqual(['1 h', '6 h', '24 h', '3 d', '7 d']);
    expect([3600, 3 * 86_400, 14 * 86_400].map((s) => formatDurationS(s, 'de'))).toEqual(['1 h', '3 T', '14 T']);
  });
  it('minutes, seconds and odd lengths', () => {
    expect(formatDurationS(600)).toBe('10 min');
    expect(formatDurationS(90)).toBe('90 s');
    expect(formatDurationS(3 * 86_400 + 3600)).toBe('73 h');
    expect(formatDurationS(0)).toBe('0 s');
    expect(formatDurationS(-3)).toBe('0 s');
  });
});

describe('formatDurationLong', () => {
  it('words for a sentence, in the viewer language', () => {
    expect(formatDurationLong(300, 'en')).toBe('5 minutes');
    expect(formatDurationLong(300, 'de')).toBe('5 Minuten');
    expect(formatDurationLong(86_400, 'en')).toBe('24 hours');
    expect(formatDurationLong(86_400, 'de')).toBe('24 Stunden');
    expect(formatDurationLong(259_200, 'en')).toBe('3 days');
    expect(formatDurationLong(259_200, 'de')).toBe('3 Tage');
    expect(formatDurationLong(3600, 'en')).toBe('1 hour');
    expect(formatDurationLong(45, 'en')).toBe('45 seconds');
  });
});

describe('formatExtension', () => {
  it('an odd length exactly, in the units a person reads', () => {
    expect([0, 45, 59, 60, 157, 300, 3599, 3600, 3900, 7325, 86_400].map(formatExtension)).toEqual(['0 s', '45 s', '59 s', '1 min', '2 min 37 s', '5 min', '59 min 59 s', '1 h', '1 h 5 min', '2 h 2 min', '24 h']);
    expect(formatExtension(-4)).toBe('0 s');
  });
});
