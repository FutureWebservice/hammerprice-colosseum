/**
 * The house room that never closes. A judge must find a live, bid-able room at any hour with nobody
 * operating it, so this is LAZY and has no scheduler dependency: a read of the schedule (GET /api/shows) calls
 * `keepHouseShowAlive`, which creates the next house show when there is none running or due.
 *
 *   active   = a house show that is live, or scheduled within the next 10 minutes, or ended with a lot still on the block
 *   rollover = no active show: take unsold house stock (least recently listed first), check every card is still the house's and
 *              plain-transferable on chain, create the show (devnet, auto, settlement 'onchain', 40 s lots), register the three
 *              house paddles, and top the stock back up to 6 by minting replicas when it is short
 *
 * Idempotent under concurrent callers: the creation runs under a transaction-scoped advisory lock taken with
 * pg_try_advisory_xact_lock (a caller that does not get it returns 'busy' at once and never waits), and the check for an active
 * show is repeated inside the lock, so two callers never create two shows.
 *
 * With FEATURE_TIMED on, the same lazy call also keeps up to two (TIMED_HOUSE_COUNT, 0 to 4) TIMED house auctions running next to the live room (one card each, a
 * length of TIMED_HOUSE_DURATION_S, default one hour; the second one half as long, so that something always ends soon). The server signs the
 * seller's leg of those sales like it does for the live room. Timed shows are separate from the live room: the live room never waits for them
 * and a failure in the timed half is logged and ignored.
 *
 * Two optional features hook in here and nowhere else: the drawn lot order (VRF: prepareHouseShow before createShow, afterHouseShowCreated after
 * it, both in src/server/vrf/rollover-hook.ts and both allowed to fail) and the optional video (HOUSE_VIDEO_ENABLED, still gated by FEATURE_VIDEO).
 *
 * Minting spends devnet SOL from the settlement authority, so it is fenced: only when stock is below 6, never below 0.5 SOL left,
 * at most `maxMint` cards per call (no loop), and only on devnet. Nothing here can touch mainnet.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '@/contracts';
import { resolveRules, timedMinDurationS, TIMED_MAX_DURATION_S } from '@/lib/auction/rules';
import { sql } from 'drizzle-orm';
import nacl from 'tweetnacl';
import { Keypair } from '@solana/web3.js';
import type { AssetReadiness } from '@/contracts';
import { toBase64 } from '@/lib/auth/ed25519';
import { buildPaddleAuth } from '@/lib/auth/intent';
import { houseLotTerms, availableInventory, attributesRecord, type InventoryCard } from './inventory';
import { HOUSE_BOT_COUNT } from './bots';
import type { HouseShowOrder } from '@/server/vrf/rollover-hook';
import { guardFor, type RolloverBackoff, type ReadinessResult } from './rollover-guard';

type Engine = typeof import('@/server/auction/service');
type Db = typeof import('@/db').db;

export const LOTS_PER_SHOW = 6;
/** A house show that starts within this window counts as "already there". */
export const ACTIVE_WINDOW_MIN = 10;
export const MIN_SA_LAMPORTS = 500_000_000n; // 0.5 SOL
const ADVISORY_LOCK = 7_201_881; // arbitrary, unique to the house rollover
// 90 s per lot: a first-time visitor needs time for two wallet popups (paddle, payment); 40 s was too tight for a human.
const HOUSE_RULES = { lotDurationS: 90, gapS: 10 };
/** A house show can sit idle for hours (its lots advance when somebody looks), so a house paddle must still be valid when a visitor arrives. */
const BOT_PADDLE_HOURS = 24;
/** Timed house auctions: how many run at once, the default length, and how long the winner has to sign (the card stays reserved meanwhile, so 6 hours, not 3 days). */
export const TIMED_HOUSE_COUNT = 2;
/** The most TIMED_HOUSE_COUNT may be raised to; every running one is a show with its own paddles, events and a daily share of the database. */
export const TIMED_HOUSE_MAX = 4;
export const TIMED_HOUSE_DEFAULT_S = 3600;
export const TIMED_HOUSE_SETTLEMENT_S = 6 * 3600;
const TIMED_ADVISORY_LOCK = 7_201_882;

