/**
 * Migration 0002 against the PRODUCTION DATA SHAPE, on a throwaway embedded Postgres (never the real database).
 *
 *   PROD_DUMP=/path/to/prod-backup.json npx vitest --run src/db/__tests__/prod-shape.test.ts
 *
 * The dump is the JSON export of the production tables ({ table: { columns, rows } }). It is private data and is not in the
 * repository, so the test is skipped without PROD_DUMP. Loads it at migration 0001, applies 0002, then proves:
 *   - every row survives untouched (row counts AND a checksum over the old columns),
 *   - the new columns took their defaults on the old rows,
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrationFiles, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const DUMP = process.env.PROD_DUMP;
type Dump = Record<string, { columns: { column_name: string }[]; rows: Record<string, unknown>[] }>;
// Parents before children.
const ORDER = ['profiles', 'shows', 'lots', 'bids', 'settlements', 'show_events', 'chat_messages', 'show_presence', 'show_secrets', 'auth_nonces', 'audit_logs'];

let t: TestPg | undefined;
let skipReason: string | undefined = DUMP ? undefined : 'PROD_DUMP not set: production-shape check skipped';
let dump: Dump;
let oldCols: Record<string, string[]>;

const count = async (pool: Pool) => Object.fromEntries(await Promise.all(ORDER.map(async (tb) => [tb, (await pool.query(`select count(*)::int c from "${tb}"`)).rows[0].c as number])));
/** md5 over every row's OLD columns (rows compared as sorted JSON text, so no ordering column is needed). */
const checksum = async (pool: Pool) => Object.fromEntries(await Promise.all(ORDER.map(async (tb) => {
  const cols = oldCols[tb].map((c) => `"${c}"`).join(',');
  const { rows } = await pool.query(`select coalesce(md5(string_agg(j, '|' order by j)), '-') h from (select to_jsonb(x)::text j from (select ${cols} from "${tb}") x) y`);
  return [tb, rows[0].h as string];
})));

beforeAll(async () => {
  if (!DUMP) return;
  dump = JSON.parse(fs.readFileSync(DUMP, 'utf8'));
  oldCols = Object.fromEntries(ORDER.map((tb) => [tb, dump[tb].columns.map((c) => c.column_name)]));
  const r = await startTestPg({ upTo: '0002' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  for (const tb of ORDER) for (const row of dump[tb].rows) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
    await t.pool.query(`insert into "${tb}" (${cols.map((c) => `"${c}"`).join(',')}) ${tb === 'show_events' ? 'overriding system value' : ''} values (${cols.map((_, i) => `$${i + 1}`).join(',')})`, vals);
  }
  // A restored identity column keeps its sequence at 1, production's is already past the max.
  await t.pool.query(`select setval(pg_get_serial_sequence('show_events','id'), (select max(id) from show_events))`);
}, 180_000);
afterAll(async () => { await t?.stop(); });

const step = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

describe('migration 0002 on a copy of the production data', () => {
  let before: Record<string, number>; let sumBefore: Record<string, string>;

  step('the dump loaded at migration 0001', async () => {
    before = await count(t!.pool); sumBefore = await checksum(t!.pool);
    for (const tb of ORDER) expect(before[tb], tb).toBe(dump[tb].rows.length);
    console.log('rows before 0002:', JSON.stringify(before));
  });

  step('0002 applies and no row changes (counts and checksums of the old columns)', async () => {
    await runSqlFile(t!.pool, migrationFiles().find((f) => f.includes('0002_'))!);
    const after = await count(t!.pool);
    console.log('rows after  0002:', JSON.stringify(after));
    expect(after).toEqual(before);
    expect(await checksum(t!.pool)).toEqual(sumBefore);
  });

  step('new columns took their defaults on the old rows', async () => {
    const q = async (sql: string) => (await t!.pool.query(sql)).rows[0];
    expect(await q(`select count(*)::int n from shows where mode='auto' and settlement_mode='none' and cluster is null and is_house=false and rules='{}'::jsonb and scheduled_at is null and cancelled_at is null`)).toEqual({ n: before.shows });
    expect(await q(`select count(*)::int n from lots where consign_status='none' and bid_count=0 and closes_at is null and closed_reason is null and buy_now_price is null`)).toEqual({ n: before.lots });
    expect(await q(`select count(*)::int n from profiles where strikes=0 and is_bot=false`)).toEqual({ n: before.profiles });
  });
});
