/**
 * The timed half of the house rollover (FEATURE_TIMED): two one-card auctions next to the live room, the second one half as long, nothing when the
 * feature is off, one set however many callers race, never a failure of the live room. Real Postgres and engine, fake chain.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { clearFlagMemo } from '@/app/api/auctions/_shared/flags';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';
import type { HouseDeps } from '../rollover';
import { noBackoff } from '../rollover-guard';

let env: Env | undefined; let skipReason: string | undefined;
let R: typeof import('../rollover');
const house = Keypair.generate();
const sa = Keypair.generate();
let minted = 0;

async function addCard(e: Env, n: number) {
  const mint = Keypair.generate().publicKey.toBase58();
  await e.pool.query(
    `insert into devnet_assets (mint, owner_wallet, name, image_url, attributes, minted_at) values ($1,$2,$3,$4,$5::jsonb, now() - make_interval(secs => $6))`,
    [mint, house.publicKey.toBase58(), `Card ${n} (devnet replica)`, `https://img.example/${n}.png`, JSON.stringify({ replica: 'true', replica_of: `real${n}`, grade: 'MINT 9', grading_company: 'PSA', set: `Set ${n}`, grading_id: String(1000 + n) }), 1000 - n],
  );
}
const stock = async (e: Env, n: number) => { for (let i = 0; i < n; i++) await addCard(e, i); };

const deps = (e: Env, over: Partial<HouseDeps> = {}): Partial<HouseDeps> => ({
  backoff: noBackoff, // these tests make the chain fail on purpose; the backoff has its own tests
  houseWallet: () => house.publicKey.toBase58(),
  botKeys: () => R.deriveBotKeys(sa),
  readiness: async () => ({ eligible: true, reasons: [] }),
  mintReplica: async () => { minted++; await addCard(e, 100 + minted); return true; },
  timedOn: async () => true,
  timedDurationS: () => 3600,
  ...over,
});

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  R = await import('../rollover');
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  minted = 0;
  await env.pool.query(`delete from vrf_requests; delete from paddles; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows; delete from devnet_assets; delete from profiles where is_bot or wallet_address = '${house.publicKey.toBase58()}'`);
  vi.stubEnv('FEATURE_TIMED', 'true'); clearFlagMemo();
});
afterEach(() => { vi.unstubAllEnvs(); clearFlagMemo(); vi.restoreAllMocks(); });

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const timedShows = async (e: Env) => (await e.pool.query(`select id, status, title, kind, is_house, rules, settlement_mode, cluster from shows where kind = 'timed' order by created_at`)).rows;
const liveShows = async (e: Env) => (await e.pool.query(`select id from shows where is_house and kind = 'live'`)).rows;

describe('pure helpers', () => {
  // the helpers need no database: load the module here too, so they still run when the embedded Postgres cannot start (the top beforeAll then returns early)
  beforeAll(async () => { R ??= await import('../rollover'); });
  it('TIMED_HOUSE_DURATION_S: whole seconds from the minimum to 14 days, anything else is one hour', () => {
    expect(R.houseTimedDurationS({})).toBe(3600);
    expect(R.houseTimedDurationS({ TIMED_HOUSE_DURATION_S: '7200' })).toBe(7200);
    expect(R.houseTimedDurationS({ TIMED_HOUSE_DURATION_S: '600' })).toBe(600);
    expect(R.houseTimedDurationS({ TIMED_HOUSE_DURATION_S: '1209600' })).toBe(1_209_600);
    for (const bad of ['', 'x', '59', '599', '1209601', '-3600', '3600.5', '1e4', '3600 # one hour']) expect(R.houseTimedDurationS({ TIMED_HOUSE_DURATION_S: bad }), bad).toBe(3600);
  });
  it('a test environment may go below 10 minutes on devnet, never on mainnet', () => {
    expect(R.houseTimedDurationS({ TIMED_HOUSE_DURATION_S: '30', TIMED_MIN_DURATION_S: '20' })).toBe(30);
    expect(R.houseTimedDurationS({ TIMED_HOUSE_DURATION_S: '30', TIMED_MIN_DURATION_S: '20', SOLANA_CLUSTER: 'mainnet-beta' })).toBe(3600);
  });
  it('the second auction is half as long while the first has more than half left, else full length; never below the minimum', () => {
    expect(R.nextTimedDurationS(3600, 600, null)).toBe(3600);
    expect(R.nextTimedDurationS(3600, 600, 3600)).toBe(1800);
    expect(R.nextTimedDurationS(3600, 600, 1801)).toBe(1800);
    expect(R.nextTimedDurationS(3600, 600, 1800)).toBe(3600);
    expect(R.nextTimedDurationS(3600, 600, 10)).toBe(3600);
    expect(R.nextTimedDurationS(900, 600, 900)).toBe(600);
  });
});

describe('the timed house auctions', () => {
  t('FEATURE_TIMED off: nothing timed is created, the live room is as before', async (e) => {
    vi.stubEnv('FEATURE_TIMED', ''); clearFlagMemo();
    await stock(e, 10);
    expect(await R.ensureHouseShow({ deps: deps(e, { timedOn: async () => (await import('@/lib/features')).featureOn('TIMED') }) })).toBe('created');
    expect(await timedShows(e)).toHaveLength(0);
    expect(await liveShows(e)).toHaveLength(1);
  });

  t('on: two timed auctions next to the live room, one card each, the second half as long, server-signed on devnet, house paddles that outlive the lot', async (e) => {
    await stock(e, 8);
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('created');
    const timed = await timedShows(e);
    expect(timed).toHaveLength(2);
    expect(timed.map((s) => s.rules.lotDurationS)).toEqual([3600, 1800]);
    for (const s of timed) {
      expect(s).toMatchObject({ kind: 'timed', is_house: true, settlement_mode: 'onchain', cluster: 'devnet', status: 'scheduled' });
      expect(s.rules.settlementWindowS).toBe(6 * 3600);
      expect((await e.pool.query(`select count(*)::int n from lots where show_id = $1`, [s.id])).rows[0].n).toBe(1);
      const pads = (await e.pool.query(`select pd.number, p.is_bot, pd.valid_until from paddles pd join profiles p on p.id = pd.profile_id where pd.show_id = $1 order by pd.number`, [s.id])).rows;
      expect(pads.map((p) => p.number)).toEqual([1, 2, 3]);
      expect(pads.every((p) => p.is_bot)).toBe(true);
      // one hour plus the 24 hour extension cap plus an hour of slack
      expect((pads[0].valid_until as Date).getTime() - Date.now()).toBeGreaterThan(25 * 3_600_000);
    }
    expect(timed.map((s) => s.title)).toEqual(['Timed house lot #1', 'Timed house lot #2']);
    // all eight cards are in use: six in the live room, one in each timed auction, none twice
    const mints = (await e.pool.query(`select mint_address from lots`)).rows.map((r) => r.mint_address);
    expect(new Set(mints).size).toBe(8);
  });

  t('TIMED_HOUSE_COUNT caps how many run: 1 makes one, 0 makes none (the live room is unaffected), 3 makes three', async (e) => {
    await stock(e, 12);
    expect(await R.ensureHouseShow({ deps: deps(e, { timedCount: () => 0 }) })).toBe('created');
    expect(await timedShows(e)).toHaveLength(0);
    await R.ensureHouseShow({ deps: deps(e, { timedCount: () => 1 }) });
    expect(await timedShows(e)).toHaveLength(1);
    await R.ensureHouseShow({ deps: deps(e, { timedCount: () => 1 }) });
    expect(await timedShows(e)).toHaveLength(1);
    await R.ensureHouseShow({ deps: deps(e, { timedCount: () => 3 }) });
    expect(await timedShows(e)).toHaveLength(3);
  });

  t('the auctions open and run on the lazy clock, with the card as the lot', async (e) => {
    await stock(e, 8);
    await R.ensureHouseShow({ deps: deps(e) });
    const [first] = await timedShows(e);
    await e.svc.advanceShow(first.id);
    const l = (await e.pool.query(`select state, closes_at, opened_at from lots where show_id = $1`, [first.id])).rows[0];
    expect(l.state).toBe('open');
    expect(l.closes_at.getTime() - l.opened_at.getTime()).toBe(3600_000);
  });

  t('a second call changes nothing, and ten racing callers still leave exactly two', async (e) => {
    await stock(e, 12);
    await R.ensureHouseShow({ deps: deps(e) });
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('none');
    expect(await timedShows(e)).toHaveLength(2);
    await e.pool.query(`delete from paddles; delete from show_events; delete from lots; delete from shows`);
    const results = await Promise.all(Array.from({ length: 10 }, () => R.ensureHouseShow({ deps: deps(e) })));
    expect(results.filter((r) => r === 'created')).toHaveLength(1);
    expect(await timedShows(e)).toHaveLength(2);
    expect(await liveShows(e)).toHaveLength(1);
  }, 120_000);

  t('when one finishes, the next one is created with the full length (the other has less than half left, so they never end together)', async (e) => {
    await stock(e, 12);
    await R.ensureHouseShow({ deps: deps(e) });
    const [a, b] = await timedShows(e);
    await e.svc.advanceShow(a.id); await e.svc.advanceShow(b.id);
    // the half-length auction (b) ends while a has 25 minutes left (less than half of an hour)
    await e.pool.query(`update lots set closes_at = now() - interval '1 second' where show_id = $1`, [b.id]);
    await e.pool.query(`update lots set closes_at = now() + interval '25 minutes' where show_id = $1`, [a.id]);
    expect(await R.ensureHouseShow({ deps: deps(e) })).toBe('none');
    const all = await timedShows(e);
    expect(all).toHaveLength(3);
    expect(all.find((s) => s.id === b.id)!.status).toBe('ended');
    expect(all[2].rules.lotDurationS).toBe(3600);
  });

  t('the timed half never fails or blocks the live room', async (e) => {
    await stock(e, 8);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await R.ensureHouseShow({ deps: deps(e, { timedOn: async () => { throw new Error('flag table down'); } }) })).toBe('created');
    expect(await liveShows(e)).toHaveLength(1);
    expect(await timedShows(e)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  t('a running timed auction does not stand in for the live room', async (e) => {
    await stock(e, 8);
    const seller = await e.profile({ wallet: house.publicKey.toBase58() });
    const s = await e.show({ sellerId: seller.id, status: 'live', isHouse: true, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 3_600_000) }] });
    await e.pool.query(`update shows set kind = 'timed' where id = $1`, [s.id]);
    expect(await R.ensureHouseShow({ deps: deps(e, { timedOn: async () => false }) })).toBe('created');
    expect(await liveShows(e)).toHaveLength(1);
  });

  t('stock too short for a timed auction: the live room is unaffected, and a restock fills the gap', async (e) => {
    await stock(e, 6); // the live room takes all six
    expect(await R.ensureHouseShow({ deps: deps(e, { mintReplica: async () => false }) })).toBe('created');
    expect(await timedShows(e)).toHaveLength(0);
    expect(await R.ensureHouseShow({ maxMint: 1, deps: deps(e) })).toBe('none'); // live is running; a minted card becomes the first timed auction
    expect((await timedShows(e)).length).toBeGreaterThanOrEqual(1);
    expect(minted).toBeGreaterThanOrEqual(1);
  });

  t('/room/house resolves to the live room, never to a timed auction while the live room is live (even a newer, live one)', async (e) => {
    await stock(e, 8);
    await R.ensureHouseShow({ deps: deps(e) });
    const [liveRoom] = await liveShows(e);
    for (const s of await timedShows(e)) await e.svc.advanceShow(s.id); // the timed auctions go live, after the live room was created
    await e.svc.advanceShow(liveRoom.id);
    expect((await e.pool.query(`select count(*)::int n from shows where kind = 'timed' and status = 'live'`)).rows[0].n).toBe(2);
    const { currentHouseShow } = await import('@/lib/house-room');
    expect(await currentHouseShow()).toMatchObject({ id: liveRoom.id, status: 'live' });
    // with the live room over and timed auctions still live, the link lands in a live timed room, not in the room that ended
    await e.pool.query(`update shows set status = 'ended', ended_at = now() where id = $1`, [liveRoom.id]);
    expect(await currentHouseShow()).toMatchObject({ status: 'live', kind: 'timed' });
    await e.pool.query(`update shows set status = 'ended', ended_at = now() where kind = 'timed'`);
    expect(await currentHouseShow()).toMatchObject({ id: liveRoom.id, status: 'ended' });
  });

  t('unconfigured (no house wallet): nothing, as before', async (e) => {
    expect(await R.ensureHouseShow({ deps: deps(e, { houseWallet: () => null }) })).toBe('unconfigured');
    expect(await timedShows(e)).toHaveLength(0);
  });
});
