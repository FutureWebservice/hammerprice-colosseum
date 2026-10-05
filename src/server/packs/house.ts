/**
 * The platform's own test pack on devnet (A10.3: "devnet house packs use test cards"). The pool is the replica cards the house wallet owns
 * (devnet_assets, the same stock the house room sells), the operator is the house wallet, and the server signs that one leg of the payment
 * (the platform's own test cards, labelled as such). A visitor sees a live pack at any hour without anybody operating it; it is LAZY like the
 * house room: a read of the pack list and the daily sweep call `keepHousePackAlive`.
 *
 *   active   = a live house pack on this network
 *   rollover = no live house pack: take free house stock (cards in no show and in no pack pool), check every card on chain, commit a new pack
 *              (tiers by the house value of the card, odds published), under an advisory lock so two callers never create two
 *
 * Devnet only. On any other cluster, with no house key or no randomness key, it does nothing: a mainnet pack always has a real operator.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PackCreateRequest } from '@/contracts';
import type { db as DbInstance } from '@/db';
import { packDefinitions, profiles } from '@/db/schema';
import { availableInventory, houseValueUsd, type InventoryCard } from '@/server/house/inventory';
import type { PackService } from './service';

type Db = typeof DbInstance;
export type HousePackResult = 'created' | 'none' | 'busy' | 'unconfigured' | 'no_stock';

export const HOUSE_PACK_MIN_CARDS = 4;
export const HOUSE_PACK_MAX_CARDS = 8;
/**
 * A14: the house may run a chance pack ONLY as the devnet demo (test USDC, platform-owned test cards, labelled DEMO). On any other network the platform
 * must not receive a customer's money for a pack, so a house pack there is refused at create, publish, open and every step that would take a payment.
 * The one place that rule is spelled (the pack code never names a network).
 */
export const houseDemoAllowed = (cluster: string): boolean => cluster === 'devnet';

/** Test USDC. The price is a house convention for test cards, not a market price. */
export const HOUSE_PACK_PRICE = '5000000';
const ADVISORY_LOCK = 7_201_882; // arbitrary, unique to the house pack rollover

const TIERS = [
  { tier: 'legend', label: { de: 'Legendär', en: 'Legendary' }, bps: 1000, min: 100 },
  { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 2500, min: 50 },
  { tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 6500, min: 0 },
] as const;

export interface HousePackDeps {
  db: Db;
  service: PackService;
  /** The house wallet, or null when the house pack is not available here (no key, not devnet). */
  houseWallet(): string | null;
  /** Owner is the house, not frozen, plain transfer allowed: read from chain. */
  ready(mint: string, owner: string): Promise<boolean>;
  /** Mint ONE replica into the house stock; false when it must not. Called at most `maxMint` times per run. */
  mintReplica(): Promise<boolean>;
}

/**
 * The AUTOMATIC test pack is a devnet convention (test cards from the replica stock); on every other network nothing creates a house pack, and
 * `houseDemoAllowed` (below) makes the service refuse one. There is no "mainnet house pack" provisioning (A14).
 */
export const houseOperatorFor = <K>(cluster: string, key: K | null): K | null => (houseDemoAllowed(cluster) ? key : null);

const tierOf = (valueUsd: number) => TIERS.find((t) => valueUsd >= t.min)!.tier;

/** The pack a set of house cards makes: tiers with at least one card keep their weight, the weights are scaled to 10000. Pure. */
export function planHousePack(cards: InventoryCard[]): PackCreateRequest {
  const rows = cards.map((c) => ({ c, value: houseValueUsd(c.attributes) }));
  const present = TIERS.filter((t) => rows.some((r) => tierOf(r.value) === t.tier));
  const total = present.reduce((n, t) => n + t.bps, 0);
  const odds = present.map((t) => ({ tier: t.tier, label: t.label, bps: Math.floor((t.bps * 10_000) / total) }));
  odds[odds.length - 1]!.bps += 10_000 - odds.reduce((n, o) => n + o.bps, 0); // the rest goes to the last (likeliest) tier so the odds add up exactly
  const str = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
  return PackCreateRequest.parse({
    name: { de: 'Hammerprice Starter-Pack (Testkarten)', en: 'Hammerprice Starter Pack (test cards)' },
    description: {
      de: 'Das Haus zieht aus seinen eigenen Devnet-Testkarten. Die Karten sind Replikate zu Testzwecken.',
      en: 'The house draws from its own devnet test cards. The cards are replicas for testing.',
    },
    mode: 'chance',
    price: HOUSE_PACK_PRICE,
    odds,
    perWalletDailyCap: 5,
    cards: rows.map(({ c, value }) => ({
      asset: c.mint, tier: tierOf(value), name: c.name.slice(0, 120), ...(c.imageUrl && c.imageUrl.startsWith('https://') ? { imageUrl: c.imageUrl } : {}), listedValue: (BigInt(value) * 1_000_000n).toString(),
      attributes: Object.fromEntries(Object.entries({ grade: str(c.attributes.grade), grading_company: str(c.attributes.grading_company), set: str(c.attributes.set) }).filter(([, v]) => v !== undefined)),
    })),
  });
}