/** TIMED_HOUSE_COUNT: how many timed house auctions may run at once. Whole number 0 (none) to TIMED_HOUSE_MAX; unset or anything else is the default of 2. */
export function houseTimedCount(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TIMED_HOUSE_COUNT?.trim();
  if (!raw || !/^\d$/.test(raw)) return TIMED_HOUSE_COUNT;
  const n = Number(raw);
  return n <= TIMED_HOUSE_MAX ? n : TIMED_HOUSE_COUNT;
}

/** TIMED_HOUSE_DURATION_S: whole seconds, from the shortest timed lot (10 minutes, lower in a test environment) to 14 days; anything else is the default (one hour). */
export function houseTimedDurationS(env: Record<string, string | undefined> = process.env): number {
  const raw = env.TIMED_HOUSE_DURATION_S?.trim();
  if (!raw || !/^\d{1,8}$/.test(raw)) return TIMED_HOUSE_DEFAULT_S;
  const n = Number(raw);
  return n >= timedMinDurationS(env) && n <= TIMED_MAX_DURATION_S ? n : TIMED_HOUSE_DEFAULT_S;
}

/**
 * How long the next timed house auction runs. The first one runs the full length; a second one beside it runs half as long when the other one is
 * still more than half its length from the end, and the full length otherwise, so the two never end together and something always ends soon.
 */
export function nextTimedDurationS(fullS: number, minS: number, otherLeftS: number | null): number {
  if (otherLeftS === null || otherLeftS <= fullS / 2) return fullS;
  return Math.max(minS, Math.floor(fullS / 2));
}

/** 'backoff': the last attempt failed and its waiting time (60 s doubling to 10 minutes) has not passed; nothing was tried. */
export type RolloverResult = 'created' | 'none' | 'busy' | 'unconfigured' | 'no_stock' | 'backoff';
/** The longest a read of the schedule waits for the rollover; a slower attempt goes on in the background and counts as a failure for the backoff. */
export const ROLLOVER_DEADLINE_MS = 5000;

export interface HouseDeps {
  db: Db;
  auction: Pick<Engine, 'createShow' | 'advanceShow' | 'registerPaddle'>;
  /** The house seller's public key, or null when the house show is not available here (no key, not devnet). */
  houseWallet(): string | null;
  /** The three house bidders' keys (derived from the settlement authority), or null when it is not configured. */
  botKeys(): Keypair[] | null;
  /** Owner is the house, not frozen, plain transfer allowed: read from chain. */
  readiness(mint: string, seller: string): Promise<AssetReadiness>;
  /** The same for many cards in two requests (getMultipleAccounts). The default wiring caches positive answers (10 minutes) and falls back to a verdict of the last 24 hours when the chain cannot answer. Ignored when `readiness` is given. */
  readMany?(mints: string[], seller: string): Promise<AssetReadiness[]>;
  /** Set by ensureHouseShow from readMany; plans from cached verdicts. */
  readinessMany?(mints: string[], seller: string): Promise<ReadinessResult>;
  /** Cards left out of the plan of this call: the ones createShow refused as already_listed. Set by ensureHouseShow. */
  exclude?: Set<string>;
  /** Voids the house sales whose payment window has passed (the settlement expiry); a failure is logged and ignored. */
  expireSettlements?(): Promise<unknown>;
  /** Failure backoff of the rollover (rollover-guard.ts); ensureHouseShow supplies one per database. */
  backoff?: RolloverBackoff;
  /** Mint ONE replica to the house wallet and record it in devnet_assets; false when it must not (low SOL, no template, not configured). Called at most `maxMint` times per run. */
  mintReplica(): Promise<boolean>;
  now(): Date;
  /** The drawn-order hooks (src/server/vrf/rollover-hook.ts). Both are wrapped in try/catch: a failing hook never fails the rollover. */
  order: { prepareHouseShow(): Promise<HouseShowOrder>; afterHouseShowCreated(showId: string): Promise<void> };
  /** HOUSE_VIDEO_ENABLED: the house show carries the optional video (it still needs FEATURE_VIDEO, which createShow checks). */
  houseVideo(): boolean;
  /** FEATURE_TIMED, environment and kill switch. Off: no timed house auction is created (running ones simply finish). */
  timedOn(): Promise<boolean>;
  /** TIMED_HOUSE_DURATION_S. */
  timedDurationS(): number;
  /** TIMED_HOUSE_COUNT. */
  timedCount(): number;
}

