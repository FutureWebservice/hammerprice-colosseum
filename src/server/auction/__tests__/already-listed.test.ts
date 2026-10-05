/**
 * One card, one place: createShow refuses a card that is already in a queued or running lot, in a sale that is still being paid, or in a pack pool,
 * with `already_listed` (409), even when two requests race, and the card is free again when its lot ended unsold or was sold and settled.
 * The seller's picker (GET /api/sell/assets) flags those cards with the same rule. Real Postgres 18 and the real service.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, ERROR_STATUS } from '@/contracts/errors';
import { SellAssetsResponse } from '@/contracts/api';
import { startEnv, type Env } from './harness';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query(`delete from pack_draws; delete from pack_pool_cards; delete from pack_definitions; delete from show_events; delete from settlements; delete from bids; delete from lots; delete from shows; delete from devnet_assets`);
});
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const ok = { eligible: true, reasons: [] as never[] };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mint = (n: number) => `Card${B58[n % B58.length]}${'y'.repeat(32)}`;
const list = (e: Env, sellerProfileId: string, mints: string[], title = 'Show') =>
  e.svc.createShow({ title, sellerProfileId, lots: mints.map((m) => ({ mint: m })), readiness: Object.fromEntries(mints.map((m) => [m, ok])) });
const fail = async (p: Promise<unknown>) => { try { await p; } catch (x) { return x as ApiError; } throw new Error('expected already_listed'); };
const stateOf = (e: Env, lotId: string, state: string, extra = '') => e.pool.query(`update lots set state = $2::lot_state ${extra} where id = $1`, [lotId, state]);

describe('createShow: a card is offered in one place at a time', () => {
  t('a card in a scheduled show cannot be listed again, by the same seller or by another one', async (e) => {
    const a = await e.profile(); const b = await e.profile();
    await list(e, a.id, [mint(1)]);
    const err = await fail(list(e, a.id, [mint(1)], 'Again'));
    expect(err.code).toBe('already_listed');
    expect(ERROR_STATUS.already_listed).toBe(409);
    expect(err.extra).toMatchObject({ mint: mint(1), listing: { kind: 'lot' } });
    expect((await fail(list(e, b.id, [mint(1)]))).code).toBe('already_listed');
    expect(Number((await e.pool.query(`select count(*)::int n from shows`)).rows[0].n)).toBe(1); // nothing half-made
  });

  t('one card of several is enough to refuse the whole show, and the free cards stay free', async (e) => {
    const a = await e.profile();
    await list(e, a.id, [mint(1)]);
    expect((await fail(list(e, a.id, [mint(2), mint(1), mint(3)]))).code).toBe('already_listed');
    await expect(list(e, a.id, [mint(2), mint(3)])).resolves.toBeTruthy();
  });

  t('a live show and an open lot count; so does a lot waiting to open in a live show', async (e) => {
    const a = await e.profile();
    const d = await list(e, a.id, [mint(1), mint(2)]);
    await e.pool.query(`update shows set status = 'live', started_at = now() where id = $1`, [d.show.id]);
    await stateOf(e, d.lots[0].id, 'open', `, opened_at = now(), closes_at = now() + interval '1 hour'`);
    expect((await fail(list(e, a.id, [mint(1)]))).code).toBe('already_listed'); // on the block
    expect((await fail(list(e, a.id, [mint(2)]))).code).toBe('already_listed'); // queued
  });

  t('free again: lot ended unsold (passed), withdrawn, or sold and settled (the card moved on)', async (e) => {
    const a = await e.profile();
    const d = await list(e, a.id, [mint(1), mint(2), mint(3)]);
    await e.pool.query(`update shows set status = 'live', started_at = now() where id = $1`, [d.show.id]);
    await stateOf(e, d.lots[0].id, 'passed', ', closed_at = now()');
    await stateOf(e, d.lots[1].id, 'withdrawn', ', closed_at = now()');
    await stateOf(e, d.lots[2].id, 'sold', ', closed_at = now()');
    const buyer = await e.profile();
    await e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status) select id, $2, seller_id, 50000000, 1000000, 49000000, 'settled' from lots where id = $1`, [d.lots[2].id, buyer.id]);
    await expect(list(e, a.id, [mint(1), mint(2), mint(3)], 'Second chance')).resolves.toBeTruthy();
  });

  t('sold but still being paid: the card is promised to the buyer, so it is listed until the payment round ends unpaid', async (e) => {
    const a = await e.profile(); const buyer = await e.profile();
    const d = await list(e, a.id, [mint(1)]);
    await stateOf(e, d.lots[0].id, 'sold', ', closed_at = now()');
    await e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status) select id, $2, seller_id, 50000000, 1000000, 49000000, 'awaiting_payment' from lots where id = $1`, [d.lots[0].id, buyer.id]);
    expect((await fail(list(e, a.id, [mint(1)]))).code).toBe('already_listed');
    await e.pool.query(`update settlements set status = 'expired'`);
    await expect(list(e, a.id, [mint(1)])).resolves.toBeTruthy();
  });

  t('two requests for the same card at the same moment: exactly one wins', async (e) => {
    const a = await e.profile(); const b = await e.profile();
    const res = await Promise.allSettled([list(e, a.id, [mint(5)], 'One'), list(e, b.id, [mint(5)], 'Two'), list(e, a.id, [mint(5)], 'Three')]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') expect((r.reason as ApiError).code).toBe('already_listed');
    expect(Number((await e.pool.query(`select count(*)::int n from lots where mint_address = $1`, [mint(5)])).rows[0].n)).toBe(1);
  });

  t('a card in a pack pool cannot be listed in a room, until the pack is closed', async (e) => {
    const a = await e.profile();
    const { rows: [pack] } = await e.pool.query(
      `insert into pack_definitions (operator_profile_id, operator_wallet, name, mode, cluster, price, odds, status) values ($1,$2,'{"de":"P","en":"P"}','chance','devnet',1000000,'[]','live') returning id`, [a.id, a.wallet]);
    await e.pool.query(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1,$2,'common','Pool card',0)`, [pack.id, mint(9)]);
    const err = await fail(list(e, a.id, [mint(9)]));
    expect(err.code).toBe('already_listed');
    expect(err.extra).toMatchObject({ listing: { kind: 'pack', packId: pack.id } });
    await e.pool.query(`update pack_definitions set status = 'closed' where id = $1`, [pack.id]);
    await expect(list(e, a.id, [mint(9)])).resolves.toBeTruthy();
  });

  t('a card drawn from a pack whose delivery is still pending stays listed', async (e) => {
    const a = await e.profile(); const buyer = await e.profile();
    const { rows: [pack] } = await e.pool.query(
      `insert into pack_definitions (operator_profile_id, operator_wallet, name, mode, cluster, price, odds, status) values ($1,$2,'{"de":"P","en":"P"}','chance','devnet',1000000,'[]','closed') returning id`, [a.id, a.wallet]);
    await e.pool.query(`insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, age_confirmed_at, client_seed, asset, price, status) values ($1,$2,$3,'devnet',now(),'s',$4,1000000,'delivering')`, [pack.id, buyer.id, buyer.wallet, mint(8)]);
    expect((await fail(list(e, a.id, [mint(8)]))).code).toBe('already_listed');
  });
});

describe('GET /api/sell/assets flags what is already offered', () => {
  t('a listed card is not eligible, carries where it is, and a free card is as before', async (e) => {
    const { createSellService } = await import('@/server/settlement/sell');
    const { db } = await import('@/db');
    const a = await e.profile();
    for (const n of [1, 2, 3]) await e.pool.query(`insert into devnet_assets (mint, owner_wallet, name, image_url, attributes) values ($1,$2,$3,'https://img.example/x.png','[]')`, [mint(n), a.wallet, `Card ${n}`]);
    const d = await list(e, a.id, [mint(1)]);
    const { rows: [pack] } = await e.pool.query(
      `insert into pack_definitions (operator_profile_id, operator_wallet, name, mode, cluster, price, odds, status) values ($1,$2,'{"de":"P","en":"P"}','chance','devnet',1000000,'[]','draft') returning id`, [a.id, a.wallet]);
    await e.pool.query(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1,$2,'common','x',0)`, [pack.id, mint(2)]);
    const info = (m: string) => ({ mint: m, standard: 'core' as const, owner: a.wallet, collection: null, name: 'c', imageUrl: null, frozen: false, compressed: false, burnt: false, royaltyBlocksOwnerTransfer: false, blockingDelegate: null });
    const svc = createSellService({ db, chainFor: () => ({ readAsset: async (m: string) => info(m) }) });
    const out = SellAssetsResponse.parse({ assets: await svc.listAssets({ wallet: a.wallet, profileId: a.id, cluster: 'devnet' }) }).assets;
    const by = (m: string) => out.find((x) => x.mint === m)!;
    expect(by(mint(1))).toMatchObject({ eligible: false, reasons: ['already_listed'], listed: { kind: 'lot', showId: d.show.id } });
    expect(by(mint(2))).toMatchObject({ eligible: false, reasons: ['already_listed'], listed: { kind: 'pack', packId: pack.id } });
    expect(by(mint(3))).toMatchObject({ eligible: true, reasons: [], listed: null });
    // the lot ends unsold: the card is selectable again
    await e.pool.query(`update lots set state = 'passed', closed_at = now() where id = $1`, [d.lots[0].id]);
    const again = await svc.listAssets({ wallet: a.wallet, profileId: a.id, cluster: 'devnet' });
    expect(again.find((x) => x.mint === mint(1))).toMatchObject({ eligible: true, listed: null });
  });
});
