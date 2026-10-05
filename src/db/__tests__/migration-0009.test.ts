/**
 * Migration 0009 (the waiting list) on a throwaway embedded Postgres: additive on top of 0008 (existing rows survive), idempotent, the
 * database and src/db/schema.ts agree about `waitlist`, one address is one row whatever its case.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as schema from '../schema';
import { MIGRATIONS_DIR, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const FILE = path.join(MIGRATIONS_DIR, '0009_waitlist.sql');
let t: TestPg | undefined, skipReason: string | undefined;

beforeAll(async () => {
  const r = await startTestPg({ upTo: '0009' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  await t.pool.query(`insert into profiles (wallet_address) values ('So11111111111111111111111111111111111111112')`);
}, 120_000);
afterAll(async () => { await t?.stop(); });
const step = (name: string, fn: () => Promise<void>, timeout = 30_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);
const q = async (sql: string, args: unknown[] = []) => (await t!.pool.query(sql, args)).rows;

describe('migration 0009', () => {
  step('applies on top of 0008 and leaves the existing data untouched', async () => {
    await runSqlFile(t!.pool, FILE);
    expect((await q(`select count(*)::int c from profiles`))[0].c).toBe(1);
    expect((await q(`select count(*)::int c from waitlist`))[0].c).toBe(0);
  });

  step('is idempotent', async () => {
    await runSqlFile(t!.pool, FILE);
    await runSqlFile(t!.pool, FILE);
    expect((await q(`select count(*)::int c from pg_indexes where indexname = 'waitlist_email_lower_idx'`))[0].c).toBe(1);
  });

  step('the database and schema.ts agree about waitlist', async () => {
    const cols = (await q(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'waitlist'`)).map((r) => r.column_name).sort();
    expect(cols).toEqual(Object.values(getTableColumns(schema.waitlist)).map((c) => c.name).sort());
  });

  step('one address is one row whatever its case', async () => {
    await q(`insert into waitlist (email, locale) values ('Ada@Example.com', 'en')`);
    await expect(q(`insert into waitlist (email, locale) values ('ada@example.COM', 'de')`)).rejects.toMatchObject({ code: '23505' });
  });
});
