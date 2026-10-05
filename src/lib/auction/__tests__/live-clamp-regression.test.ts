/**
 * resolveRules(raw, defaults, kind = 'live'): the kind is carried through, and a LIVE show's clamp table is bit-identical to what it was before
 * the kind parameter existed. The reference below is the previous implementation, copied verbatim; if resolveRules ever changes for 'live',
 * this fails before a live show behaves differently.
 */
import { describe, expect, it } from 'vitest';
import { RULE_DEFAULTS, envRuleDefaults, resolveRules, type AuctionRules } from '../rules';

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
function legacyResolveRules(raw: unknown, defaults: AuctionRules = RULE_DEFAULTS): AuctionRules {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (k: keyof AuctionRules): number => {
    const v = src[k];
    return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : defaults[k];
  };
  const lotDurationS = clamp(pick('lotDurationS'), 10, 3600);
  const callOnceS = clamp(pick('callOnceS'), 1, lotDurationS);
  return {
    lotDurationS,
    callOnceS,
    callTwiceS: clamp(pick('callTwiceS'), 1, callOnceS),
    snipeWindowS: clamp(pick('snipeWindowS'), 0, lotDurationS),
    snipeExtendS: clamp(pick('snipeExtendS'), 0, 600),
    maxExtensionS: clamp(pick('maxExtensionS'), 0, 600),
    gapS: clamp(pick('gapS'), 0, 600),
    settlementWindowS: clamp(pick('settlementWindowS'), 60, 7 * 86400),
  };
}

const VALUES = [undefined, null, 'x', NaN, Infinity, -Infinity, -1e9, -1, 0, 0.9, 1, 2, 5, 9, 10, 11, 15, 45, 60, 90, 120, 600, 601, 900, 3600, 3601, 86_400, 604_800, 604_801, 1_209_600, 1e12];
const KEYS = ['lotDurationS', 'callOnceS', 'callTwiceS', 'snipeWindowS', 'snipeExtendS', 'maxExtensionS', 'gapS', 'settlementWindowS'] as const;

describe('live clamp table', () => {
  it('golden rows: the defaults and the extremes of every key', () => {
    expect(resolveRules({})).toEqual({ lotDurationS: 45, callOnceS: 10, callTwiceS: 5, snipeWindowS: 15, snipeExtendS: 15, maxExtensionS: 120, gapS: 6, settlementWindowS: 900 });
    expect(resolveRules({ lotDurationS: 1e12, snipeExtendS: 1e12, maxExtensionS: 1e12, gapS: 1e12, settlementWindowS: 1e12, callOnceS: 1e12, callTwiceS: 1e12, snipeWindowS: 1e12 }))
      .toEqual({ lotDurationS: 3600, callOnceS: 3600, callTwiceS: 3600, snipeWindowS: 3600, snipeExtendS: 600, maxExtensionS: 600, gapS: 600, settlementWindowS: 604_800 });
    expect(resolveRules({ lotDurationS: -5, snipeExtendS: -5, maxExtensionS: -5, gapS: -5, settlementWindowS: -5, callOnceS: -5, callTwiceS: -5, snipeWindowS: -5 }))
      .toEqual({ lotDurationS: 10, callOnceS: 1, callTwiceS: 1, snipeWindowS: 0, snipeExtendS: 0, maxExtensionS: 0, gapS: 0, settlementWindowS: 60 });
    expect(resolveRules({ lotDurationS: 86_400, maxExtensionS: 86_400 }).lotDurationS).toBe(3600); // a live show cannot run for days, whatever the request schema now admits
    expect(resolveRules({ lotDurationS: 86_400, maxExtensionS: 86_400 }).maxExtensionS).toBe(600);
  });

  it('is bit-identical to the previous implementation over every value of every key, with the default kind and with kind "live"', () => {
    let n = 0;
    for (const key of KEYS) for (const v of VALUES) {
      const raw = { [key]: v };
      expect(resolveRules(raw), `${key}=${String(v)}`).toEqual(legacyResolveRules(raw));
      expect(resolveRules(raw, RULE_DEFAULTS, 'live'), `${key}=${String(v)} live`).toEqual(legacyResolveRules(raw));
      n++;
    }
    for (const a of VALUES) for (const b of VALUES) {
      const raw = { lotDurationS: a, callOnceS: b, callTwiceS: a, snipeWindowS: b, maxExtensionS: a };
      expect(resolveRules(raw, envRuleDefaults({ SETTLEMENT_WINDOW_S: '7200' }), 'live')).toEqual(legacyResolveRules(raw, envRuleDefaults({ SETTLEMENT_WINDOW_S: '7200' })));
      n++;
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('non-object input and unknown keys behave as before', () => {
    for (const raw of [null, undefined, 'x', 7, [], [1, 2], { surprise: 5 }]) expect(resolveRules(raw)).toEqual(legacyResolveRules(raw));
  });

  it('the kind selects the table: timed now has its own ranges (timed-rules-engine.test.ts), live stays as above', () => {
    const raw = { lotDurationS: 600, snipeExtendS: 300 };
    expect(resolveRules(raw, RULE_DEFAULTS, 'timed')).not.toEqual(resolveRules(raw, RULE_DEFAULTS, 'live'));
    expect(resolveRules(raw, RULE_DEFAULTS, 'live')).toEqual(legacyResolveRules(raw));
    expect(resolveRules.length).toBeLessThanOrEqual(3);
  });
});