/** Three keypairs derived from the settlement authority's secret: stable addresses with no extra secret to store. They hold no funds and no authority. */
export function deriveBotKeys(sa: Keypair, count = HOUSE_BOT_COUNT): Keypair[] {
  return Array.from({ length: count }, (_, n) => Keypair.fromSeed(createHash('sha256').update(`hammerprice/house-bidder/${n + 1}/v1`).update(sa.secretKey.slice(0, 32)).digest()));
}

const rowsOf = <T,>(r: unknown): T[] => (r as { rows: T[] }).rows;
type Exec = { execute(q: ReturnType<typeof sql>): Promise<unknown> };

async function hasActiveHouseShow(x: Exec): Promise<boolean> {
  const res = await x.execute(sql`
    select 1 as one from shows s
    where s.is_house and s.kind = 'live' and (
      s.status = 'live'
      or (s.status = 'scheduled' and s.scheduled_at is not null and s.scheduled_at <= now() + make_interval(mins => ${ACTIVE_WINDOW_MIN}))
      or (s.status = 'ended' and exists (select 1 from lots l where l.show_id = s.id and l.state = 'open')))
    limit 1`);
  return rowsOf(res).length > 0;
}

export interface HousePlan { title: string; lots: ReturnType<typeof houseLotTerms>[] }

/** What the next house show would list, without writing anything (used by the seed script's dry run). */
export async function planHouseShow(deps: Pick<HouseDeps, 'db' | 'readiness' | 'readinessMany' | 'exclude'>, house: string, count = LOTS_PER_SHOW): Promise<HousePlan> {
  // Cards the engine just refused as already_listed (a race) are left out of this call's plan; the stock query itself already uses the engine's definition of "listed".
  const stock = (await availableInventory(deps.db as unknown as Exec, house, count + 6 + (deps.exclude?.size ?? 0))).filter((c) => !deps.exclude?.has(c.mint));
  const picked: InventoryCard[] = [];
  if (deps.readinessMany) {
    // One chain request for the whole candidate list (and none for cards that passed lately). Short of cards with the chain down: throw, so the caller backs off.
    const { verdicts, error } = await deps.readinessMany(stock.map((c) => c.mint), house);
    for (const c of stock) if (picked.length < count && verdicts.get(c.mint)?.eligible) picked.push(c);
    if (picked.length < count && error) throw error;
  }
  // Without it: chain reads in parallel, only as many as still needed.
  let next = deps.readinessMany ? stock.length : 0;
  while (next < stock.length && picked.length < count) {
    const batch = stock.slice(next, next + (count - picked.length));
    next += batch.length;
    const ok = await Promise.all(batch.map(async (c) => (await deps.readiness(c.mint, house)).eligible));
    batch.forEach((c, n) => { if (ok[n]) picked.push(c); });
  }
  const n = rowsOf<{ n: number }>(await (deps.db as unknown as Exec).execute(sql`select count(*)::int as n from shows where is_house and kind = 'live'`))[0]?.n ?? 0;
  return { title: `House show #${n + 1}`, lots: picked.map(houseLotTerms) };
}

async function upsertBotProfile(db: Db, wallet: string): Promise<string> {
  const rows = rowsOf<{ id: string }>(await (db as unknown as Exec).execute(sql`
    insert into profiles (wallet_address, is_bot) values (${wallet}, true)
    on conflict (wallet_address) do update set is_bot = true returning id`));
  return rows[0].id;
}

async function upsertHouseSeller(db: Db, wallet: string): Promise<string> {
  const rows = rowsOf<{ id: string }>(await (db as unknown as Exec).execute(sql`
    insert into profiles (wallet_address, is_seller) values (${wallet}, true)
    on conflict (wallet_address) do update set is_seller = true returning id`));
  return rows[0].id;
}

