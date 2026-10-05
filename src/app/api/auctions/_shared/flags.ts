/**
 * Kill switches (`app_flags`). A flag is a jsonb boolean; an absent row or any other value
 * means "on". Read with a 5 s memo so a hot route costs one query per instance per 5 s, and a switch flipped in the
 * database takes effect within seconds without a redeploy.
 *
 * The switches of the optional features (vrf, timed, video, ai, chat, packs) differ in one way: they are also gated by
 * their FEATURE_<NAME> environment variable, which is off by default (lib/features.ts). The flag the room, the health route
 * and `flagOn` report for them is the EFFECTIVE state (environment on AND row not false), and an unreadable table turns them
 * OFF (the old flags fail open so bidding survives a table outage; an optional feature has no such duty).
 */
import { FEATURE_NAMES, featureEnv, featureFlagKey } from '@/lib/features';
import { getDb } from './http';

const FEATURE_KEYS = FEATURE_NAMES.map(featureFlagKey);
export const FLAG_KEYS = ['bidding', 'settlement', 'faucet', 'mint', 'house_bots', ...FEATURE_KEYS] as const;
const isFeatureKey = (k: string): boolean => (FEATURE_KEYS as readonly string[]).includes(k);
const TTL_MS = 5000;
let memo: { at: number; flags: Record<string, boolean> } | null = null;

export async function readFlags(now = Date.now()): Promise<Record<string, boolean>> {
  if (memo && now - memo.at < TTL_MS) return memo.flags;
  const flags: Record<string, boolean> = Object.fromEntries(FLAG_KEYS.map((k) => [k, true]));
  const envOn = (k: string): boolean => FEATURE_NAMES.some((n) => featureFlagKey(n) === k && featureEnv(n));
  try {
    const { appFlags } = await import('@/db/schema');
    for (const r of await (await getDb()).select().from(appFlags)) {
      if (!isFeatureKey(r.key)) flags[r.key] = r.value !== false;
      else if (r.value === false) flags[r.key] = false; // a feature row can only kill, never enable
    }
    for (const k of FEATURE_KEYS) flags[k] = flags[k] !== false && envOn(k); // environment on AND row not false
  } catch (e) {
    console.warn('app_flags unreadable, treating every core switch as on and every optional feature as off', (e as Error).message); // core fails open: a flag table outage must not stop bidding
    for (const k of FEATURE_KEYS) flags[k] = false;
  }
  memo = { at: now, flags };
  return flags;
}

export const flagOn = async (key: (typeof FLAG_KEYS)[number]): Promise<boolean> => (await readFlags())[key] !== false;
/** Tests only. */
export const clearFlagMemo = (): void => { memo = null; };
