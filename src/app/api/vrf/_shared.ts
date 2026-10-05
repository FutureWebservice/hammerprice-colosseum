/** What the four VRF routes share: the feature gate (a switched-off feature answers `feature_off` as if it did not exist) and the id check. */
import { ApiError } from '@/contracts';
import { featureOn } from '@/lib/features';
import { isValidUuid } from '@/lib/uuid';

export type IdCtx = { params: Promise<{ id: string }> };

export async function requireVrf(): Promise<void> {
  if (!(await featureOn('VRF'))) throw new ApiError('feature_off', 'Not found');
}

export async function vrfId(ctx: IdCtx): Promise<string> {
  const { id } = await ctx.params;
  if (!isValidUuid(id)) throw new ApiError('not_found', 'No such draw');
  return id.toLowerCase();
}