/** Paddles 1..3 of a house show go to the house bidders, first, whether or not bots are switched on: the room labels exactly those numbers "House bidder". */
async function registerHousePaddles(deps: HouseDeps, showId: string, keys: Keypair[], hours = BOT_PADDLE_HOURS): Promise<void> {
  const validUntil = new Date(deps.now().getTime() + hours * 3_600_000);
  for (const key of keys) {
    const wallet = key.publicKey.toBase58();
    const profileId = await upsertBotProfile(deps.db, wallet);
    const authMessage = buildPaddleAuth({ cluster: 'devnet', show: showId, wallet, session: wallet, max: null, valid: validUntil.getTime() });
    const authSignature = toBase64(nacl.sign.detached(new TextEncoder().encode(authMessage), key.secretKey));
    await deps.auction.registerPaddle({ showId, profileId, sessionPubkey: wallet, maxBid: null, validUntil, authMessage, authSignature });
  }
}

async function restock(deps: HouseDeps, house: string, maxMint: number): Promise<number> {
  const free = (await availableInventory(deps.db as unknown as Exec, house, LOTS_PER_SHOW + 1)).length;
  let minted = 0;
  for (let i = 0; i < Math.min(maxMint, Math.max(0, LOTS_PER_SHOW - free)); i++) {
    if (!(await deps.mintReplica())) break;
    minted++;
  }
  return minted;
}

/** Runs a hook; whatever it throws is logged by message and replaced by `fallback`, so a hook can never fail the rollover. */
async function hookResult<T>(run: () => Promise<T>, fallback: T, name: string): Promise<T> {
  try { return await run(); } catch (e) { console.warn(`house rollover hook ${name} failed, continuing without it:`, (e as Error).message); return fallback; }
}

export async function ensureHouseShow(opts: { maxMint?: number; deps?: Partial<HouseDeps> } = {}): Promise<RolloverResult> {
  const deps = { ...(await defaultDeps()), ...opts.deps } as HouseDeps;
  const guard = guardFor(deps.db as unknown as Parameters<typeof guardFor>[0]);
  deps.backoff ??= guard.backoff;
  // A caller that brings its own single-card `readiness` (the seed script, tests) gets exactly that; otherwise the batched, cached reader.
  if (!deps.readinessMany && !opts.deps?.readiness && deps.readMany) { const read = deps.readMany; deps.readinessMany = (mints, seller) => guard.readiness.check(mints, (m) => read(m, seller)); }
  // A card the engine refuses as already_listed (a timed auction took it a moment ago, a race) is left out and the plan is made again, three tries at most;
  // still short after that is 'no_stock' for this read, not an error and not a backoff.
  deps.exclude = new Set();
  let result: RolloverResult;
  for (let attempt = 0; ; attempt++) {
    try { result = await ensureLiveHouseShow(deps, opts.maxMint ?? 0); break; } catch (e) {
      if (e instanceof ApiError && e.code === 'already_listed') {
        const m = (e.extra as { mint?: unknown } | undefined)?.mint;
        if (typeof m === 'string') deps.exclude.add(m);
        if (attempt >= 2) { result = 'no_stock'; break; }
        continue;
      }
      await deps.backoff.fail((e as Error).message).catch(() => undefined); // the next attempt waits (60 s, doubling, 10 minutes at most)
      throw e;
    }
  }
  if (result === 'unconfigured') return result;
  if (result === 'created') await deps.backoff.ok().catch(() => undefined);
  // The timed half never changes the answer and never fails the live room.
  try {
    if (await deps.timedOn()) await ensureTimedHouseShows(deps, opts.maxMint ?? 0);
  } catch (e) {
    console.warn('timed house auction skipped:', (e as Error).message);
    await deps.backoff.fail((e as Error).message).catch(() => undefined);
  }
  return result;
}

