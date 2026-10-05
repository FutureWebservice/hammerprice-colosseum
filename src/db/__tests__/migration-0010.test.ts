/**
 * Migration 0010 (profile page: avatar columns, case-insensitive unique username) on a throwaway embedded Postgres:
 * additive (an old profile survives untouched), idempotent, and the database and src/db/schema.ts agree about profiles.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '../schema';
import { MIGRATIONS_DIR, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const FILE = path.join(MIGRATIONS_DIR, '0010_profile_avatar_username.sql');
let t: TestPg | undefined, skipReason: string | undefined;
beforeAll(async () => {
  const r = await startTestPg({ upTo: '0010' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  await t.pool.query(`insert into profiles (wallet_address, bio) values ('So11111111111111111111111111111111111111112', 'old bio')`);
}, 120_000);
afterAll(async () => { await t?.stop(); });
const step = (name: string, fn: () => Promise<void>) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, 30_000);
const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows;

describe('migration 0010', () => {
  step('applies on top of 0008 and leaves the old profile untouched, the new columns empty', async () => {
    await runSqlFile(t!.pool, FILE);
    expect((await q(`select bio, username, avatar, avatar_type from profiles`))[0]).toEqual({ bio: 'old bio', username: null, avatar: null, avatar_type: null });
  });

  step('is idempotent', async () => {
    const snapshot = async () => JSON.stringify(await q(`select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'public' order by table_name, column_name`))
      + JSON.stringify(await q(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`))
      + JSON.stringify(await q(`select conname from pg_constraint where connamespace = 'public'::regnamespace order by conname`));
    const before = await snapshot();
    await runSqlFile(t!.pool, FILE);
    await runSqlFile(t!.pool, FILE);
    expect(await snapshot()).toBe(before);
  });

  step('the database and schema.ts agree about profiles', async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles'`)).map((r) => r.column_name).sort();
    expect(cols).toEqual(Object.values(getTableColumns(schema.profiles)).map((c) => c.name).sort());
  });

  step('a username is unique without regard to case', async () => {
    await q(`insert into profiles (wallet_address, username) values ('W1', 'Anna_1')`);
    await expect(q(`insert into profiles (wallet_address, username) values ('W2', 'anna_1')`)).rejects.toMatchObject({ code: '23505' });
    await q(`insert into profiles (wallet_address, username) values ('W3', null)`);
    await q(`insert into profiles (wallet_address, username) values ('W4', null)`); // many accounts without one
  });
});
