/**
 * What keeps the house rollover from hammering a rate-limited RPC (the public devnet endpoint answers HTTP 429 to shared Vercel IPs).
 *
 *   backoff   after a failed rollover the next attempt waits 60 s, doubling to 10 minutes, and a success resets it. The state sits in
 *             module memory (fast path, no query) AND in an app_flags row, so every serverless instance sees it. `allowed()` is only asked
 *             when a rollover is actually needed, never on the happy path of a read.
 *   readiness a card that passed the chain check counts as ready for 10 minutes without asking again (memory plus the same kind of row),
 *             and when the chain cannot answer (rpc_unavailable: 429, 5xx, timeout) a card that passed within the last 24 hours still counts:
 *             house cards are the platform's own and were verified when they were minted. No cached verdict means no guess: the caller backs off.
 *
 * Every store call is allowed to fail (a missing table, a closed pool): the guard then works from memory alone. Clocks are injected.
 */
import { sql } from 'drizzle-orm';
import type { AssetReadiness } from '@/contracts';

export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 600_000;
export const READY_TTL_MS = 10 * 60_000;
export const READY_STALE_MS = 24 * 3_600_000;
export const STATE_KEY = 'house_rollover_state';
export const READY_KEY = 'house_readiness_ok';

export interface FlagStore { load(key: string): Promise<unknown>; save(key: string, value: unknown): Promise<void> }

/** app_flags as a key/value store. Never throws. */
export function dbFlagStore(db: { execute(q: ReturnType<typeof sql>): Promise<unknown> }): FlagStore {
  return {
    async load(key) {
      try {
        const res = (await db.execute(sql`select value from app_flags where key = ${key}`)) as { rows: { value: unknown }[] };
        return res.rows[0]?.value ?? null;
      } catch { return null; }
    },
    async save(key, value) {
      try { await db.execute(sql`insert into app_flags (key, value, updated_at) values (${key}, ${JSON.stringify(value)}::jsonb, now()) on conflict (key) do update set value = excluded.value, updated_at = now()`); } catch { /* memory still holds it */ }
    },
  };
}

// ---- backoff ----------------------------------------------------------------------------------------------------------------

export interface RolloverState { failures: number; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null; nextRetryAt: number }
const EMPTY: RolloverState = { failures: 0, lastOkAt: null, lastError: null, lastErrorAt: null, nextRetryAt: 0 };

/** 60 s after the first failure, doubling, 10 minutes at most. */
export const backoffDelayMs = (failures: number): number => Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, failures - 1));

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export function parseState(v: unknown): RolloverState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { failures: num(o.failures) ?? 0, lastOkAt: num(o.lastOkAt), lastError: typeof o.lastError === 'string' ? o.lastError : null, lastErrorAt: num(o.lastErrorAt), nextRetryAt: num(o.nextRetryAt) ?? 0 };
}
export const readRolloverState = async (store: FlagStore): Promise<RolloverState | null> => parseState(await store.load(STATE_KEY));

export interface RolloverBackoff {
  /** True when a rollover attempt may run now. */
  allowed(): Promise<boolean>;
  fail(message: string): Promise<void>;
  ok(): Promise<void>;
  /** Tests only. */
  reset(): void;
}

export function createRolloverBackoff(store: FlagStore, now: () => number = Date.now): RolloverBackoff {
  let mem: RolloverState = EMPTY;
  const newest = async (): Promise<RolloverState> => {
    const d = await readRolloverState(store);
    return d && d.nextRetryAt > mem.nextRetryAt ? d : mem;
  };
  return {
    async allowed() {
      if (mem.nextRetryAt > now()) return false;
      const d = await readRolloverState(store); // another instance may have failed a moment ago
      if (d && d.nextRetryAt > now()) { mem = d; return false; }
      return true;
    },
    async fail(message) {
      const cur = await newest();
      const failures = Math.max(cur.failures, mem.failures) + 1;
      mem = { ...cur, failures, lastError: message.slice(0, 200), lastErrorAt: now(), nextRetryAt: now() + backoffDelayMs(failures) };
      await store.save(STATE_KEY, mem);
    },
    async ok() {
      const cur = await newest();
      mem = { ...EMPTY, lastOkAt: now(), lastError: cur.lastError, lastErrorAt: cur.lastErrorAt };
      await store.save(STATE_KEY, mem);
    },
    reset() { mem = EMPTY; },
  };
}

