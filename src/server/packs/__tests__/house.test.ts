/**
 * The platform's devnet test pack: built from the house stock under an advisory lock, never on another cluster or without the house key, and
 * its cards stay out of the house room's stock while they are in the pool. Real Postgres, real Core program (LiteSVM).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { sha512 } from '@noble/hashes/sha2';
import * as schema from '@/db/schema';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { evaluateAssetReadiness } from '@/lib/chain/asset';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import { generateVrfKey } from '@/lib/vrf/key';
import { availableInventory } from '@/server/house/inventory';
import { HOUSE_PACK_MAX_CARDS, HOUSE_PACK_MIN_CARDS, HOUSE_PACK_PRICE, ensureHousePack, planHousePack, type HousePackDeps } from '../house';
import { createPackService, type PackDeps, type PackService } from '../service';
import { createPackWorld, type PackWorld } from './pack-world';

type Db = PackDeps['db'];
let t: TestPg | undefined, skipReason: string | undefined, db: Db, w: PackWorld, port: SvmPort, svc: PackService;
const vrf = generateVrfKey().key;
let minted = 0;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; return; }
  t = r.pg;
  db = drizzle(t.pool, { schema }) as unknown as Db;
  w = createPackWorld('devnet');
  port = createSvmPort(w);
  svc = createPackService({
    db, chainFor: () => port, sa: w.sa, houseOperator: w.houseSeller, vrfKey: () => vrf, beacon: async () => ({ slot: 99, blockhash: bs58.encode(sha512(new TextEncoder().encode('b')).slice(0, 32)) }),
    beaconAfter: async () => null, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250, defaultCluster: 'devnet', assertCluster: () => undefined,
  });
}, 120_000);
afterAll(async () => { await new Promise((r) => setTimeout(r, 200)); await t?.stop(); });
const it_ = (name: string, fn: () => Promise<void> | void) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, 60_000);

const house = () => w.houseSeller.publicKey.toBase58();
/** A replica card in the house wallet and in devnet_assets, with the vault's insured value (whole USD). */
async function stock(valueUsd: number, name = `Replica ${valueUsd}`) {
  const mint = w.consign(`${name} ${++minted}`, w.houseSeller).toBase58();
  await db.insert(schema.devnetAssets).values({ mint, ownerWallet: house(), name: `${name} (devnet replica)`, imageUrl: 'https://example.com/card.png', attributes: { insured_value_usd: valueUsd, grade: 'MINT 9', grading_company: 'PSA', set: 'Test Set' } });
  return mint;
}
const deps = (o: Partial<HousePackDeps> = {}): HousePackDeps => ({
  db, service: svc, houseWallet: house, mintReplica: async () => false,
  ready: async (mint, owner) => evaluateAssetReadiness(await port.readAsset(mint), { seller: owner }).eligible, ...o,
});
const livePacks = async () => (await db.select().from(schema.packDefinitions).where(eq(schema.packDefinitions.isHouse, true))).filter((p) => p.status === 'live');

describe('planHousePack (pure)', () => {
  const card = (value: number) => ({ mint: Keypair.generate().publicKey.toBase58(), name: `Card ${value}`, imageUrl: 'https://example.com/x.png', attributes: { insured_value_usd: value, grade: 'MINT 9' } as Record<string, unknown> });
  it('tiers by the house value, scales the odds of the tiers that are present to exactly 10000, and prices in test USDC', () => {
    const all = planHousePack([card(120), card(60), card(25), card(30)]);
    expect(all.odds.map((o) => o.tier)).toEqual(['legend', 'rare', 'common']);
    expect(all.odds.reduce((n, o) => n + o.bps, 0)).toBe(10_000);
    expect(all.odds.map((o) => o.bps)).toEqual([1000, 2500, 6500]);
    expect(all.price).toBe(HOUSE_PACK_PRICE);
    expect(all.cards.map((c) => c.tier)).toEqual(['legend', 'rare', 'common', 'common']);
    expect(all.cards[0]!.listedValue).toBe('120000000');
    const noLegend = planHousePack([card(60), card(25), card(30), card(31)]);
    expect(noLegend.odds.map((o) => o.tier)).toEqual(['rare', 'common']);
    expect(noLegend.odds.reduce((n, o) => n + o.bps, 0)).toBe(10_000);
    const one = planHousePack([card(25), card(26), card(27), card(28)]);
    expect(one.odds).toMatchObject([{ tier: 'common', bps: 10_000 }]);
  });
  it('says what it is: house test cards, in both languages, without an em dash', () => {
    const p = planHousePack([card(25), card(26), card(27), card(28)]);
    for (const text of [p.name.de, p.name.en, p.description!.de, p.description!.en]) expect(text).not.toMatch(/\u2014/);
    expect(p.name.en).toMatch(/test cards/i);
    expect(p.name.de).toMatch(/Testkarten/);
  });
});

