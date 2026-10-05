/**
 * The settlement sweep, called by the housekeeping pass and when the house room is read:
 *
 *   import { runSettlementSweep } from '@/server/settlement/sweep';
 *   const { expired, finalized } = await runSettlementSweep(new Date());
 *
 * It finalizes `submitted` settlements (a transaction that landed settles instead of expiring), expires `awaiting_payment`
 * settlements past `due_at` with the strike on the party that did not act, and drops the stored
 * signatures of rounds that ended unsigned. Idempotent and safe to run concurrently with the routes. It never sends a
 * transaction; if the chain is unreachable a settlement simply stays as it was.
 *
 * It needs the same configuration as the routes. While payments are paused (no keys) it throws ApiError('paused') and strikes
 * nobody, so a user is never struck for a settlement that nobody could complete. The caller should catch that error, report
 * zeros for this half and carry on with the auction sweep.
 */
import { getSettlementService } from './service';

export interface SettlementSweepResult { expired: number; finalized: number }

export function runSettlementSweep(now: Date = new Date()): Promise<SettlementSweepResult> {
  return getSettlementService().sweep(now);
}