async function ensureLiveHouseShow(deps: HouseDeps, maxMint: number): Promise<RolloverResult> {
  const house = deps.houseWallet();
  const keys = deps.botKeys();
  if (!house || !keys) return 'unconfigured';
  const x = deps.db as unknown as Exec;

  // Lazy engine: let a due or running house show move first, so "ended" is true as soon as it is.
  for (const r of rowsOf<{ id: string }>(await x.execute(sql`select id from shows where is_house and status in ('live', 'scheduled') order by created_at desc limit 5`))) {
    await deps.auction.advanceShow(r.id);
  }
  if (await hasActiveHouseShow(x)) return 'none';
  if (!(await deps.backoff!.allowed())) return 'backoff'; // the last attempt failed lately: do not ask the chain again yet
  await deps.expireSettlements?.().catch((e: Error) => console.warn('house sales past their payment window not voided:', e.message)); // frees their cards now, not at the daily sweep

  return deps.db.transaction(async (tx): Promise<RolloverResult> => {
    const got = rowsOf<{ ok: boolean }>(await (tx as unknown as Exec).execute(sql`select pg_try_advisory_xact_lock(${ADVISORY_LOCK}) as ok`))[0]?.ok;
    if (!got) return 'busy';
    if (await hasActiveHouseShow(tx as unknown as Exec)) return 'none'; // someone created it between our check and our lock

    let plan = await planHouseShow(deps, house);
    if (plan.lots.length === 0 && maxMint > 0 && (await restock(deps, house, maxMint)) > 0) plan = await planHouseShow(deps, house);
    if (plan.lots.length === 0) return 'no_stock';

    const sellerProfileId = await upsertHouseSeller(deps.db, house);
    const order = await hookResult(() => deps.order.prepareHouseShow(), { orderMode: 'catalogue', startDelayS: 0 } as HouseShowOrder, 'prepareHouseShow');
    const startDelayS = Number.isFinite(order.startDelayS) ? Math.min(600, Math.max(0, Math.floor(order.startDelayS))) : 0;
    const show = await deps.auction.createShow({
      title: plan.title, format: 'auction', mode: 'auto', scheduledAt: new Date(deps.now().getTime() + startDelayS * 1000).toISOString(), rules: HOUSE_RULES,
      orderMode: order.orderMode === 'vrf' ? 'vrf' : 'catalogue', videoEnabled: deps.houseVideo(),
      lots: plan.lots.map((l) => ({ mint: l.mint, reserve: l.reserve.toString(), openingPrice: l.openingPrice.toString(), increment: l.increment.toString() })),
      sellerProfileId, readiness: Object.fromEntries(plan.lots.map((l) => [l.mint, { eligible: true, reasons: [] }])),
      assets: Object.fromEntries(plan.lots.map((l) => [l.mint, l.meta])), isHouse: true, cluster: 'devnet',
    });
    await registerHousePaddles(deps, show.show.id, keys);
    await hookResult(() => deps.order.afterHouseShowCreated(show.show.id), undefined, 'afterHouseShowCreated');
    if (maxMint > 0) await restock(deps, house, maxMint).catch((e) => console.warn('house restock failed', (e as Error).message));
    return 'created';
  });
}

/** The timed house auctions that count as running: live, due within 10 minutes, or ended with the lot still on the block. `leftS` is the time to the lot's close (null: no lot open yet). */
async function runningHouseTimed(x: Exec, nowMs: number): Promise<{ id: string; leftS: number | null }[]> {
  const res = await x.execute(sql`
    select s.id, (extract(epoch from l.closes_at) * 1000)::float8 as closes
    from shows s left join lots l on l.show_id = s.id and l.state = 'open'
    where s.is_house and s.kind = 'timed' and (
      s.status = 'live'
      or (s.status = 'scheduled' and s.scheduled_at is not null and s.scheduled_at <= now() + make_interval(mins => ${ACTIVE_WINDOW_MIN}))
      or (s.status = 'ended' and l.id is not null))`);
  return rowsOf<{ id: string; closes: number | null }>(res).map((r) => ({ id: r.id, leftS: r.closes === null ? null : Math.max(0, (Number(r.closes) - nowMs) / 1000) }));
}

/**
 * Up to TIMED_HOUSE_COUNT timed house auctions, one card each. Idempotent under concurrent callers the same way as the live room: one
 * transaction-scoped advisory lock (its own, so the live room never waits for this), the count repeated inside it, and a caller that does not
 * get the lock returns at once. At most one creation per iteration; a short stock simply means fewer auctions for now.
 */
