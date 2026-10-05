import { describe, it, expect } from 'vitest';
import { Amount } from '@/contracts/common';
import { baseToInput, formatUsdc, parseUsdc, MAX_USDC_BASE } from '../money';

describe('parseUsdc', () => {
  it.each([
    ['12', '12000000'],
    ['12.5', '12500000'],
    ['12,50', '12500000'],
    ['0.000001', '1'],
    ['  7.25 ', '7250000'],
    ['1000000', '1000000000000'],
  ])('%s -> %s', (input, base) => {
    const r = parseUsdc(input);
    expect(r).toEqual({ ok: true, base });
    expect(Amount.safeParse(base).success).toBe(true); // what we send is a valid contract Amount
  });

  it.each([
    ['', 'required'],
    ['   ', 'required'],
    ['abc', 'invalid'],
    ['1.2.3', 'invalid'],
    ['1,000.50', 'invalid'],
    ['-5', 'invalid'],
    ['1e3', 'invalid'],
    ['0.0000001', 'invalid'],
    ['.5', 'invalid'],
    ['0', 'zero'],
    ['0.000000', 'zero'],
    ['1000001', 'too_large'],
    ['999999999', 'too_large'],
  ])('%j is refused as %s', (input, issue) => {
    expect(parseUsdc(input)).toEqual({ ok: false, issue });
  });

  it('never loses a base unit to floating point', () => {
    // 0.1 + 0.2 style traps: 4.35 * 100 is 434.99999999999994 in floats
    expect(parseUsdc('4.35')).toEqual({ ok: true, base: '4350000' });
    expect(parseUsdc('1000000')).toEqual({ ok: true, base: MAX_USDC_BASE.toString() });
  });
});

describe('baseToInput and formatUsdc', () => {
  it('round-trips through what a person would type', () => {
    for (const base of ['1', '10000', '12500000', '1000000', '999999999999']) {
      expect(parseUsdc(baseToInput(base))).toEqual({ ok: true, base });
    }
  });

  it('formats with the viewer locale and at least two decimals', () => {
    expect(formatUsdc('12500000', 'en')).toBe('12.50 USDC');
    expect(formatUsdc('12500000', 'de')).toBe('12,50 USDC');
    expect(formatUsdc('1234567890000', 'en')).toBe('1,234,567.89 USDC');
    expect(formatUsdc('1234567890000', 'de')).toBe('1.234.567,89 USDC');
    expect(formatUsdc('1', 'en')).toBe('0.000001 USDC');
    expect(formatUsdc('0', 'en')).toBe('0.00 USDC');
  });

  it('returns an empty string for a missing or malformed amount instead of printing garbage', () => {
    expect(formatUsdc(null, 'en')).toBe('');
    expect(formatUsdc(undefined, 'en')).toBe('');
    expect(formatUsdc('12.5', 'en')).toBe('');
  });
});
