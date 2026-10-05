/**
 * The house room's lazy rollover on a real Postgres 18 with the real engine: only the chain (asset readiness, minting) is faked.
 * What must hold: exactly one house show however many callers race, a card is listed only while it is the house's to list, stock
 * rotates least-recently-listed first, and minting is fenced (stock below 6, SOL floor, per-call cap, devnet only, never a loop).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ShowDetail } from '@/contracts';
import { startEnv, USDC, type Env } from '@/server/auction/__tests__/harness';
import type { HouseDeps } from '../rollover';
import { noBackoff } from '../rollover-guard';

let env: Env | undefined; let skipReason: string | undefined;
let R: typeof import('../rollover');
let I: typeof import('../inventory');

const house = Keypair.generate();
const sa = Keypair.generate();
const unreadable = new Set<string>(); // mints the fake chain says cannot be consigned
let minted = 0;

const GRADES = ['PRISTINE 10', 'MINT 9', 'NM-MT 8', 'GEM MT 10', 'MINT 9', 'NM/MINT 8', 'PRISTINE 10', 'MINT 9'];

async function addCard(e: Env, n: number, over: { owner?: string; attributes?: Record<string, unknown> } = {}) {
  const mint = Keypair.generate().publicKey.toBase58();
  await e.pool.query(
    `insert into devnet_assets (mint, owner_wallet, name, image_url, attributes, minted_at) values ($1,$2,$3,$4,$5::jsonb, now() - make_interval(secs => $6))`,
    [mint, over.owner ?? house.publicKey.toBase58(), `Card ${n} (devnet replica)`, `https://img.example/${n}.png`, JSON.stringify(over.attributes ?? { replica: 'true', replica_of: `real${n}`, grade: GRADES[n % GRADES.length], grading_company: 'PSA', set: `Set ${n}`, grading_id: String(1000 + n) }), 1000 - n],
  );
  return mint;
}
const stock = async (e: Env, n: number) => { const m: string[] = []; for (let i = 0; i < n; i++) m.push(await addCard(e, i)); return m; };

const deps = (e: Env, over: Partial<HouseDeps> = {}): Partial<HouseDeps> => ({
  backoff: noBackoff, // these tests make the chain fail on purpose; the backoff has its own tests
  houseWallet: () => house.publicKey.toBase58(),
  botKeys: () => R.deriveBotKeys(sa),
  readiness: async (mint) => (unreadable.has(mint) ? { eligible: false, reasons: ['frozen'] } : { eligible: true, reasons: [] }),
  mintReplica: async () => { minted++; await addCard(e, 100 + minted); return true; },
  ...over,
});

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  R = await import('../rollover');
  I = await import('../inventory');
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  minted = 0; unreadable.clear();
  await env.pool.query(`delete from paddles; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows; delete from devnet_assets; delete from profiles where is_bot or wallet_address = '${house.publicKey.toBase58()}'`);
});

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const houseShows = async (e: Env) => (await e.pool.query(`select id, status, scheduled_at from shows where is_house order by created_at`)).rows as { id: string; status: string }[];

describe('the next house show', () => {
  t('is created from stock: devnet, auto, on-chain settlement, 90 s lots, six lots with reserve = opening price, and the three house paddles first', async (e) => {
    await stock(e, 8);
    const res = await R.ensureHouseShow({ deps: deps(e) });
    expect(res).toBe('created');
    const [show] = (await e.pool.query(`select * from shows where is_house`)).rows;
    expect(show).toMatchObject({ is_house: true, mode: 'auto', settlement_mode: 'onchain', cluster: 'devnet', status: 'scheduled', title: 'House show #1', rules: { lotDurationS: 90, gapS: 10 } });
    expect(new Date(show.scheduled_at).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await e.pool.query(`select wallet_address, is_seller from profiles where id = $1`, [show.seller_id])).rows[0]).toEqual({ wallet_address: house.publicKey.toBase58(), is_seller: true });

    const catalogue = ShowDetail.parse(await e.svc.getCatalogue(show.id));
    expect(catalogue.lots).toHaveLength(6);
    for (const l of catalogue.lots) {
      expect(l).toMatchObject({ consignStatus: 'ready', nftStandard: 'core' });
      expect(l.reserve).toBe(l.openingPrice); // so any bid above the house bidders wins
      expect(l.name).toMatch(/\(devnet replica\)$/); // labelled as what it is
      expect(l.imageUrl).toMatch(/^https:\/\/img\.example\//);
      expect(BigInt(l.openingPrice)).toBeGreaterThan(0n);
      expect(l.insuredValue).not.toBeNull();
    }
    const ten = catalogue.lots.find((l) => l.grade === 'PRISTINE 10')!; // a 10 is a 120 USDC house estimate: opening 60, increment 6
    expect([ten.openingPrice, ten.increment, ten.insuredValue]).toEqual([String(60n * USDC), String(6n * USDC), String(120n * USDC)]);
    const nine = catalogue.lots.find((l) => l.grade === 'MINT 9')!;
    expect([nine.openingPrice, nine.increment]).toEqual([String(30n * USDC), String(3n * USDC)]);

    const pads = (await e.pool.query(`select pd.number, pd.session_pubkey, p.wallet_address, p.is_bot from paddles pd join profiles p on p.id = pd.profile_id where pd.show_id = $1 order by pd.number`, [show.id])).rows;
    expect(pads.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(pads.every((p) => p.is_bot && p.session_pubkey === p.wallet_address)).toBe(true);
    const validity = (await e.pool.query(`select min(valid_until) v from paddles where show_id = $1`, [show.id])).rows[0].v as Date;
    expect(validity.getTime() - Date.now()).toBeGreaterThan(12 * 3_600_000); // an idle house show must not outlive its bidders
    expect(pads.map((p) => p.wallet_address)).toEqual(R.deriveBotKeys(sa).map((k) => k.publicKey.toBase58()));
  });

  t('is created exactly once however many callers race (advisory lock + the check repeated inside it)', async (e) => {
    await stock(e, 8);
    const results = await Promise.all(Array.from({ length: 20 }, () => R.ensureHouseShow({ deps: deps(e) })));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(results.every((r) => r === 'created' || r === 'none' || r === 'busy')).toBe(true);
    expect(await houseShows(e)).toHaveLength(1);
    expect((await e.pool.query(`select count(*)::int c from lots l join shows s on s.id = l.show_id where s.is_house`)).rows[0].c).toBe(6);
    expect((await e.pool.query(`select count(*)::int c from paddles`)).rows[0].c).toBe(3);
    // and a second wave, once it exists, creates nothing
    const again = await Promise.all(Array.from({ length: 10 }, () => R.keepHouseShowAlive({ deps: deps(e) })));
    expect(again.every((r) => r === 'none' || r === 'busy')).toBe(true);
    expect(await houseShows(e)).toHaveLength(1);
  }, 120_000);

  t('is not needed while one is live, due within 10 minutes, or still has a lot on the block; it is when none of that holds', async (e) => {
    await stock(e, 8);
    const seller = await e.profile({ wallet: house.publicKey.toBase58() });
    const mk = (status: 'scheduled' | 'live' | 'ended', scheduledAt: Date | null, lots: Parameters<Env['show']>[0]['lots']) => e.show({ sellerId: seller.id, status, scheduledAt, isHouse: true, lots });
    const clear = () => e.pool.query(`delete from lots where show_id in (select id from shows where is_house); delete from shows where is_house`);
    const none = async () => expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('none');

    await mk('live', null, [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 30_000) }]);
    await none(); await clear();
    await mk('scheduled', new Date(Date.now() + 5 * 60_000), [{ state: 'catalogued' }]);
    await none(); await clear();
    await mk('ended', null, [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 30_000) }]); // ended, but its last lot is still running
    await none(); await clear();

    await mk('scheduled', new Date(Date.now() + 30 * 60_000), [{ state: 'catalogued' }]); // too far away to count
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('created');
    await clear();
    await mk('ended', null, [{ state: 'passed', closedAt: new Date() }]);
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('created');
  });

  t('moves a running house show first (lazy engine): one whose lots are all done ends, and the next one starts in the same call', async (e) => {
    await stock(e, 8);
    const seller = await e.profile({ wallet: house.publicKey.toBase58() });
    const old = await e.show({ sellerId: seller.id, status: 'live', isHouse: true, rules: { gapS: 6 }, lots: [{ state: 'passed', closedAt: new Date(Date.now() - 60_000) }] });
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('created');
    expect((await e.pool.query(`select status from shows where id = $1`, [old.id])).rows[0].status).toBe('ended');
    expect(await houseShows(e)).toHaveLength(2);
  });

  t('is not offered where it does not exist: no house key, or no bidder keys, means unconfigured and nothing written', async (e) => {
    await stock(e, 8);
    expect(await R.ensureHouseShow({ deps: deps(e, { houseWallet: () => null }) })).toBe('unconfigured');
    expect(await R.ensureHouseShow({ deps: deps(e, { botKeys: () => null }) })).toBe('unconfigured');
    expect(await houseShows(e)).toHaveLength(0);
  });

  t('keepHouseShowAlive never throws: a chain that cannot answer leaves the read alive', async (e) => {
    await stock(e, 8);
    const down = deps(e, { readiness: async () => { throw new Error('rpc down'); } });
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await R.keepHouseShowAlive({ deps: down })).toBe('none');
    quiet.mockRestore();
    expect(await houseShows(e)).toHaveLength(0);
  });
});

describe('which cards may be listed', () => {
  t('only Core replicas the house owns, never one in a show that has not ended', async (e) => {
    const mine = await stock(e, 6);
    const foreign = await addCard(e, 50, { owner: Keypair.generate().publicKey.toBase58() });
    await R.ensureHouseShow({ deps: deps(e) });
    const listed = (await e.pool.query(`select mint_address from lots`)).rows.map((r) => r.mint_address);
    expect(listed.sort()).toEqual([...mine].sort());
    expect(listed).not.toContain(foreign);
    // while that show runs, its cards are not free
    expect((await I.availableInventory((await import('@/db')).db as never, house.publicKey.toBase58(), 20)).map((c) => c.mint)).toEqual([]);
  });

  t('skips a card the chain says is no longer transferable and uses another', async (e) => {
    const m = await stock(e, 8);
    unreadable.add(m[0]); unreadable.add(m[1]);
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('created');
    const listed = (await e.pool.query(`select mint_address from lots`)).rows.map((r) => r.mint_address);
    expect(listed).toHaveLength(6);
    expect(listed).not.toContain(m[0]);
    expect(listed).not.toContain(m[1]);
  });

  t('rotates least recently listed first: cards left over from one show open the next', async (e) => {
    const m = await stock(e, 8);
    await R.ensureHouseShow({ deps: deps(e) });
    const first = (await e.pool.query(`select mint_address from lots order by lot_number`)).rows.map((r) => r.mint_address);
    await e.pool.query(`update lots set state = 'passed', closed_at = now() where state = 'catalogued'; update shows set status = 'ended', ended_at = now()`);
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('created');
    const second = (await e.pool.query(`select l.mint_address from lots l join shows s on s.id = l.show_id where s.title = 'House show #2' order by l.lot_number`)).rows.map((r) => r.mint_address);
    const unused = m.filter((x) => !first.includes(x));
    expect(second.slice(0, 2).sort()).toEqual(unused.sort()); // the two that were not listed the first time come first
    expect(new Set(second).size).toBe(6);
  });

  t('a card sold to a person leaves the stock; a card a house bidder "won", or whose sale lapsed, stays', async (e) => {
    const m = await stock(e, 8);
    await R.ensureHouseShow({ deps: deps(e) });
    await e.pool.query(`update lots set state = 'sold', closed_at = now(), high_bid = 60000000 where state = 'catalogued'; update shows set status = 'ended', ended_at = now()`);
    const seller = (await e.pool.query(`select id from profiles where wallet_address = $1`, [house.publicKey.toBase58()])).rows[0].id as string;
    const human = await e.profile(); const bot = (await e.pool.query(`select id from profiles where is_bot limit 1`)).rows[0].id as string;
    const lotOf = async (mint: string) => (await e.pool.query(`select id from lots where mint_address = $1`, [mint])).rows[0].id as string;
    const sale = async (mint: string, buyer: string, status: string) =>
      e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status) values ($1,$2,$3,60000000,1500000,58500000,$4)`, [await lotOf(mint), buyer, seller, status]);
    const listed = (await e.pool.query(`select mint_address from lots order by lot_number`)).rows.map((r) => r.mint_address as string);
    await sale(listed[0], human.id, 'settled'); await sale(listed[1], human.id, 'awaiting_payment'); await sale(listed[2], human.id, 'expired'); await sale(listed[3], bot, 'awaiting_payment'); await sale(listed[4], human.id, 'failed');
    const free = (await I.availableInventory((await import('@/db')).db as never, house.publicKey.toBase58(), 20)).map((c) => c.mint);
    expect(free).not.toContain(listed[0]); // sold and settled: now the buyer's
    expect(free).not.toContain(listed[1]); // a person may still pay for it
    expect(free).toEqual(expect.arrayContaining([listed[2], listed[3], listed[4]])); // lapsed, house-bidder win, failed: still the house's
    expect(free).toEqual(expect.arrayContaining(m.filter((x) => !listed.includes(x))));
  });
});

describe('minting is fenced', () => {
  t('with no stock at all, a call that may mint mints, then creates the show; a call that may not says no_stock', async (e) => {
    expect(await R.ensureHouseShow({ maxMint: 0, deps: deps(e) })).toBe('no_stock');
    expect(minted).toBe(0);
    expect(await houseShows(e)).toHaveLength(0);
    expect(await R.ensureHouseShow({ maxMint: 3, deps: deps(e) })).toBe('created'); // 3 minted: a 3-lot show is better than no show
    expect(minted).toBeGreaterThanOrEqual(3);
    expect(minted).toBeLessThanOrEqual(6); // 3 before the show, at most 3 more to top up after it
    expect(await houseLotCount(e)).toBe(3);
  });

  t('tops the stock back up after creating, only while stock is below 6, never beyond maxMint per call', async (e) => {
    await stock(e, 8);
    expect(await R.ensureHouseShow({ maxMint: 1, deps: deps(e) })).toBe('created'); // 8 cards, 6 listed, 2 free: below 6, so mint, but only one
    expect(minted).toBe(1);
    await e.pool.query(`update lots set state = 'passed', closed_at = now() where state = 'catalogued'; update shows set status = 'ended', ended_at = now()`);
    minted = 0;
    expect(await R.ensureHouseShow({ maxMint: 4, deps: deps(e) })).toBe('created'); // 9 cards, 6 listed, 3 free: asks for 3 more, within the cap
    expect(minted).toBe(3);
    await e.pool.query(`update lots set state = 'passed', closed_at = now() where state = 'catalogued'; update shows set status = 'ended', ended_at = now()`);
    minted = 0;
    expect(await R.ensureHouseShow({ maxMint: 5, deps: deps(e) })).toBe('created'); // 12 cards: 6 free after listing, nothing to mint
    expect(minted).toBe(0);
  });

  t('a read-path call (the default maxMint) mints at most one; a refusing mint stops the loop at once', async (e) => {
    await stock(e, 7);
    expect(await R.keepHouseShowAlive({ deps: deps(e) })).toBe('created');
    expect(minted).toBeLessThanOrEqual(1);
    await e.pool.query(`update lots set state = 'passed', closed_at = now() where state = 'catalogued'; update shows set status = 'ended', ended_at = now()`);
    let asked = 0;
    expect(await R.ensureHouseShow({ maxMint: 6, deps: deps(e, { mintReplica: async () => { asked++; return false; } }) })).toBe('created');
    expect(asked).toBe(1); // false means "must not": it does not try again
  });
});
const houseLotCount = async (e: Env) => (await e.pool.query(`select count(*)::int c from lots`)).rows[0].c as number;

describe('the dry run', () => {
  t('plans the next show and writes nothing', async (e) => {
    await stock(e, 8);
    const { db } = await import('@/db');
    const plan = await R.planHouseShow({ db, readiness: async () => ({ eligible: true, reasons: [] }) }, house.publicKey.toBase58());
    expect(plan.title).toBe('House show #1');
    expect(plan.lots).toHaveLength(6);
    expect(plan.lots.every((l) => l.reserve === l.openingPrice && l.value > 0n)).toBe(true);
    expect(await houseShows(e)).toHaveLength(0);
    expect((await e.pool.query(`select count(*)::int c from profiles where is_bot`)).rows[0].c).toBe(0);
  });
});