async function ensureTimedHouseShows(deps: HouseDeps, maxMint: number): Promise<void> {
  const house = deps.houseWallet()!;
  const keys = deps.botKeys()!;
  const fullS = deps.timedDurationS();
  const cap = deps.timedCount();
  // A card the live room took a moment ago (its transaction was not committed yet when this one planned) is refused by createShow as already_listed:
  // plan again from the stock as it is now, a few times at most.
  for (let n = 0, tries = 0; n < cap && tries < cap + 3; tries++) {
    let made: boolean;
    try {
      made = await ensureOneTimed();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_listed') {
        const m = (e.extra as { mint?: unknown } | undefined)?.mint;
        if (typeof m === 'string') deps.exclude?.add(m);
        continue;
      }
      throw e;
    }
    if (!made) return;
    n++;
  }

  async function ensureOneTimed(): Promise<boolean> {
    return deps.db.transaction(async (tx): Promise<boolean> => {
      const got = rowsOf<{ ok: boolean }>(await (tx as unknown as Exec).execute(sql`select pg_try_advisory_xact_lock(${TIMED_ADVISORY_LOCK}) as ok`))[0]?.ok;
      if (!got) return false;
      const running = await runningHouseTimed(tx as unknown as Exec, deps.now().getTime());
      if (running.length >= cap) return false;
      if (!(await deps.backoff!.allowed())) return false;

      let plan = await planHouseShow(deps, house, 1);
      if (plan.lots.length === 0 && maxMint > 0 && (await restock(deps, house, maxMint)) > 0) plan = await planHouseShow(deps, house, 1);
      if (plan.lots.length === 0) return false;
      const lot = plan.lots[0];

      const durationS = nextTimedDurationS(fullS, timedMinDurationS(), running.length === 0 ? null : Math.max(...running.map((r) => r.leftS ?? fullS)));
      const sellerProfileId = await upsertHouseSeller(deps.db, house);
      const count = rowsOf<{ n: number }>(await (tx as unknown as Exec).execute(sql`select count(*)::int as n from shows where is_house and kind = 'timed'`))[0]?.n ?? 0;
      const show = await deps.auction.createShow({
        title: `Timed house lot #${count + 1}`, format: 'auction', mode: 'auto', kind: 'timed', scheduledAt: deps.now().toISOString(),
        rules: { lotDurationS: durationS, settlementWindowS: TIMED_HOUSE_SETTLEMENT_S },
        lots: [{ mint: lot.mint, reserve: lot.reserve.toString(), openingPrice: lot.openingPrice.toString(), increment: lot.increment.toString() }],
        sellerProfileId, readiness: { [lot.mint]: { eligible: true, reasons: [] } }, assets: { [lot.mint]: lot.meta }, isHouse: true, cluster: 'devnet',
      });
      // The house bidders must outlive the lot, soft-close extensions included.
      const r = resolveRules({ lotDurationS: durationS }, undefined, 'timed');
      await registerHousePaddles(deps, show.show.id, keys, Math.max(BOT_PADDLE_HOURS, Math.ceil((r.lotDurationS + r.maxExtensionS) / 3600) + 1));
      return true;
    });
  }
}

/** Never throws: the schedule read and the sweep must not fail because the house room could not be rolled over. */
export async function keepHouseShowAlive(opts: { maxMint?: number; deps?: Partial<HouseDeps>; deadlineMs?: number } = {}): Promise<RolloverResult> {
  const guard = opts.deps?.backoff ?? (await guardForDefaultDb(opts.deps?.db));
  const attempt = ensureHouseShow({ maxMint: opts.maxMint ?? 1, ...opts }).catch((e: unknown) => {
    console.error('house rollover failed', (e as Error).message);
    return 'none' as RolloverResult;
  });
  // A read never waits longer than the deadline for it: the attempt carries on, and until it reports back the wait counts as a failure.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<RolloverResult>((resolve) => {
    timer = setTimeout(() => { void guard?.fail('rollover took longer than the read may wait').catch(() => undefined); resolve('none'); }, opts.deadlineMs ?? ROLLOVER_DEADLINE_MS);
  });
  try { return await Promise.race([attempt, late]); } finally { clearTimeout(timer); }
}

async function guardForDefaultDb(db?: Db): Promise<RolloverBackoff | undefined> {
  try { return guardFor((db ?? (await import('@/db')).db) as unknown as Parameters<typeof guardFor>[0]).backoff; } catch { return undefined; }
}

// ---- the production wiring, loaded on first use -------------------------------------------------------------------------------

