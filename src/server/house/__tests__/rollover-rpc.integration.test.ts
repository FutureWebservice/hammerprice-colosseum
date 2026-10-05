/**
 * The house rollover against a rate-limited RPC, on a real Postgres with the real engine: only the chain read (readMany) is faked.
 * A failing chain must cost ONE attempt per backoff window however often the room is read (no retry storm), the wait is shared between
 * server instances through app_flags, recovery creates the next show, and cards that passed lately are planned from the cache.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';
import { ChainError } from '@/lib/chain/errors';
import type { HouseDeps } from '../rollover';
import { createRolloverBackoff, dbFlagStore, guardFor, readRolloverState, READY_KEY, STATE_KEY } from '../rollover-guard';

let env: Env | undefined; let skipReason: string | undefined;
let R: typeof import('../rollover');
let dbh: typeof import('@/db').db;
const house = Keypair.generate();
const sa = Keypair.generate();

async function addCard(e: Env, n: number) {
  const mint = Keypair.generate().publicKey.toBase58();
  await e.pool.query(
    `insert into devnet_assets (mint, owner_wallet, name, image_url, attributes, minted_at) values ($1,$2,$3,$4,$5::jsonb, now() - make_interval(secs => $6))`,
    [mint, house.publicKey.toBase58(), `Card ${n} (devnet replica)`, `https://img.example/${n}.png`, JSON.stringify({ replica: 'true', replica_of: `real${n}`, grade: 'MINT 9', grading_company: 'PSA', set: `Set ${n}`, grading_id: String(1000 + n) }), 1000 - n],
  );
  return mint;
}

let t = Date.UTC(2026, 9, 4, 12, 0, 0);
const now = () => t;
let chainDown = false;
let reads: string[][] = [];
const limited = () => new ChainError('rpc_unavailable', 'every RPC endpoint failed (HTTP 429)');

/** A fresh backoff per call stands for another server instance: they share only the database. */
const instance = (): Partial<HouseDeps> => ({
  houseWallet: () => house.publicKey.toBase58(),
  backoff: createRolloverBackoff(dbFlagStore(dbh), now),
  readMany: async (mints) => { reads.push(mints); if (chainDown) throw limited(); return mints.map(() => ({ eligible: true, reasons: [] })); },
  mintReplica: async () => false,
});
const withKeys = (d: Partial<HouseDeps>): Partial<HouseDeps> => ({ ...d, botKeys: () => R.deriveBotKeys(sa) });

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  R = await import('../rollover');
  dbh = (await import('@/db')).db;
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  chainDown = false; reads = []; t = Date.UTC(2026, 9, 4, 12, 0, 0);
  guardFor(dbh).readiness.reset();
  await env.pool.query(`delete from app_flags where key in ('${STATE_KEY}', '${READY_KEY}'); delete from paddles; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows; delete from devnet_assets; delete from profiles where is_bot or wallet_address = '${house.publicKey.toBase58()}'`);
  for (let i = 0; i < 8; i++) await addCard(env, i);
});

const tt = (name: string, fn: (e: Env) => Promise<void>) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, 60_000);
const houseShows = async (e: Env) => (await e.pool.query(`select id from shows where is_house`)).rows;

describe('a chain that answers 429', () => {
  tt('20 reads inside one backoff window make exactly one attempt, create nothing, and every read stays alive', async (e) => {
    chainDown = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = withKeys(instance());
    const answers: string[] = [];
    for (let i = 0; i < 20; i++) { answers.push(await R.keepHouseShowAlive({ deps: d })); t += 2_000; } // 40 s in all, a read every 2 s
    quiet.mockRestore();
    expect(reads).toHaveLength(1);
    expect(answers[0]).toBe('none');
    expect(new Set(answers.slice(1))).toEqual(new Set(['backoff']));
    expect(await houseShows(e)).toHaveLength(0);
    const s = await readRolloverState(dbFlagStore(dbh));
    expect(s).toMatchObject({ failures: 1, lastError: expect.stringContaining('429') });
    expect(s!.nextRetryAt).toBe(Date.UTC(2026, 9, 4, 12, 0, 0) + 60_000);
  });

  tt('another server instance honours the wait it finds in the database', async () => {
    chainDown = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    await R.keepHouseShowAlive({ deps: withKeys(instance()) });
    t += 10_000;
    expect(await R.keepHouseShowAlive({ deps: withKeys(instance()) })).toBe('backoff');
    quiet.mockRestore();
    expect(reads).toHaveLength(1);
  });

  tt('the wait doubles with every failure and the next show is created as soon as the chain answers again', async (e) => {
    chainDown = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = withKeys(instance());
    await R.keepHouseShowAlive({ deps: d });
    t += 60_001;
    await R.keepHouseShowAlive({ deps: d }); // the second attempt fails too
    expect(reads).toHaveLength(2);
    t += 100_000; // inside the 120 s window
    expect(await R.keepHouseShowAlive({ deps: d })).toBe('backoff');
    quiet.mockRestore();
    expect(reads).toHaveLength(2);

    chainDown = false;
    t += 30_000; // past it
    expect(await R.keepHouseShowAlive({ deps: d })).toBe('created');
    expect(reads).toHaveLength(3);
    expect(await houseShows(e)).toHaveLength(1);
    expect(await readRolloverState(dbFlagStore(dbh))).toMatchObject({ failures: 0, lastOkAt: t, nextRetryAt: 0 });
  });
});

describe('a chain that never answers', () => {
  tt('a read waits for the rollover only up to the deadline, and the slow attempt counts as a failure', async (e) => {
    const slow = withKeys({ ...instance(), readMany: async (mints) => { await new Promise((r) => setTimeout(r, 300)); return mints.map(() => ({ eligible: true, reasons: [] })); } });
    const t0 = Date.now();
    expect(await R.keepHouseShowAlive({ deps: slow, deadlineMs: 30 })).toBe('none');
    expect(Date.now() - t0).toBeLessThan(250);
    expect((await readRolloverState(dbFlagStore(dbh)))?.failures).toBe(1);
    await new Promise((r) => setTimeout(r, 600)); // the attempt itself finishes in the background and creates the show, which resets the wait
    expect(await houseShows(e)).toHaveLength(1);
    expect(await readRolloverState(dbFlagStore(dbh))).toMatchObject({ failures: 0 });
  });
});

describe('cards that passed lately', () => {
  tt('are planned from the cache: the next show needs no chain request at all while the RPC is limited', async (e) => {
    expect(await R.keepHouseShowAlive({ deps: withKeys(instance()) })).toBe('created');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toHaveLength(8); // the whole candidate list in one request
    await e.pool.query(`update lots set state = 'passed', closed_at = now() where state = 'catalogued'; update shows set status = 'ended', ended_at = now()`);
    chainDown = true;
    t += 5 * 60_000; // inside the 10 minutes
    expect(await R.keepHouseShowAlive({ deps: withKeys(instance()) })).toBe('created');
    expect(reads).toHaveLength(1);
    expect(await houseShows(e)).toHaveLength(2);
  });
});