// ---- readiness --------------------------------------------------------------------------------------------------------------

export interface ReadinessResult {
  verdicts: Map<string, AssetReadiness>;
  /** Set when the chain could not answer for cards that had no cached verdict: a caller that still lacks cards must back off with it. */
  error: Error | null;
}

const OK: AssetReadiness = { eligible: true, reasons: [] };
const isChainDown = (e: unknown): boolean => (e as { code?: string } | null)?.code === 'rpc_unavailable';

export function createHouseReadiness(opts: { store: FlagStore; now?: () => number; warn?: (m: string) => void }) {
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const mem = new Map<string, number>(); // mint to the time it last passed
  let warnedAt = 0;

  const merge = async () => {
    const d = await opts.store.load(READY_KEY);
    if (d && typeof d === 'object') for (const [m, t] of Object.entries(d as Record<string, unknown>)) if (typeof t === 'number' && t > (mem.get(m) ?? 0)) mem.set(m, t);
  };
  const persist = async () => {
    const cut = now() - READY_STALE_MS;
    for (const [m, t] of mem) if (t < cut) mem.delete(m);
    await opts.store.save(READY_KEY, Object.fromEntries(mem));
  };

  return {
    /** `read` asks the chain for the given mints in one go (the cache never calls it for a card that passed within 10 minutes). */
    async check(mints: string[], read: (mints: string[]) => Promise<AssetReadiness[]>): Promise<ReadinessResult> {
      const verdicts = new Map<string, AssetReadiness>();
      const fresh = (m: string) => now() - (mem.get(m) ?? -Infinity) < READY_TTL_MS;
      let rest = mints.filter((m) => !fresh(m));
      for (const m of mints) if (!rest.includes(m)) verdicts.set(m, OK);
      if (rest.length === 0) return { verdicts, error: null };
      // Another instance may have verified some of them a moment ago.
      await merge();
      rest = rest.filter((m) => !fresh(m));
      for (const m of mints) if (!rest.includes(m)) verdicts.set(m, OK);
      if (rest.length === 0) return { verdicts, error: null };
      try {
        const got = await read(rest);
        rest.forEach((m, i) => verdicts.set(m, got[i]!));
        let changed = false;
        rest.forEach((m, i) => {
          if (got[i]!.eligible) { mem.set(m, now()); changed = true; } else if (mem.delete(m)) changed = true; // a card that failed is not vouched for any more
        });
        if (changed) await persist();
        return { verdicts, error: null };
      } catch (e) {
        if (!isChainDown(e)) throw e;
        const stale = rest.filter((m) => now() - (mem.get(m) ?? -Infinity) < READY_STALE_MS);
        for (const m of stale) verdicts.set(m, OK);
        if (stale.length > 0 && now() - warnedAt > READY_TTL_MS) {
          warnedAt = now();
          warn(`house rollover: the chain check failed (${(e as Error).message}), using the verdict of the last 24 hours for ${stale.length} card(s)`);
        }
        return { verdicts, error: stale.length === rest.length ? null : (e as Error) };
      }
    },
    /** Tests only. */
    reset() { mem.clear(); warnedAt = 0; },
  };
}
export type HouseReadiness = ReturnType<typeof createHouseReadiness>;

/** A backoff that never blocks and remembers nothing: for the operator's seed script, which wants its answer now. */
export const noBackoff: RolloverBackoff = { allowed: async () => true, fail: async () => {}, ok: async () => {}, reset() {} };

const guards = new WeakMap<object, { backoff: RolloverBackoff; readiness: HouseReadiness }>();
/** One backoff and one readiness cache per database handle (so per server instance), stored in that database's app_flags. */
export function guardFor(db: { execute(q: ReturnType<typeof sql>): Promise<unknown> }): { backoff: RolloverBackoff; readiness: HouseReadiness } {
  let g = guards.get(db);
  if (!g) {
    const store = dbFlagStore(db);
    g = { backoff: createRolloverBackoff(store), readiness: createHouseReadiness({ store }) };
    guards.set(db, g);
  }
  return g;
}
