import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { RULE_DEFAULTS, envRuleDefaults, parseSettlementWindowS, resolveRules } from '../rules';
import { FEE_BPS_DEFAULT, FEE_BPS_MAX, parseFeeBps, platformFeeBps, splitGross } from '../fees';

describe('resolveRules', () => {
  it('fills the defaults for nothing, null and garbage', () => {
    for (const raw of [undefined, null, {}, 'x', 42, [], []]) expect(resolveRules(raw)).toEqual(RULE_DEFAULTS);
  });
  it('keeps valid overrides', () => {
    expect(resolveRules({ lotDurationS: 60, gapS: 3 })).toMatchObject({ lotDurationS: 60, gapS: 3, snipeExtendS: 15 });
  });
  it('clamps duration to 10 s..1 h', () => {
    expect(resolveRules({ lotDurationS: 1 }).lotDurationS).toBe(10);
    expect(resolveRules({ lotDurationS: 99999 }).lotDurationS).toBe(3600);
  });
  it('keeps the snipe window inside the duration and the call thresholds ordered', () => {
    const r = resolveRules({ lotDurationS: 20, snipeWindowS: 500, callOnceS: 500, callTwiceS: 400 });
    expect(r.snipeWindowS).toBe(20);
    expect(r.callOnceS).toBe(20);
    expect(r.callTwiceS).toBe(20);
    expect(resolveRules({ callOnceS: 4, callTwiceS: 9 }).callTwiceS).toBe(4);
  });
  it('caps the extension at 600 s and never goes negative', () => {
    expect(resolveRules({ maxExtensionS: 5000 }).maxExtensionS).toBe(600);
    expect(resolveRules({ maxExtensionS: -5, snipeExtendS: -1, gapS: -9 })).toMatchObject({ maxExtensionS: 0, snipeExtendS: 0, gapS: 0 });
  });
  it('ignores NaN, Infinity, strings and unknown keys', () => {
    const r = resolveRules({ lotDurationS: NaN, gapS: Infinity, snipeWindowS: '30', bogus: 1 });
    expect(r).toEqual(RULE_DEFAULTS);
    expect(r).not.toHaveProperty('bogus');
  });
  it('floors fractions', () => expect(resolveRules({ lotDurationS: 45.9 }).lotDurationS).toBe(45));
  it('is idempotent (property)', () => {
    fc.assert(fc.property(fc.record({ lotDurationS: fc.double(), callOnceS: fc.integer(), callTwiceS: fc.integer(), snipeWindowS: fc.integer(), snipeExtendS: fc.integer(), maxExtensionS: fc.integer(), gapS: fc.integer(), settlementWindowS: fc.integer() }, { requiredKeys: [] }), (raw) => {
      const once = resolveRules(raw);
      expect(resolveRules(once)).toEqual(once);
      expect(once.snipeWindowS).toBeLessThanOrEqual(once.lotDurationS);
      expect(once.callTwiceS).toBeLessThanOrEqual(once.callOnceS);
    }));
  });
});

describe('SETTLEMENT_WINDOW_S', () => {
  it('defaults to 900 and never to 0', () => {
    for (const raw of [undefined, '', '  ', 'abc', '-5', '0', '59', '999999999', '1.5']) expect(parseSettlementWindowS(raw)).toBe(900);
    expect(parseSettlementWindowS('600')).toBe(600);
    expect(envRuleDefaults({ SETTLEMENT_WINDOW_S: '' }).settlementWindowS).toBe(900);
    expect(resolveRules({}, envRuleDefaults({ SETTLEMENT_WINDOW_S: '120' })).settlementWindowS).toBe(120);
  });
});

describe('parseFeeBps', () => {
  it('uses the default for unset, empty and blank (an empty env must not become 0)', () => {
    for (const raw of [undefined, '', '   ']) expect(parseFeeBps(raw)).toBe(FEE_BPS_DEFAULT);
    expect(FEE_BPS_DEFAULT).toBe(250);
  });
  it('falls back for garbage, negative, fractional and absurd values', () => {
    for (const raw of ['abc', '-5', '2.5', '20000', '1001', '1e3', '0x10', '250bps']) expect(parseFeeBps(raw)).toBe(FEE_BPS_DEFAULT);
  });
  it('accepts whole numbers up to the maximum, including an explicit 0', () => {
    expect(parseFeeBps('300')).toBe(300);
    expect(parseFeeBps(' 100 ')).toBe(100);
    expect(parseFeeBps(String(FEE_BPS_MAX))).toBe(FEE_BPS_MAX);
    expect(parseFeeBps('0')).toBe(0);
  });
  it('reads PLATFORM_FEE_BPS from the env object', () => {
    expect(platformFeeBps({ PLATFORM_FEE_BPS: '' })).toBe(250);
    expect(platformFeeBps({ PLATFORM_FEE_BPS: '400' })).toBe(400);
    expect(platformFeeBps({})).toBe(250);
  });
  it('never returns an invalid value (property)', () => {
    fc.assert(fc.property(fc.string(), (raw) => { const n = parseFeeBps(raw); expect(Number.isInteger(n) && n >= 0 && n <= FEE_BPS_MAX).toBe(true); }));
  });
});

describe('splitGross', () => {
  it('splits 120 USDC at 2.5%', () => {
    expect(splitGross(120_000_000n, 250)).toEqual({ seller: 117_000_000n, platform: 3_000_000n, royalty: 0n });
  });
  it('floors the platform share and gives the remainder to the seller', () => {
    expect(splitGross(999n, 250)).toEqual({ seller: 975n, platform: 24n, royalty: 0n });
    expect(splitGross(0n, 250)).toEqual({ seller: 0n, platform: 0n, royalty: 0n });
  });
  it('carves the royalty out of the seller proceeds', () => {
    expect(splitGross(100_000_000n, 250, 500)).toEqual({ seller: 92_500_000n, platform: 2_500_000n, royalty: 5_000_000n });
  });
  it('rejects negative gross, bad bps and fee plus royalty above 100%', () => {
    expect(() => splitGross(-1n, 250)).toThrow(RangeError);
    expect(() => splitGross(1n, -1)).toThrow(RangeError);
    expect(() => splitGross(1n, 1.5)).toThrow(RangeError);
    expect(() => splitGross(1n, 10_001)).toThrow(RangeError);
    expect(() => splitGross(1n, 6000, 5000)).toThrow(RangeError);
  });
  it('seller + platform + royalty == gross and platform == floor(gross x bps / 10000) (property, up to 10^12)', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: FEE_BPS_MAX }), fc.integer({ min: 0, max: 2000 }), (gross, fee, roy) => {
      const s = splitGross(gross, fee, roy);
      expect(s.seller + s.platform + s.royalty).toBe(gross);
      expect(s.platform).toBe((gross * BigInt(fee)) / 10_000n);
      expect(s.royalty).toBe((gross * BigInt(roy)) / 10_000n);
      expect(s.seller >= 0n && s.platform >= 0n && s.royalty >= 0n).toBe(true);
    }));
  });
  it('the platform fee never exceeds the exact fraction (property)', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), (gross) => { expect(splitGross(gross, 250).platform * 10_000n <= gross * 250n).toBe(true); }));
  });
});
