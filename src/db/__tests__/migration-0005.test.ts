/**
 * Migration 0005 (packs: pay first, draw after) on a throwaway embedded Postgres, never a real database:
 *   - it is additive: a pack draw written at migration 0004 survives untouched, takes flow 'atomic' and keeps its draw index,
 *   - it relaxes `draw_index` (a purchase has no index until its draw) without dropping anything,
 *   - it is idempotent: applying the file again changes nothing and does not fail,
 *   - the database and src/db/schema.ts agree about pack_draws,
 *   - the constraints the money rules lean on exist: one transaction id per payment, delivery and refund, one live draw per card.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '../schema';
import { MIGRATIONS_DIR, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const FILE = path.join(MIGRATIONS_DIR, '0005_pack_pay_first.sql');
let t: TestPg | undefined, skipReason: string | undefined;
let profileId = '', packId = '', cardA = '', cardB = '', oldDraw = '';

beforeAll(async () => {
  const r = await startTestPg({ upTo: '0005' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows[0];
  profileId = (await q(`insert into profiles (wallet_address) values ('So11111111111111111111111111111111111111112') returning id`)).id;
  packId = (await q(`insert into pack_definitions (operator_profile_id, operator_wallet, name, mode, cluster, price, odds) values ($1, 'W', '{"de":"a","en":"a"}', 'chance', 'devnet', 5000000, '[]') returning id`, [profileId])).id;
  cardA = (await q(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1, 'AssetA', 'common', 'A', 0) returning id`, [packId])).id;
  cardB = (await q(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1, 'AssetB', 'common', 'B', 1) returning id`, [packId])).id;
  // a draw as production has it at migration 0004 (atomic flow)
  oldDraw = (await q(`insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, draw_index, age_confirmed_at, client_seed, price, status, card_id, asset, tx_signature) values ($1, $2, 'B', 'devnet', 0, now(), 'seed', 5000000, 'settled', $3, 'AssetA', 'sig-old') returning id`, [packId, profileId, cardA])).id;
}, 120_000);
afterAll(async () => { await t?.stop(); });
const step = (name: string, fn: () => Promise<void>, timeout = 30_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);
const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows;
const insertDraw = (status: string, o: { card?: string | null; delivery?: string | null; refund?: string | null; tx?: string | null; index?: number | null } = {}) => q(
  `insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, draw_index, age_confirmed_at, client_seed, price, status, flow, card_id, tx_signature, delivery_signature, refund_signature) values ($1, $2, 'B', 'devnet', $3, now(), $4, 5000000, $5, 'pay_first', $6, $7, $8, $9) returning id`,
  [packId, profileId, o.index ?? null, `seed-${Math.random()}`, status, o.card ?? null, o.tx ?? null, o.delivery ?? null, o.refund ?? null]);

describe('migration 0005', () => {
  step('applies on top of 0004, leaves the old draw untouched and gives it the atomic flow', async () => {
    await runSqlFile(t!.pool, FILE);
    const [row] = await q(`select status, draw_index, flow, tx_signature, payment_slot, paid_at, delivery_signature, refund_signature, server_tx, delivery_attempts, refund_attempts, next_attempt_at, refund_reason from pack_draws where id = $1`, [oldDraw]);
    expect(row).toEqual({ status: 'settled', draw_index: 0, flow: 'atomic', tx_signature: 'sig-old', payment_slot: null, paid_at: null, delivery_signature: null, refund_signature: null, server_tx: null, delivery_attempts: 0, refund_attempts: 0, next_attempt_at: null, refund_reason: null });
  });

  step('is idempotent: a second application changes nothing and does not fail', async () => {
    const snapshot = async () => JSON.stringify(await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`))
      + JSON.stringify(await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`))
      + JSON.stringify(await q(`select conname from pg_constraint where connamespace = 'public'::regnamespace order by conname`));
    const before = await snapshot();
    await runSqlFile(t!.pool, FILE);
    await runSqlFile(t!.pool, FILE);
    expect(await snapshot()).toBe(before);
    expect((await q(`select count(*)::int c from pack_draws`))[0].c).toBe(1);
  });

  step('the database and schema.ts agree about pack_draws, and draw_index is nullable', async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pack_draws'`)).map((r) => r.column_name).sort();
    const LATER = ['deliver_by', 'undelivered_at', 'undelivered_reason', 'strike_at']; // added by 0006
    expect(cols).toEqual(Object.values(getTableColumns(schema.packDraws)).map((c) => c.name).filter((n) => !LATER.includes(n)).sort());
    expect((await q(`select is_nullable from information_schema.columns where table_name = 'pack_draws' and column_name = 'draw_index'`))[0].is_nullable).toBe('YES');
    expect(schema.packDraws.drawIndex.notNull).toBe(false);
  });

  step('purchases without a draw index coexist, an index is still unique per pack once it is set', async () => {
    await insertDraw('awaiting_payment');
    await insertDraw('awaiting_payment');
    await insertDraw('paid', { tx: 'sig-pay-1', index: null });
    await expect(insertDraw('settled', { index: 0, card: cardB })).rejects.toMatchObject({ code: '23505' }); // draw index 0 of this pack is taken by the old draw
    const [d] = await insertDraw('drawn', { index: 1, card: cardB, tx: 'sig-pay-2' });
    expect(d.id).toBeTruthy();
  });

  step('one transaction id belongs to one payment, one delivery and one refund', async () => {
    await expect(insertDraw('paid', { tx: 'sig-pay-1' })).rejects.toMatchObject({ code: '23505' });
    await insertDraw('delivering', { delivery: 'sig-del-1', tx: 'sig-pay-3', card: null });
    await expect(insertDraw('delivering', { delivery: 'sig-del-1', tx: 'sig-pay-4' })).rejects.toMatchObject({ code: '23505' });
    await insertDraw('refunding', { refund: 'sig-ref-1', tx: 'sig-pay-5' });
    await expect(insertDraw('refunding', { refund: 'sig-ref-1', tx: 'sig-pay-6' })).rejects.toMatchObject({ code: '23505' });
  });

  step('a card is held by one live draw only, delivered or not, and is free again once refunded', async () => {
    // cardA is held by the old settled draw; cardB by the drawn one above
    await expect(insertDraw('drawn', { card: cardA, tx: 'sig-pay-7' })).rejects.toMatchObject({ code: '23505' });
    await expect(insertDraw('delivering', { card: cardB, tx: 'sig-pay-8' })).rejects.toMatchObject({ code: '23505' });
    await expect(insertDraw('refund_pending', { card: cardB, tx: 'sig-pay-9' })).rejects.toMatchObject({ code: '23505' });
    await insertDraw('refunded', { card: cardB, tx: 'sig-pay-10' }); // a refunded draw does not hold it
    await insertDraw('expired', { card: cardB, tx: 'sig-pay-11' });
    await q(`update pack_draws set status = 'refunded' where tx_signature = 'sig-pay-2'`);
    await insertDraw('drawn', { card: cardB, tx: 'sig-pay-12', index: 2 }); // free again after the refund
  });
});
