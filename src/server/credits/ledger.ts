/**
 * The credit ledger: the balance of a profile is the SUM of `credit_ledger.delta`, the only source. Every booking has a unique
 * (reason, ref), so a retry books nothing twice: a purchase books (+10, 'purchase', purchaseId) once, a draft books (-1, 'usage', ref) once
 * and, if it fails, (+1, 'refund', ref) once.
 */
import { eq, sql } from 'drizzle-orm';
import type { db as DbInstance } from '@/db';
import { creditLedger } from '@/db/schema';

type Db = typeof DbInstance;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Db | Tx;

export async function balanceOf(ex: Exec, profileId: string): Promise<number> {
  const [r] = await ex.select({ n: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` }).from(creditLedger).where(eq(creditLedger.profileId, profileId));
  return r?.n ?? 0;
}

/** Books one entry; false when (reason, ref) was booked before (nothing changes). */
export async function book(ex: Exec, profileId: string, delta: number, reason: 'purchase' | 'usage' | 'refund' | 'grant', ref: string): Promise<boolean> {
  const rows = await ex.insert(creditLedger).values({ profileId, delta, reason, ref }).onConflictDoNothing().returning({ id: creditLedger.id });
  return rows.length === 1;
}
