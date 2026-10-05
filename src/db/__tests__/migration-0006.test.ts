/**
 * Migration 0006 (the seller's pause) on a throwaway embedded Postgres, never a real database:
 *   - it is additive: a show and a lot written at migration 0005 survive untouched and read as "running, no pause used, no paused time",
 *   - it is idempotent: applying the file again changes nothing and does not fail,
 *   - the database and src/db/schema.ts agree about the three new columns,
 *   - code that predates it (an insert that does not know the columns) keeps working.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '../schema';
import { MIGRATIONS_DIR, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const FILE = path.join(MIGRATIONS_DIR, '0006_rostrum.sql');
let t: TestPg | undefined, skipReason: string | undefined;
let showId = '', lotId = '', profileId = '';

const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows;
beforeAll(async () => {
  const r = await startTestPg({ upTo: '0006' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  profileId = (await q(`insert into profiles (wallet_address) values ('So11111111111111111111111111111111111111112') returning id`))[0].id;
  showId = (await q(`insert into shows (seller_id, title, status, settlement_mode) values ($1, 'Old show', 'live', 'onchain') returning id`, [profileId]))[0].id;
  lotId = (await q(`insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price, state) values ($1, $2, 1, 'MintOld', 'core', 'Old lot', 1, 1, 'open') returning id`, [showId, profileId]))[0].id;
}, 120_000);
afterAll(async () => { await t?.stop(); });
const step = (name: string, fn: () => Promise<void>, timeout = 30_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

describe('migration 0006', () => {
  step('applies on top of 0005 and leaves old rows running, with no pause used and no paused time', async () => {
    await runSqlFile(t!.pool, FILE);
    expect((await q(`select paused_at, pause_count from shows where id = $1`, [showId]))[0]).toEqual({ paused_at: null, pause_count: 0 });
    expect((await q(`select paused_ms::text as paused_ms, state, name from lots where id = $1`, [lotId]))[0]).toEqual({ paused_ms: '0', state: 'open', name: 'Old lot' });
  });

  step('is idempotent: a second application changes nothing and does not fail', async () => {
    const snapshot = async () => JSON.stringify(await q(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`))
      + JSON.stringify(await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`));
    const before = await snapshot();
    await runSqlFile(t!.pool, FILE);
    await runSqlFile(t!.pool, FILE);
    expect(await snapshot()).toBe(before);
    expect((await q(`select count(*)::int c from shows`))[0].c).toBe(1);
  });

  step('the database and schema.ts agree about the new columns', async () => {
    const dbCols = async (table: string) => (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).map((r) => r.column_name).sort();
    expect(await dbCols('shows')).toEqual(Object.values(getTableColumns(schema.shows)).map((c) => c.name).sort());
    expect(await dbCols('lots')).toEqual(Object.values(getTableColumns(schema.lots)).map((c) => c.name).sort());
    const info = (await q(`select column_name, is_nullable, column_default from information_schema.columns where (table_name, column_name) in (('shows','paused_at'),('shows','pause_count'),('lots','paused_ms')) order by column_name`));
    expect(info).toEqual([
      { column_name: 'pause_count', is_nullable: 'NO', column_default: '0' },
      { column_name: 'paused_at', is_nullable: 'YES', column_default: null },
      { column_name: 'paused_ms', is_nullable: 'NO', column_default: '0' },
    ]);
  });

  step('an insert written before the migration (that does not name the columns) still works', async () => {
    const s = (await q(`insert into shows (seller_id, title) values ($1, 'Written by old code') returning pause_count, paused_at`, [profileId]))[0];
    expect(s).toEqual({ pause_count: 0, paused_at: null });
  });
});
