/**
 * The house rollover and the one-card-one-place lock (src/server/assets/listed.ts) agree on what "listed" means: the rollover never plans a card
 * the engine would refuse, a sale whose payment window has passed no longer holds its card, and a refusal that still happens (a race) is planned
 * around instead of failing the read. Real Postgres 18 and the real engine; only the chain is faked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { ApiError } from '@/contracts';
import { startEnv, type Env } from '@/server/auction/__tests__/harness';
import type { HouseDeps } from '../rollover';
import { noBackoff } from '../rollover-guard';

let env: Env | undefined; let skipReason: string | undefined;
let R: typeof import('../rollover');
const house = Keypair.generate();
const sa = Keypair.generate();
const ok = { eligible: true, reasons: [] as never[] };

async function addCard(e: Env, n: number) {
  const mint = Keypair.generate().publicKey.toBase58();
  await e.pool.query(
    `insert into devnet_assets (mint, owner_wallet, name, image_url, attributes, minted_at) values ($1,$2,$3,$4,$5::jsonb, now() - make_interval(secs => $6))`,
    [mint, house.publicKey.toBase58(), `Card ${n} (devnet replica)`, `https://img.example/${n}.png`, JSON.stringify({ replica: 'true', replica_of: `real${n}`, grade: 'MINT 9', grading_company: 'PSA', set: `Set ${n}`, grading_id: String(1000 + n) }), 1000 - n],
  );
  return mint;
}
const stock = async (e: Env, n: number) => { const m: string[] = []; for (let i = 0; i < n; i++) m.push(await addCard(e, i)); return m; };
const deps = (over: Partial<HouseDeps> = {}): Partial<HouseDeps> => ({
  backoff: noBackoff,
  houseWallet: () => house.publicKey.toBase58(),
  botKeys: () => R.deriveBotKeys(sa),
  readiness: async () => ok,
  mintReplica: async () => false,
  ...over,
});
/** A show of someone else's (or the house's) that holds `mint` in one lot. */
async function lotWith(e: Env, mint: string, show: { status: string; kind?: string; isHouse?: boolean }, lot: { state: string }) {
  const p = await e.profile();
  const d = await e.svc.createShow({ title: 'Other', sellerProfileId: p.id, lots: [{ mint }], readiness: { [mint]: ok } });
  await e.pool.query(`update shows set status = $2::show_status, kind = $3, is_house = $4 where id = $1`, [d.show.id, show.status, show.kind ?? 'live', show.isHouse ?? false]);
  await e.pool.query(`update lots set state = $2::lot_state where id = $1`, [d.lots[0].id, lot.state]);
  return { show: d.show.id, lot: d.lots[0].id, seller: p.id };
}
async function settlement(e: Env, lotId: string, sellerId: string, status: string, dueInS: number, bot = false) {
  const buyer = await e.profile();
  if (bot) await e.pool.query(`update profiles set is_bot = true where id = $1`, [buyer.id]);
  await e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status, due_at) values ($1,$2,$3,1000000,0,1000000,$4, now() + make_interval(secs => $5))`, [lotId, buyer.id, sellerId, status, dueInS]);
}
const listedMints = async (e: Env) => (await e.pool.query(`select l.mint_address m from lots l join shows s on s.id = l.show_id where s.is_house`)).rows.map((r) => r.m as string);

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  R = await import('../rollover');
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query(`delete from paddles; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows; delete from devnet_assets; delete from profiles where is_bot or wallet_address = '${house.publicKey.toBase58()}'`);
});
const t = (name: string, fn: (e: Env) => Promise<void>) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, 60_000);

describe('the rollover plans only cards the engine accepts', () => {
  t('a sold lot whose payment window has passed no longer holds its card: it is listed again, and the show is created', async (e) => {
    const m = await stock(e, 6);
    const old = await lotWith(e, m[0], { status: 'ended' }, { state: 'sold' });
    await settlement(e, old.lot, old.seller, 'awaiting_payment', -3600); // the buyer never paid and the daily sweep has not run
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    expect((await listedMints(e)).sort()).toEqual([...m].sort());
  });

  t('a sold lot still inside its payment window keeps its card out; the next free cards are picked instead of failing the plan', async (e) => {
    const m = await stock(e, 8);
    const sold = await lotWith(e, m[0], { status: 'ended' }, { state: 'sold' });
    await settlement(e, sold.lot, sold.seller, 'awaiting_payment', 3600);
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const listed = await listedMints(e);
    expect(listed).toHaveLength(6);
    expect(listed).not.toContain(m[0]);
  });

  t('a live timed house lot keeps its card out of the live room', async (e) => {
    const m = await stock(e, 7);
    await lotWith(e, m[0], { status: 'live', kind: 'timed', isHouse: true }, { state: 'open' });
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    const live = (await e.pool.query(`select l.mint_address m from lots l join shows s on s.id = l.show_id where s.is_house and s.kind = 'live'`)).rows.map((r) => r.m);
    expect(live).toHaveLength(6);
    expect(live).not.toContain(m[0]);
  });

  t('an ended show frees its cards', async (e) => {
    const m = await stock(e, 6);
    const old = await lotWith(e, m[0], { status: 'ended', isHouse: true }, { state: 'passed' });
    expect(old.show).toBeTruthy();
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    expect((await listedMints(e)).filter((x) => x === m[0])).toHaveLength(2); // the old lot and the new one
  });

  t('fewer free cards than six: a smaller show, not an error', async (e) => {
    const m = await stock(e, 5);
    await lotWith(e, m[0], { status: 'live', kind: 'timed', isHouse: true }, { state: 'open' });
    await lotWith(e, m[1], { status: 'live', kind: 'timed', isHouse: true }, { state: 'open' });
    expect(await R.ensureHouseShow({ deps: deps() })).toBe('created');
    expect((await e.pool.query(`select count(*)::int n from lots l join shows s on s.id = l.show_id where s.is_house and s.kind = 'live'`)).rows[0].n).toBe(3);
  });

  t('no free card at all: no_stock, which is not an error', async (e) => {
    const m = await stock(e, 2);
    await lotWith(e, m[0], { status: 'live', kind: 'timed', isHouse: true }, { state: 'open' });
    await lotWith(e, m[1], { status: 'live', kind: 'timed', isHouse: true }, { state: 'open' });
    expect(await R.keepHouseShowAlive({ deps: deps() })).toBe('no_stock');
  });

  t('a refusal that still happens (a race) leaves that card out and plans again; three refusals are no_stock, never an error', async (e) => {
    await stock(e, 8);
    const auction = await import('@/server/auction/service');
    let refused = 0; let refusedMint = '';
    const racy = (times: number) => deps({ auction: { ...auction, createShow: async (input) => {
      const first = input.lots[0].mint;
      if (refused < times) { if (refused++ === 0) refusedMint = first; throw new ApiError('already_listed', `The card ${first} is already in a room or sale.`, { mint: first }); }
      return auction.createShow(input);
    } } });
    expect(await R.ensureHouseShow({ deps: racy(1) })).toBe('created');
    const listed = await listedMints(e);
    expect(listed).toHaveLength(6);
    expect(refusedMint).not.toBe('');
    expect(listed).not.toContain(refusedMint); // planned around, 7 cards left for 6 lots
    await e.pool.query(`delete from paddles; delete from show_events; delete from lots; delete from shows`);
    refused = 0;
    expect(await R.ensureHouseShow({ deps: racy(5) })).toBe('no_stock');
  });
});
