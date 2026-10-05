/**
 * Optional features and their switches.
 *
 * Every optional feature has ONE deploy-level switch, `FEATURE_<NAME>=true` in the environment, and it is OFF unless that
 * variable is exactly "true". On top of it sits an ordinary ops kill switch: a row in `app_flags` (key = the lower-case
 * name) whose value is `false` turns the feature off again within seconds, without a redeploy. The row can only switch a
 * feature OFF; it never enables one that the environment has not enabled, and a missing row means "not killed".
 *
 *   effective = FEATURE_<NAME> === 'true'  AND  app_flags.<name> !== false
 *
 * The cluster is NOT a feature switch: SOLANA_CLUSTER=mainnet-beta is the one switch that moves everything to mainnet
 * (lib/chain/config.ts), and every feature follows it. A feature that is switched off answers `feature_off` (404) as if it
 * did not exist.
 */
export const FEATURE_NAMES = ['VRF', 'TIMED', 'VIDEO', 'AI', 'CHAT', 'PACKS', 'TELEGRAM'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** The `app_flags` key of a feature. */
export const featureFlagKey = (name: FeatureName): Lowercase<FeatureName> => name.toLowerCase() as Lowercase<FeatureName>;

type Env = Record<string, string | undefined>;

/** The environment half only (no database): the cheap check, and the only one a client component or a script can make. */
export function featureEnv(name: FeatureName, env: Env = process.env): boolean {
  return env[`FEATURE_${name}`] === 'true';
}

/** Environment AND kill switch. The database is read only when the environment already says yes. */
export async function featureOn(name: FeatureName, env: Env = process.env): Promise<boolean> {
  if (!featureEnv(name, env)) return false;
  const { flagOn } = await import('@/app/api/auctions/_shared/flags');
  return flagOn(featureFlagKey(name));
}

/** Which features the environment enables, by name (for /api/health and the landing page, which reads no database). */
export function featuresFromEnv(env: Env = process.env): Record<FeatureName, boolean> {
  return Object.fromEntries(FEATURE_NAMES.map((n) => [n, featureEnv(n, env)])) as Record<FeatureName, boolean>;
}
