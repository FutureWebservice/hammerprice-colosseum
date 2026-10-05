/**
 * The hard cost cap, in the database. Every model call first RESERVES its worst case in `ai_usage` inside a transaction that holds one
 * advisory lock, so concurrent requests are counted one after another and the sum can never pass the budget; afterwards the row is
 * rewritten with the real cost from `usageMetadata`. Budgets: AI_DAILY_BUDGET_USD (default 1) and AI_MONTHLY_BUDGET_USD (default 10),
 * windows are UTC days and months. A refused reservation means "use the template": the feature degrades, it never overspends.
 */
import { and, eq, gt, gte, isNull, sql } from 'drizzle-orm';
import type { db as DbInstance } from '@/db';
import { aiUsage } from '@/db/schema';
import type { Usage } from './config';

type Db = typeof DbInstance;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** One lock key for the whole AI budget (an arbitrary constant). */
const BUDGET_LOCK = 7_340_001;

export const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
export const startOfUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export const lockBudget = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK})`);

const spentSince = async (tx: Tx, since: Date): Promise<number> => {
  const [r] = await tx.select({ n: sql<number>`coalesce(sum(${aiUsage.costMicroUsd}), 0)::bigint` }).from(aiUsage).where(gte(aiUsage.createdAt, since));
  return Number(r?.n ?? 0);
};

/** A call that has not settled after this long is dead (the adapter's own deadline is 20 s, the route's maxDuration 30 s): it no longer counts as in flight. */
export const IN_FLIGHT_MS = 35_000;

export interface Gate { dailyMicro: number; monthlyMicro: number; maxConcurrent?: number; breakerErrors?: number; breakerWindowS?: number }

const countRows = async (tx: Tx, ...where: Parameters<typeof and>): Promise<number> => {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(aiUsage).where(and(...where));
  return Number(r?.n ?? 0);
};

/**
 * Call after `lockBudget`. Why a model call may NOT happen now, or null: `busy` (too many calls in flight across all instances: the open
 * reservations of the last IN_FLIGHT_MS), `breaker` (Google keeps failing: this many upstream failures, those with no usage reported, within
 * the window; it closes by itself when they age out, so a dead Google is probed a few times per window, not on every request). The caller then
 * answers from the template or the FAQ: the model path fails closed, the feature degrades.
 */
export async function blockedBy(tx: Tx, cfg: Gate, now: Date): Promise<'busy' | 'breaker' | null> {
  if (cfg.maxConcurrent !== undefined && (await countRows(tx, eq(aiUsage.status, 'reserved'), gt(aiUsage.createdAt, new Date(now.getTime() - IN_FLIGHT_MS)))) >= cfg.maxConcurrent) return 'busy';
  if (cfg.breakerErrors !== undefined && (await countRows(tx, eq(aiUsage.status, 'error'), isNull(aiUsage.inputTokens), gt(aiUsage.createdAt, new Date(now.getTime() - (cfg.breakerWindowS ?? 120) * 1000)))) >= cfg.breakerErrors) return 'breaker';
  return null;
}

/** Call after `lockBudget`. True when a call may go ahead: not busy, no open breaker, and `reserve` still fits under both the daily and the monthly budget. */
export async function hasRoom(tx: Tx, cfg: Gate, reserve: number, now: Date): Promise<boolean> {
  if (await blockedBy(tx, cfg, now)) return false;
  if ((await spentSince(tx, startOfUtcDay(now))) + reserve > cfg.dailyMicro) return false;
  return (await spentSince(tx, startOfUtcMonth(now))) + reserve <= cfg.monthlyMicro;
}

export interface UsageRow { profileId: string | null; requestId: string; kind: 'listing' | 'ask' | 'agent'; model: string; provider: string | null; cluster: string | null; reserveMicro: number }

/** Inserts the reservation. Unique (kind, requestId): a second request with the same id throws a unique violation, which the caller maps to "already in progress". */
export async function reserve(tx: Tx, u: UsageRow, now: Date): Promise<string> {
  const [r] = await tx.insert(aiUsage).values({ profileId: u.profileId, requestId: u.requestId, kind: u.kind, model: u.model, provider: u.provider, cluster: u.cluster, status: 'reserved', costMicroUsd: u.reserveMicro, createdAt: now }).returning({ id: aiUsage.id });
  return r!.id;
}

/** Replaces the reservation with the outcome and the real cost (0 when the call never reached Google). */
export async function settle(db: Db | Tx, id: string, o: { status: 'ok' | 'error' | 'refused' | 'template'; costMicro: number; usage?: Usage | null; provider?: string | null }): Promise<void> {
  await db.update(aiUsage).set({
    status: o.status, costMicroUsd: o.costMicro, inputTokens: o.usage?.inputTokens ?? null, outputTokens: o.usage?.outputTokens ?? null, thinkingTokens: o.usage?.thinkingTokens ?? null,
    ...(o.provider !== undefined ? { provider: o.provider } : {}),
  }).where(eq(aiUsage.id, id));
}
