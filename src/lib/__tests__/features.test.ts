/**
 * The optional features' switches: FEATURE_<NAME>=true in the environment (off by default) AND an ops kill switch in app_flags that can only
 * switch a feature off. The flag table is mocked: the rule is what is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_NAMES, featureEnv, featureFlagKey, featuresFromEnv, featureOn } from '../features';

let rows: { key: string; value: unknown }[] = [];
let tableDown = false;
let reads = 0;
vi.mock('@/app/api/auctions/_shared/http', () => ({
  getDb: async () => ({ select: () => ({ from: async () => { reads++; if (tableDown) throw new Error('relation "app_flags" does not exist'); return rows; } }) }),
}));

const ENV_KEYS = FEATURE_NAMES.map((n) => `FEATURE_${n}`);
beforeEach(async () => {
  rows = []; tableDown = false; reads = 0;
  for (const k of ENV_KEYS) vi.stubEnv(k, '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  (await import('@/app/api/auctions/_shared/flags')).clearFlagMemo();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the environment half', () => {
  it('names the features, and a feature is on only for exactly "true"', () => {
    expect([...FEATURE_NAMES]).toEqual(['VRF', 'TIMED', 'VIDEO', 'AI', 'CHAT', 'PACKS', 'TELEGRAM']);
    expect(featureFlagKey('VRF')).toBe('vrf');
    for (const v of [undefined, '', 'false', 'TRUE', '1', 'yes', 'true ', ' true', 'on']) expect(featureEnv('VRF', { FEATURE_VRF: v }), String(v)).toBe(false);
    expect(featureEnv('VRF', { FEATURE_VRF: 'true' })).toBe(true);
    expect(featuresFromEnv({})).toEqual({ VRF: false, TIMED: false, VIDEO: false, AI: false, CHAT: false, PACKS: false, TELEGRAM: false });
    expect(featuresFromEnv({ FEATURE_AI: 'true' })).toMatchObject({ AI: true, VIDEO: false });
  });
});

describe('featureOn: environment AND kill switch', () => {
  it('is off by default and does not even read the database for a feature the environment has not enabled', async () => {
    for (const n of FEATURE_NAMES) expect(await featureOn(n), n).toBe(false);
    expect(reads).toBe(0);
  });

  it('is on with the environment and no row at all (a missing row is "not killed")', async () => {
    vi.stubEnv('FEATURE_VRF', 'true');
    expect(await featureOn('VRF')).toBe(true);
    expect(await featureOn('TIMED')).toBe(false);
  });

  it('a row set to false kills a feature the environment enabled; any other row value does not', async () => {
    vi.stubEnv('FEATURE_VIDEO', 'true');
    vi.stubEnv('FEATURE_CHAT', 'true');
    rows = [{ key: 'video', value: false }, { key: 'chat', value: true }];
    expect(await featureOn('VIDEO')).toBe(false);
    expect(await featureOn('CHAT')).toBe(true);
  });

  it('a row can never ENABLE a feature the environment has not: no deploy-level yes, no feature', async () => {
    rows = [{ key: 'ai', value: true }, { key: 'vrf', value: true }];
    expect(await featureOn('AI')).toBe(false);
    const { readFlags } = await import('@/app/api/auctions/_shared/flags');
    expect(await readFlags()).toMatchObject({ ai: false, vrf: false });
  });

  it('an unreadable flag table turns the optional features OFF (it keeps the core switches on, as before)', async () => {
    vi.stubEnv('FEATURE_AI', 'true');
    tableDown = true;
    expect(await featureOn('AI')).toBe(false);
    const { readFlags, clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    clearFlagMemo();
    expect(await readFlags()).toMatchObject({ bidding: true, settlement: true, faucet: true, mint: true, house_bots: true, ai: false });
  });
});

describe('readFlags reports the effective state', () => {
  it('lists every core switch (default on) and every optional feature (default off)', async () => {
    const { readFlags, FLAG_KEYS } = await import('@/app/api/auctions/_shared/flags');
    const f = await readFlags();
    expect(Object.keys(f).sort()).toEqual([...FLAG_KEYS].sort());
    expect(f).toMatchObject({ bidding: true, settlement: true, faucet: true, mint: true, house_bots: true, vrf: false, timed: false, video: false, ai: false, chat: false, packs: false });
  });

  it('shows a feature on when the environment says so and no row kills it; core rows behave as before (only false is off)', async () => {
    vi.stubEnv('FEATURE_TIMED', 'true');
    rows = [{ key: 'bidding', value: false }, { key: 'faucet', value: 'maybe' }, { key: 'timed', value: 'maybe' }];
    const { readFlags } = await import('@/app/api/auctions/_shared/flags');
    expect(await readFlags()).toMatchObject({ bidding: false, faucet: true, timed: true });
  });
});
