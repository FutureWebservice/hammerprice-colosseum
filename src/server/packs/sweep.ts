/**
 * The pack part of the daily sweep: expires draws whose time ran out (the card goes back to the pool), finalizes payments that landed, and keeps
 * the platform's devnet test pack alive. Nothing depends on it (every read of a draw does the same lazily); it is the safety net. A switched-off
 * feature or a deployment without payments configured does nothing and never fails the sweep.
 */
import { ApiError } from '@/contracts';
import { featureOn } from '@/lib/features';

export async function sweepPacks(now = new Date()): Promise<{ expired: number; finalized: number; housePack: string }> {
  const zero = { expired: 0, finalized: 0, housePack: 'off' };
  if (!(await featureOn('PACKS'))) return zero;
  const { getPackService } = await import('./instance');
  try {
    const swept = await getPackService().sweep(now);
    const housePack = await (await import('./house')).keepHousePackAlive({ maxMint: 1 });
    return { ...swept, housePack };
  } catch (e) {
    if (e instanceof ApiError && e.code === 'paused') return zero; // payments are not set up: nothing to sweep
    throw e;
  }
}
