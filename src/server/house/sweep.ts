/**
 * The house-room check that a read of the schedule triggers (rollover.ts keepHouseShowAlive), shared.
 *
 * The schedule page asks GET /api/shows four times at once (the demo room, live, upcoming, ended), and each answer used to run its own check: about five
 * statements each, four times over, in front of every list. Now one check runs per instance at a time and its answer is reused for `ttlMs`, however many
 * lists ask. A house show that ends or is due is noticed at most that long later, which is inside the five seconds the CDN keeps the list anyway.
 */
import { createMemo } from '@/lib/http/memo';
import type { RolloverResult } from './rollover';

export const HOUSE_SWEEP_MS = 5_000;

export function createHouseSweep(run: () => Promise<RolloverResult>, ttlMs = HOUSE_SWEEP_MS): () => Promise<RolloverResult> {
  const memo = createMemo<RolloverResult>(ttlMs, 1);
  return () => memo.get('house', run);
}

/** keepHouseShowAlive never throws, so a failed check is remembered like any other answer for the few seconds. */
export const houseSweep = createHouseSweep(async () => (await import('./rollover')).keepHouseShowAlive());