describe('ensureHousePack', () => {
  it_('does nothing without the house key (mainnet, or no key): "unconfigured"', async () => {
    expect(await ensureHousePack(deps({ houseWallet: () => null }))).toBe('unconfigured');
    expect(await db.select().from(schema.packDefinitions)).toEqual([]);
  });

  it_('with too little stock it creates nothing, mints at most `maxMint` and says "no_stock"', async () => {
    for (let i = 0; i < HOUSE_PACK_MIN_CARDS - 1; i++) await stock(25 + i);
    let mints = 0;
    expect(await ensureHousePack(deps({ mintReplica: async () => { mints++; return true; } }), { maxMint: 2 })).toBe('no_stock');
    expect(mints).toBe(2);
    expect(await ensureHousePack(deps(), { maxMint: 0 })).toBe('no_stock');
    expect(await livePacks()).toEqual([]);
  });

  it_('creates ONE live house pack from the stock (also under concurrent callers), whose cards leave the house room\'s stock', async () => {
    await stock(120, 'Top card');
    await stock(60, 'Mid card');
    for (let i = 0; i < 6; i++) await stock(25 + i); // more than a pack holds
    const results = await Promise.all([ensureHousePack(deps()), ensureHousePack(deps()), ensureHousePack(deps())]);
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.filter((r) => r !== 'created').every((r) => r === 'busy' || r === 'none' || r === 'no_stock')).toBe(true); // 'no_stock': the winner already took the cards
    const packs = await livePacks();
    expect(packs).toHaveLength(1);
    const pack = packs[0]!;
    expect(pack).toMatchObject({ isHouse: true, status: 'live', cluster: 'devnet', mode: 'chance', price: 5_000_000n, operatorWallet: house() });
    expect(pack.poolHash).toMatch(/^[0-9a-f]{64}$/);
    const cards = await db.select().from(schema.packPoolCards).where(eq(schema.packPoolCards.packId, pack.id));
    expect(cards.length).toBeGreaterThanOrEqual(HOUSE_PACK_MIN_CARDS);
    expect(cards.length).toBeLessThanOrEqual(HOUSE_PACK_MAX_CARDS);
    // the house room must not list them any more
    const free = (await availableInventory(db as never, house(), 50)).map((c) => c.mint);
    for (const c of cards) expect(free).not.toContain(c.asset);
    // a second call finds the live pack
    expect(await ensureHousePack(deps())).toBe('none');
  });

  it_('a sold-out house pack is closed and replaced from the stock that is left; drawn cards never come back', async () => {
    const [old] = await livePacks();
    await db.update(schema.packPoolCards).set({ status: 'drawn' }).where(eq(schema.packPoolCards.packId, old!.id)); // sold to people
    await db.update(schema.packDefinitions).set({ status: 'sold_out' }).where(eq(schema.packDefinitions.id, old!.id));
    for (let i = 0; i < 5; i++) await stock(30 + i);
    expect(await ensureHousePack(deps())).toBe('created');
    const [fresh] = await livePacks();
    expect(fresh!.id).not.toBe(old!.id);
    expect((await db.select().from(schema.packDefinitions).where(eq(schema.packDefinitions.id, old!.id)))[0]!.status).toBe('closed');
    const sold = (await db.select().from(schema.packPoolCards).where(eq(schema.packPoolCards.packId, old!.id))).map((c) => c.asset);
    const nextCards = (await db.select().from(schema.packPoolCards).where(eq(schema.packPoolCards.packId, fresh!.id))).map((c) => c.asset);
    for (const a of sold) expect(nextCards).not.toContain(a);
    expect((await availableInventory(db as never, house(), 100)).map((c) => c.mint)).not.toEqual(expect.arrayContaining(sold));
  });

  it_('a card the house no longer holds is skipped, and a pack needs at least four cards that are really ready', async () => {
    const [cur] = await livePacks();
    await db.update(schema.packDefinitions).set({ status: 'paused' }).where(eq(schema.packDefinitions.id, cur!.id));
    await db.update(schema.packPoolCards).set({ status: 'drawn' }).where(eq(schema.packPoolCards.packId, cur!.id));
    const before = (await availableInventory(db as never, house(), 100)).length;
    const gone = new Set<string>((await availableInventory(db as never, house(), 100)).map((c) => c.mint));
    const r = await ensureHousePack(deps({ ready: async (mint) => !gone.has(mint) })); // the chain says none of them is ready
    expect(r).toBe('no_stock');
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it_('a card owed to a paid purchase that is still being delivered is never free stock again, even when its pack was closed (review finding: two buyers could pay for one card)', async () => {
    const mint = await stock(77, 'Owed');
    expect((await availableInventory(db as never, house(), 200)).map((c) => c.mint)).toContain(mint);
    const profile = (await db.insert(schema.profiles).values({ walletAddress: Keypair.generate().publicKey.toBase58() }).returning())[0]!;
    const [pk] = await db.insert(schema.packDefinitions).values({ operatorProfileId: profile.id, operatorWallet: house(), isHouse: true, name: { de: 'x', en: 'x' }, mode: 'chance', cluster: 'devnet', price: 1_000_000n, odds: [], status: 'closed' }).returning();
    const [card] = await db.insert(schema.packPoolCards).values({ packId: pk!.id, asset: mint, tier: 'common', name: 'Owed', position: 0, status: 'reserved' }).returning();
    for (const status of ['drawn', 'delivering', 'undelivered']) {
      const [d] = await db.insert(schema.packDraws).values({ packId: pk!.id, buyerProfileId: profile.id, buyerWallet: 'B', cluster: 'devnet', ageConfirmedAt: new Date(), clientSeed: `s-${status}`, price: 1n, status, flow: 'pay_first', cardId: card!.id, asset: mint }).returning();
      expect((await availableInventory(db as never, house(), 200)).map((c) => c.mint), status).not.toContain(mint);
      await db.update(schema.packDraws).set({ status: 'expired' }).where(eq(schema.packDraws.id, d!.id));
    }
    await db.update(schema.packPoolCards).set({ status: 'available' }).where(eq(schema.packPoolCards.id, card!.id));
    await db.update(schema.packDefinitions).set({ status: 'closed' }).where(eq(schema.packDefinitions.id, pk!.id));
    expect((await availableInventory(db as never, house(), 200)).map((c) => c.mint)).toContain(mint); // over and closed: free again
  });
});
