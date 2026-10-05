/**
 * The real rollover hooks (src/server/vrf/rollover-hook.ts) wired into the house rollover over a real Postgres: the drawn order needs the
 * feature and a key, the request is created with the show, the draw runs in the background against the in-memory chain, and the engine then
 * opens the lots in the drawn order. A hook that cannot do its job leaves a plain catalogue show.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ChainError } from '@/lib/chain/errors';
import { clearFlagMemo } from '@/app/api/auctions/_shared/flags';
import { generateVrfKey } from '@/lib/vrf/key';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';
import type { HouseDeps } from '@/server/house/rollover';
import { FakeChain } from './fake-chain';
import { clearVrfKeyMemo } from '../key';

const hoisted = vi.hoisted(() => ({ deps: null as null | (() => unknown) }));
vi.mock('../service', async (orig) => ({ ...(await orig<typeof import('../service')>()), defaultDeps: () => hoisted.deps!() }));

let env: Env | undefined; let skipReason: string | undefined;
let R: typeof import('@/server/house/rollover');
let hook: typeof import('../rollover-hook');
const house = Keypair.generate(); const sa = Keypair.generate(); const g = generateVrfKey();
let chain: FakeChain;

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  R = await import('@/server/house/rollover');
  hook = await import('../rollover-hook');
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query(`delete from vrf_requests; delete from settlements; delete from bids; delete from paddles; delete from show_events; delete from lots; delete from shows; delete from devnet_assets; delete from profiles where is_bot or wallet_address = '${house.publicKey.toBase58()}'`);
  for (let i = 0; i < 6; i++) {
    await env.pool.query(`insert into devnet_assets (mint, owner_wallet, name, image_url, attributes, minted_at) values ($1,$2,$3,$4,$5::jsonb, now() - make_interval(secs => $6))`,
      [Keypair.generate().publicKey.toBase58(), house.publicKey.toBase58(), `Card ${i} (devnet replica)`, `https://img.example/${i}.png`, JSON.stringify({ replica: 'true', replica_of: `real${i}`, grade: 'MINT 9', grading_company: 'PSA', set: `Set ${i}`, grading_id: String(1000 + i) }), 1000 - i]);
  }
  chain = new FakeChain();
  hoisted.deps = () => ({ chain, key: g.key, sa, cluster: 'devnet', now: () => new Date(), sleep: async () => {}, env: {}, budgetMs: 60_000 });
  clearFlagMemo(); clearVrfKeyMemo();
});
afterEach(async () => {
  // background draws release their lease last: let them finish before the next test clears the tables
  if (env) for (let i = 0; i < 80 && (await env.pool.query(`select 1 from vrf_requests where lease_until is not null and lease_until > now()`)).rows.length > 0; i++) await new Promise((r) => setTimeout(r, 25));
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const deps = (): Partial<HouseDeps> => ({
  houseWallet: () => house.publicKey.toBase58(), botKeys: () => R.deriveBotKeys(sa), readiness: async () => ({ eligible: true, reasons: [] }), mintReplica: async () => false, order: hook,
});
const theShow = async (e: Env) => (await e.pool.query(`select id, order_mode, scheduled_at, created_at from shows where is_house`)).rows[0];
const on = () => { vi.stubEnv('FEATURE_VRF', 'true'); vi.stubEnv('VRF_SECRET_KEY', g.envValue); clearFlagMemo(); clearVrfKeyMemo(); };
const until = async <T,>(f: () => Promise<T | undefined | false>, ms = 8000): Promise<T> => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timed out');
};

describe('prepareHouseShow', () => {
  t('feature off: catalogue order, no delay', async () => {
    expect(await hook.prepareHouseShow({})).toEqual({ orderMode: 'catalogue', startDelayS: 0 });
  });
  t('feature on but no key: catalogue order, no delay', async () => {
    vi.stubEnv('FEATURE_VRF', 'true'); clearFlagMemo();
    expect(await hook.prepareHouseShow({ FEATURE_VRF: 'true' })).toEqual({ orderMode: 'catalogue', startDelayS: 0 });
  });
  t('feature on with a key: a drawn order and a 60 s start delay', async () => {
    on();
    expect(await hook.prepareHouseShow()).toEqual({ orderMode: 'vrf', startDelayS: 60 });
  });
  t('a mainnet deployment with an incomplete configuration throws, so the rollover falls back to the catalogue', async () => {
    on(); vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta');
    await expect(hook.prepareHouseShow()).rejects.toMatchObject({ code: 'mainnet_config_incomplete' });
    vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  });
});

describe('the house rollover with the real hooks', () => {
  t('feature off: a plain catalogue show and no request', async (e) => {
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    expect((await theShow(e)).order_mode).toBe('catalogue');
    expect((await e.pool.query(`select count(*)::int n from vrf_requests`)).rows[0].n).toBe(0);
  });

  t('feature on: a drawn-order show starting in 60 s, one request, drawn in the background, and the engine opens the lots in the drawn order', async (e) => {
    on();
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const s = await theShow(e);
    expect(s.order_mode).toBe('vrf');
    expect(s.scheduled_at.getTime() - s.created_at.getTime()).toBeGreaterThan(55_000);
    const req = await until(async () => (await e.pool.query(`select * from vrf_requests where subject_id = $1`, [s.id])).rows[0]);
    expect(req.purpose).toBe('lot_order');
    expect(Math.round((req.reveal_by.getTime() - req.created_at.getTime()) / 1000)).toBeGreaterThanOrEqual(119); // the house window: 120 s
    const done = await until(async () => { const r = (await e.pool.query(`select * from vrf_requests where id = $1`, [req.id])).rows[0]; return r.status === 'revealed' ? r : undefined; });
    const order = done.result.order as string[];
    expect(done.result.applied).toBe(true);
    // The show is due: the engine goes live and opens the first lot of the DRAWN order.
    await e.pool.query(`update shows set scheduled_at = now() - interval '1 second' where id = $1`, [s.id]);
    await e.svc.advanceShow(s.id);
    const open = (await e.pool.query(`select id, lot_number from lots where show_id = $1 and state = 'open'`, [s.id])).rows[0];
    expect(open).toMatchObject({ id: order[0], lot_number: 1 });
  });

  t('the show waits for the draw: with the chain down the first lot stays closed until the deadline, then opens in catalogue order', async (e) => {
    on();
    chain.failSend = new ChainError('rpc_unavailable', 'down');
    vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const s = await theShow(e);
    await e.pool.query(`update shows set scheduled_at = now() - interval '1 second' where id = $1`, [s.id]);
    await e.svc.advanceShow(s.id);
    expect((await e.pool.query(`select count(*)::int n from lots where show_id = $1 and state = 'open'`, [s.id])).rows[0].n).toBe(0);
    const before = (await e.pool.query(`select id from lots where show_id = $1 order by lot_number`, [s.id])).rows.map((r) => r.id);
    await e.pool.query(`update vrf_requests set reveal_by = now() - interval '1 second' where subject_id = $1`, [s.id]);
    await e.svc.advanceShow(s.id);
    expect((await e.pool.query(`select status from vrf_requests where subject_id = $1`, [s.id])).rows[0].status).toBe('defaulted');
    expect((await e.pool.query(`select id from lots where show_id = $1 and state = 'open'`, [s.id])).rows[0].id).toBe(before[0]);
  });

  t('the next house show also requests the thank-you draw of the one that just ended (two human bidders), and it is drawn in the background', async (e) => {
    on();
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const first = await theShow(e);
    const mkBidder = async (lot: string) => {
      const { rows: [p] } = await e.pool.query(`insert into profiles (wallet_address) values ($1) returning id`, [Keypair.generate().publicKey.toBase58()]);
      const { rows: [d] } = await e.pool.query(`insert into paddles (show_id, profile_id, number, valid_until, auth_message, auth_signature) values ($1,$2,(select coalesce(max(number),0)+10 from paddles where show_id = $1),now() + interval '1 hour','m','s') returning id, number`, [first.id, p.id]);
      await e.pool.query(`insert into bids (lot_id, bidder_id, amount, signature, message, nonce, via, paddle_id) values ($1,$2,5,'s','m',$3,'session',$4)`, [lot, p.id, `n${d.number}`, d.id]);
      return d.number as number;
    };
    const lots = (await e.pool.query(`select id from lots where show_id = $1 order by lot_number`, [first.id])).rows.map((r) => r.id);
    const a = await mkBidder(lots[0]); const b = await mkBidder(lots[1]);
    await e.pool.query(`update vrf_requests set status = 'defaulted' where subject_id = $1`, [first.id]); // the first show's own draw is finished
    await e.pool.query(`update shows set status = 'ended', ended_at = now() where id = $1`, [first.id]);
    await e.pool.query(`update lots set state = 'withdrawn', closed_at = now() where show_id = $1 and state in ('catalogued', 'open')`, [first.id]); // an ended show has no lot left on the block
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const raffle = await until(async () => (await e.pool.query(`select * from vrf_requests where purpose = 'raffle' and subject_id = $1`, [first.id])).rows[0]);
    expect(raffle.params.entrants).toEqual([a, b].sort((x, y) => x - y));
    const done = await until(async () => { const r = (await e.pool.query(`select * from vrf_requests where id = $1`, [raffle.id])).rows[0]; return r.status === 'revealed' ? r : undefined; });
    expect([a, b]).toContain(done.result.winnerPaddle);
  });

  t('afterHouseShowCreated twice creates one request', async (e) => {
    on();
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const s = await theShow(e);
    await hook.afterHouseShowCreated(s.id);
    expect((await e.pool.query(`select count(*)::int n from vrf_requests where subject_id = $1`, [s.id])).rows[0].n).toBe(1);
  });
});