async function defaultDeps(): Promise<HouseDeps> {
  const [{ db }, auction, keys, cfg] = await Promise.all([import('@/db'), import('@/server/auction/service'), import('@/lib/chain/keys'), import('@/lib/chain/config')]);
  const devnetOnly = () => { try { return cfg.resolveCluster() === 'devnet'; } catch { return false; } };
  return {
    db,
    auction,
    houseWallet: () => (devnetOnly() ? keys.houseSeller()?.publicKey.toBase58() ?? null : null),
    botKeys: () => { try { return deriveBotKeys(keys.settlementAuthority()); } catch { return null; } },
    readiness: async (mint, seller) => {
      const a = await import('@/lib/chain/asset');
      return a.evaluateAssetReadiness(await a.readAsset(mint, 'devnet'), { seller });
    },
    readMany: async (mints, seller) => {
      const a = await import('@/lib/chain/asset');
      return (await a.readAssets(mints, 'devnet')).map((info) => a.evaluateAssetReadiness(info, { seller }));
    },
    mintReplica: () => mintOneReplica(db),
    expireSettlements: async () => {
      const due = await db.execute(sql`select 1 as one from settlements st join lots l on l.id = st.lot_id join shows s on s.id = l.show_id where s.is_house and st.status in ('awaiting_payment', 'awaiting_seller') and st.due_at <= now() limit 1`);
      if (rowsOf(due).length > 0) await (await import('@/app/api/auctions/_shared/deps')).settlementService().sweep();
    },
    now: () => new Date(),
    order: await import('@/server/vrf/rollover-hook'),
    houseVideo: () => process.env.HOUSE_VIDEO_ENABLED === 'true',
    timedOn: async () => (await import('@/lib/features')).featureOn('TIMED'),
    timedDurationS: () => houseTimedDurationS(),
    timedCount: () => houseTimedCount(),
  };
}

/** Copies the least-duplicated replica template in the house stock through the mint helper (lib/chain/replica-mint.ts). Below 0.5 SOL on the settlement authority nothing is minted. */
export async function mintOneReplica(db: Db): Promise<boolean> {
  const [{ settlementAuthority, houseSeller, faucetMintAuthority }, cfg, lib, web3] = await Promise.all([
    import('@/lib/chain/keys'), import('@/lib/chain/config'), import('@/lib/chain/replica-mint'), import('@solana/web3.js'),
  ]);
  const house = houseSeller();
  const fee = cfg.feeWalletAddress();
  if (!house || !fee || cfg.resolveCluster() !== 'devnet') return false;
  const sa = settlementAuthority();
  const io = lib.connectionIo(new web3.Connection(cfg.rpcUrlsFor('devnet')[0], 'confirmed'));
  if ((await io.getBalance(sa.publicKey)) < MIN_SA_LAMPORTS) {
    console.warn('house restock skipped: the settlement authority holds less than 0.5 SOL');
    return false;
  }
  const { devnetAssets } = await import('@/db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(devnetAssets).where(eq(devnetAssets.ownerWallet, house.publicKey.toBase58()));
  const copies = new Map<string, number>();
  const attrs = new Map(rows.map((r) => [r.mint, attributesRecord(r.attributes)]));
  for (const r of rows) { const k = String(attrs.get(r.mint)?.replica_of ?? ''); if (k) copies.set(k, (copies.get(k) ?? 0) + 1); }
  const template = rows.filter((r) => attrs.get(r.mint)?.replica_of).sort((a, b) => (copies.get(String(attrs.get(a.mint)!.replica_of)) ?? 0) - (copies.get(String(attrs.get(b.mint)!.replica_of)) ?? 0))[0];
  if (!template) return false;
  const a = attrs.get(template.mint)!;
  const s = (v: unknown) => (v === undefined || v === null ? null : String(v));
  const insured = Number(a.insured_value_usd);
  const keysAll = { sa, house, faucet: faucetMintAuthority(), feeWallet: new web3.PublicKey(fee) };
  const r = await lib.mintReplica(io, keysAll, lib.addressesFor(sa).collection, {
    replicaOf: String(a.replica_of), name: template.name.replace(/ \(devnet replica\)$/, ''), imageUrl: template.imageUrl, grade: s(a.grade), gradingCompany: s(a.grading_company), gradingId: s(a.grading_id),
    vault: s(a.vault), set: s(a.set), category: s(a.category), insuredValueUsd: Number.isFinite(insured) ? insured : null,
  });
  await db.insert(devnetAssets).values({ mint: r.mint.toBase58(), ownerWallet: house.publicKey.toBase58(), name: r.name, imageUrl: template.imageUrl, attributes: r.attributes }).onConflictDoNothing();
  return true;
}
