/**
 * Migration 0007 (packs: the third-party operator delivers, A14) on a throwaway embedded Postgres, never a real database:
 *   - it is additive: a pack draw written at migration 0005 survives untouched, its new columns are null,
 *   - it is idempotent: applying the file again changes nothing and does not fail,
 *   - the database and src/db/schema.ts agree about pack_draws,
 *   - the new rule holds: a card is held by one draw also while that draw is `undelivered`.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '../schema';
import { MIGRATIONS_DIR, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const FILE = path.join(MIGRATIONS_DIR, '0007_pack_third_party_delivery.sql');
let t: TestPg | undefined, skipReason: string | undefined;
let profileId = '', packId = '', cardA = '', oldDraw = '';

beforeAll(async () => {
  const r = await startTestPg({ upTo: '0007' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows[0];
  profileId = (await q(`insert into profiles (wallet_address) values ('So11111111111111111111111111111111111111112') returning id`)).id;
  packId = (await q(`insert into pack_definitions (operator_profile_id, operator_wallet, name, mode, cluster, price, odds) values ($1, 'W', '{"de":"a","en":"a"}', 'chance', 'devnet', 5000000, '[]') returning id`, [profileId])).id;
  cardA = (await q(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1, 'AssetA', 'common', 'A', 0) returning id`, [packId])).id;
  oldDraw = (await q(`insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, draw_index, age_confirmed_at, client_seed, price, status, flow, card_id, asset, tx_signature) values ($1, $2, 'B', 'devnet', 0, now(), 'seed', 5000000, 'drawn', 'pay_first', $3, 'AssetA', 'sig-old') returning id`, [packId, profileId, cardA])).id;
}, 120_000);
afterAll(async () => { await t?.stop(); });
const step = (name: string, fn: () => Promise<void>, timeout = 30_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);
const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows;

describe('migration 0007', () => {
  step('applies on top of 0006 and leaves the old draw untouched, the new columns empty', async () => {
    await runSqlFile(t!.pool, FILE);
    const [row] = await q(`select status, flow, draw_index, tx_signature, deliver_by, undelivered_at, undelivered_reason, strike_at from pack_draws where id = $1`, [oldDraw]);
    expect(row).toEqual({ status: 'drawn', flow: 'pay_first', draw_index: 0, tx_signature: 'sig-old', deliver_by: null, undelivered_at: null, undelivered_reason: null, strike_at: null });
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

  step('the database and schema.ts agree about pack_draws', async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'pack_draws'`)).map((r) => r.column_name).sort();
    expect(cols).toEqual(Object.values(getTableColumns(schema.packDraws)).map((c) => c.name).sort());
  });

  step('a card is held by one draw also while the draw is undelivered; a refunded or expired draw does not hold it', async () => {
    const insert = (status: string, tx: string, card: string | null) => q(
      `insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, draw_index, age_confirmed_at, client_seed, price, status, flow, card_id, tx_signature) values ($1, $2, 'B', 'devnet', null, now(), $3, 5000000, $4, 'pay_first', $5, $6) returning id`,
      [packId, profileId, `seed-${tx}`, status, card, tx]);
    await q(`update pack_draws set status = 'undelivered', undelivered_reason = 'deadline', undelivered_at = now() where id = $1`, [oldDraw]);
    await expect(insert('undelivered', 'sig-u-1', cardA)).rejects.toMatchObject({ code: '23505' });
    await expect(insert('drawn', 'sig-u-2', cardA)).rejects.toMatchObject({ code: '23505' }); // an undelivered draw still holds its card
    await insert('expired', 'sig-u-3', cardA);
    await insert('refunded', 'sig-u-4', cardA);
    await q(`update pack_draws set status = 'refunded' where id = $1`, [oldDraw]);
    await insert('drawn', 'sig-u-5', cardA); // free again once that draw is over
  });
});
