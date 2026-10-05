/**
 * The feature switch of packs. FEATURE_PACKS is the one ops switch (off unless exactly "true", plus the app_flags kill switch `packs`).
 * There is NO network or legal flag here: the feature runs on whatever SOLANA_CLUSTER says, like every other feature.
 * A switched-off feature answers `feature_off` (404) as if it did not exist.
 */
import { ApiError } from '@/contracts';
import { featureOn } from '@/lib/features';

export async function assertPacksOn(env: Record<string, string | undefined> = process.env): Promise<void> {
  if (!(await featureOn('PACKS', env))) throw new ApiError('feature_off', 'Packs are not available here.');
}