async function upsertHouseProfile(db: Db, wallet: string): Promise<string> {
  const [row] = await db.insert(profiles).values({ walletAddress: wallet, isSeller: true }).onConflictDoUpdate({ target: profiles.walletAddress, set: { isSeller: true } }).returning({ id: profiles.id });
  return row!.id;
}

export async function ensureHousePack(deps: HousePackDeps, opts: { maxMint?: number } = {}): Promise<HousePackResult> {
  const house = deps.houseWallet();
  if (!house) return 'unconfigured';
  const { db } = deps;
  const live = async (x: Pick<Db, 'select'>) => (await x.select({ id: packDefinitions.id }).from(packDefinitions).where(and(eq(packDefinitions.isHouse, true), eq(packDefinitions.status, 'live'))).limit(1)).length > 0;
  if (await live(db)) return 'none';
  // A paused or sold-out house pack is over: its cards that are still unsold go back to the stock.
  await db.update(packDefinitions).set({ status: 'closed', updatedAt: new Date() }).where(and(eq(packDefinitions.isHouse, true), inArray(packDefinitions.status, ['paused', 'sold_out'])));

  const free = await availableInventory(db as unknown as Parameters<typeof availableInventory>[0], house, HOUSE_PACK_MAX_CARDS + 4);
  const ok: InventoryCard[] = [];
  for (let i = 0; i < free.length && ok.length < HOUSE_PACK_MAX_CARDS; i += 4) {
    const batch = free.slice(i, i + 4);
    const done = await Promise.all(batch.map((c) => deps.ready(c.mint, house)));
    batch.forEach((c, n) => { if (done[n] && ok.length < HOUSE_PACK_MAX_CARDS) ok.push(c); });
  }
  if (ok.length < HOUSE_PACK_MIN_CARDS) {
    for (let i = 0; i < (opts.maxMint ?? 0); i++) if (!(await deps.mintReplica())) break; // the next call finds the new stock
    return 'no_stock';
  }
  const profileId = await upsertHouseProfile(db, house);
  const made = await deps.service.createHouse({ id: profileId, wallet: house }, planHousePack(ok), async (tx) => {
    const got = ((await (tx as unknown as { execute(q: ReturnType<typeof sql>): Promise<{ rows: { ok: boolean }[] }> }).execute(sql`select pg_try_advisory_xact_lock(${ADVISORY_LOCK}) as ok`)).rows)[0]?.ok;
    return !!got && !(await live(tx as unknown as Pick<Db, 'select'>));
  });
  return made ? 'created' : 'busy';
}

/** Never throws: the pack list and the sweep must not fail because the house pack could not be rolled over. */
export async function keepHousePackAlive(opts: { maxMint?: number; deps?: Partial<HousePackDeps> } = {}): Promise<HousePackResult> {
  try {
    const base = await defaultDeps();
    if (!base && !opts.deps?.houseWallet) return 'unconfigured';
    return await ensureHousePack({ ...base, ...opts.deps } as HousePackDeps, { maxMint: opts.maxMint ?? 1 });
  } catch (e) {
    console.error('house pack rollover failed', (e as Error).message);
    return 'none';
  }
}

async function defaultDeps(): Promise<HousePackDeps | null> {
  const [{ db }, keys, cfg, assets, { getPackService }, { loadVrfKey }, rollover] = await Promise.all([
    import('@/db'), import('@/lib/chain/keys'), import('@/lib/chain/config'), import('@/lib/chain/asset'), import('./instance'), import('@/lib/vrf/key'), import('@/server/house/rollover'),
  ]);
  let devnet = false;
  try { devnet = cfg.resolveCluster() === 'devnet'; } catch { /* a conflicting environment is reported elsewhere */ }
  if (!devnet || !loadVrfKey()) return null;
  const house = keys.houseSeller();
  if (!house) return null;
  return {
    db,
    service: getPackService(),
    houseWallet: () => house.publicKey.toBase58(),
    ready: async (mint, owner) => assets.evaluateAssetReadiness(await assets.readAsset(mint, 'devnet'), { seller: owner }).eligible,
    mintReplica: () => rollover.mintOneReplica(db),
  };
}
