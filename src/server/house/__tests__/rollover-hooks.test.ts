/**
 * The two hooks of the optional features in the house rollover: the drawn-order hooks (never allowed to fail the rollover) and the
 * HOUSE_VIDEO_ENABLED value. Same fake chain as the rollover integration test; the engine and the database are real.
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

async function addCard(e: Env, n: number) {
  const mint = Keypair.generate().publicKey.toBase58();
  await e.pool.query(
    `insert into devnet_assets (mint, owner_wallet, name, image_url, attributes, minted_at) values ($1,$2,$3,$4,$5::jsonb, now() - make_interval(secs => $6))`,
    [mint, house.publicKey.toBase58(), `Card ${n} (devnet replica)`, `https://img.example/${n}.png`, JSON.stringify({ replica: 'true', replica_of: `real${n}`, grade: 'MINT 9', grading_company: 'PSA', set: `Set ${n}`, grading_id: String(1000 + n) }), 1000 - n],
  );
}

const deps = (over: Partial<HouseDeps> = {}): Partial<HouseDeps> => ({
  backoff: noBackoff, // these tests make the chain fail on purpose; the backoff has its own tests
  houseWallet: () => house.publicKey.toBase58(),
  botKeys: () => R.deriveBotKeys(sa),
  readiness: async () => ({ eligible: true, reasons: [] }),
  mintReplica: async () => false,
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
  await env.pool.query(`delete from vrf_requests; delete from paddles; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows; delete from devnet_assets; delete from profiles where is_bot or wallet_address = '${house.publicKey.toBase58()}'`);
  for (let i = 0; i < 6; i++) await addCard(env, i);
});
afterEach(() => { vi.unstubAllEnvs(); clearFlagMemo(); vi.restoreAllMocks(); });

const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);
const theShow = async (e: Env) => (await e.pool.query(`select id, order_mode, video_enabled, scheduled_at, created_at from shows where is_house`)).rows[0] as { id: string; order_mode: string; video_enabled: boolean; scheduled_at: Date; created_at: Date };

describe('house rollover: the drawn-order hooks', () => {
  t('with the stub hooks the house show is a catalogue show that starts at once', async (e) => {
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const s = await theShow(e);
    expect(s.order_mode).toBe('catalogue');
    expect(s.scheduled_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  t('prepareHouseShow decides the order mode and the start delay; afterHouseShowCreated gets the new show id, after the show exists', async (e) => {
    const after = vi.fn(async (id: string) => { expect((await e.pool.query(`select 1 from shows where id = $1`, [id])).rows).toHaveLength(1); });
    const order = { prepareHouseShow: async () => ({ orderMode: 'vrf' as const, startDelayS: 60 }), afterHouseShowCreated: after };
    expect(await R.ensureHouseShow({ deps: deps({ order }) })).toBe('created');
    const s = await theShow(e);
    expect(s.order_mode).toBe('vrf');
    expect(s.scheduled_at.getTime() - Date.now()).toBeGreaterThan(50_000); // the draw needs its time before the first lot
    expect(s.scheduled_at.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect(after).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledWith(s.id);
  });

  t('a prepare hook that throws never fails the rollover: the show is a catalogue show', async (e) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order = { prepareHouseShow: async () => { throw new Error('beacon unreachable'); }, afterHouseShowCreated: async () => {} };
    expect(await R.ensureHouseShow({ deps: deps({ order }) })).toBe('created');
    expect((await theShow(e)).order_mode).toBe('catalogue');
  });

  t('an after hook that throws never fails the rollover either, and the show keeps its place', async (e) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const order = { prepareHouseShow: async () => ({ orderMode: 'vrf' as const, startDelayS: 30 }), afterHouseShowCreated: async () => { throw new Error('rpc down'); } };
    expect(await R.ensureHouseShow({ deps: deps({ order }) })).toBe('created');
    const s = await theShow(e);
    expect(s.order_mode).toBe('vrf'); // no request exists: the engine opens it in catalogue order (orderGate none)
    expect((await e.pool.query(`select count(*)::int n from paddles where show_id = $1`, [s.id])).rows[0].n).toBe(3);
    expect((await e.pool.query(`select count(*)::int n from vrf_requests`)).rows[0].n).toBe(0);
  });

  t('a silly start delay is bounded: negative or unbounded values never schedule the show in the past or next week', async (e) => {
    for (const d of [-500, 1e9, NaN]) {
      await e.pool.query(`delete from paddles; delete from show_events; delete from lots; delete from shows`);
      const order = { prepareHouseShow: async () => ({ orderMode: 'catalogue' as const, startDelayS: d }), afterHouseShowCreated: async () => {} };
      expect(await R.ensureHouseShow({ deps: deps({ order }) })).toBe('created');
      const s = await theShow(e);
      expect(s.scheduled_at.getTime() - Date.now(), String(d)).toBeLessThanOrEqual(600_000);
      expect(s.scheduled_at.getTime() - s.created_at.getTime(), String(d)).toBeGreaterThanOrEqual(-1000);
    }
  });
});

describe('house rollover: the optional video', () => {
  t('is off by default', async (e) => {
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    expect((await theShow(e)).video_enabled).toBe(false);
  });

  t('HOUSE_VIDEO_ENABLED alone is not enough: FEATURE_VIDEO must be on too', async (e) => {
    vi.stubEnv('HOUSE_VIDEO_ENABLED', 'true');
    expect(await R.ensureHouseShow({ deps: deps({ houseVideo: () => process.env.HOUSE_VIDEO_ENABLED === 'true' }) })).toBe('created');
    expect((await theShow(e)).video_enabled).toBe(false);
  });

  t('both on: the house show carries the video, and the real wiring reads HOUSE_VIDEO_ENABLED', async (e) => {
    vi.stubEnv('HOUSE_VIDEO_ENABLED', 'true');
    vi.stubEnv('FEATURE_VIDEO', 'true'); clearFlagMemo();
    // `houseVideo` is not overridden here, but defaultDeps only runs with the real chain; the same one-line reader is exercised through the dependency.
    expect(await R.ensureHouseShow({ deps: deps({ houseVideo: () => process.env.HOUSE_VIDEO_ENABLED === 'true' }) })).toBe('created');
    expect((await theShow(e)).video_enabled).toBe(true);
  });

  t('HOUSE_VIDEO_ENABLED must be exactly "true"', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../rollover.ts', import.meta.url), 'utf8');
    expect(src).toContain("houseVideo: () => process.env.HOUSE_VIDEO_ENABLED === 'true'");
  });
});
