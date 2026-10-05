/**
 * Migration 0003 (the optional features) on a throwaway embedded Postgres, never a real database:
 *   - it is additive: rows written at migration 0002 survive untouched and take the new columns' defaults,
 *   - it is idempotent: applying the file a second time (or on a database that has part of it) changes nothing and does not fail,
 *   - the database and src/db/schema.ts agree about every new column and table,
 *   - the constraints the features lean on exist (one draw per subject, one ledger booking per (reason, ref), one chat nonce per author,
 *     one live draw per pool card and one draw index per pack).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as schema from '../schema';
import { MIGRATIONS_DIR, runSqlFile, startTestPg, type TestPg } from './pg-harness';

const FILE = path.join(MIGRATIONS_DIR, '0003_features.sql');
let t: TestPg | undefined, skipReason: string | undefined;
let showId = '', lotId = '', profileId = '';

beforeAll(async () => {
  const r = await startTestPg({ upTo: '0003' });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  // Rows as production has them at migration 0002.
  profileId = (await t.pool.query(`insert into profiles (wallet_address) values ('So11111111111111111111111111111111111111112') returning id`)).rows[0].id;
  showId = (await t.pool.query(`insert into shows (seller_id, title) values ($1, 'Old show') returning id`, [profileId])).rows[0].id;
  lotId = (await t.pool.query(`insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price) values ($1, $1, 1, 'M', 'core', 'Old lot', 1, 1) returning id`.replace('$1, $1', '$1, $2'), [showId, profileId])).rows[0].id;
  await t.pool.query(`insert into chat_messages (show_id, author_id, body) values ($1, $2, 'from the inherited app'), ($1, $2, 'second')`, [showId, profileId]);
}, 120_000);
afterAll(async () => { await t?.stop(); });
const step = (name: string, fn: () => Promise<void>, timeout = 30_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

describe('migration 0003', () => {
  step('applies on top of 0002 and leaves old rows untouched with the new defaults', async () => {
    await runSqlFile(t!.pool, FILE);
    const show = (await t!.pool.query(`select title, kind, order_mode, video_enabled from shows where id = $1`, [showId])).rows[0];
    expect(show).toEqual({ title: 'Old show', kind: 'live', order_mode: 'catalogue', video_enabled: false });
    const lot = (await t!.pool.query(`select name, description, ai_assisted from lots where id = $1`, [lotId])).rows[0];
    expect(lot).toEqual({ name: 'Old lot', description: null, ai_assisted: false });
    const chat = (await t!.pool.query(`select body, seq::int, role, status, client_nonce from chat_messages order by seq`)).rows;
    expect(chat.map((c) => c.body)).toEqual(['from the inherited app', 'second']);
    expect(chat.map((c) => c.seq)).toEqual([1, 2]); // the identity column numbered the old rows; they are pending, so none is public
    expect(chat[0]).toMatchObject({ role: 'bidder', status: 'pending', client_nonce: null });
  });

  step('is idempotent: a second application changes nothing and does not fail', async () => {
    const snapshot = async () => JSON.stringify((await t!.pool.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name`)).rows)
      + JSON.stringify((await t!.pool.query(`select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname`)).rows)
      + JSON.stringify((await t!.pool.query(`select conname from pg_constraint where connamespace = 'public'::regnamespace order by conname`)).rows);
    const before = await snapshot();
    await runSqlFile(t!.pool, FILE);
    await runSqlFile(t!.pool, FILE);
    expect(await snapshot()).toBe(before);
    expect((await t!.pool.query(`select count(*)::int c from chat_messages`)).rows[0].c).toBe(2);
  });

  step('every table and column of the new schema exists in the database, and nothing else was invented', async () => {
    const NEW = [schema.vrfRequests, schema.packDefinitions, schema.packPoolCards, schema.packDraws, schema.packPurchaseCounts, schema.creditPurchases, schema.creditLedger, schema.aiUsage, schema.chatReports, schema.chatMutes];
    // columns that a LATER migration added (0005: the pay-first flow of pack_draws, 0006: the delivery deadline of third-party packs) are not in the database at 0003
    const LATER: Record<string, string[]> = { pack_draws: ['flow', 'payment_slot', 'paid_at', 'drawn_at', 'refunded_at', 'delivery_signature', 'refund_signature', 'server_tx', 'server_last_valid', 'delivery_attempts', 'refund_attempts', 'next_attempt_at', 'refund_reason', 'deliver_by', 'undelivered_at', 'undelivered_reason', 'strike_at'] };
    for (const table of NEW) {
      const cols = (await t!.pool.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [getTableName(table)])).rows.map((r) => r.column_name).sort();
      expect(cols, getTableName(table)).toEqual(Object.values(getTableColumns(table)).map((c) => c.name).filter((n) => !(LATER[getTableName(table)] ?? []).includes(n)).sort());
    }
    for (const [table, names] of [['shows', ['kind', 'order_mode', 'video_enabled']], ['lots', ['description', 'ai_assisted']], ['chat_messages', ['seq', 'lot_id', 'paddle_number', 'lot_number', 'role', 'source', 'status', 'moderated_at', 'moderated_by', 'hidden_reason', 'client_nonce']]] as const) {
      const have = new Set((await t!.pool.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table])).rows.map((r) => r.column_name));
      for (const n of names) expect(have.has(n), `${table}.${n}`).toBe(true);
    }
    const lotsCols = Object.values(getTableColumns(schema.lots)).map((c) => c.name).filter((n) => n !== 'paused_ms'); // 0006 (the seller's pause) adds lots.paused_ms later
    const dbLots = (await t!.pool.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'lots'`)).rows.map((r) => r.column_name);
    expect(dbLots.sort()).toEqual(lotsCols.sort());
  });

  step('a draw is unique per (purpose, subject), and the ledger books each (reason, ref) once', async () => {
    const ins = `insert into vrf_requests (purpose, subject_type, subject_id, cluster, public_key, params, params_hash, reveal_by) values ('lot_order', 'show', $1, 'devnet', 'K', '{}', 'h', now())`;
    await t!.pool.query(ins, [showId]);
    await expect(t!.pool.query(ins, [showId])).rejects.toMatchObject({ code: '23505' });
    const row = (await t!.pool.query(`select status, attempts, lease_until, commit_tx_b64 from vrf_requests`)).rows[0];
    expect(row).toEqual({ status: 'pending', attempts: 0, lease_until: null, commit_tx_b64: null });

    const book = `insert into credit_ledger (profile_id, delta, reason, ref) values ($1, 10, 'purchase', 'p1')`;
    await t!.pool.query(book, [profileId]);
    await expect(t!.pool.query(book, [profileId])).rejects.toMatchObject({ code: '23505' });
    await t!.pool.query(`insert into credit_ledger (profile_id, delta, reason, ref) values ($1, -1, 'usage', 'p1')`, [profileId]); // another reason, same ref: fine
    expect((await t!.pool.query(`select sum(delta)::int s from credit_ledger where profile_id = $1`, [profileId])).rows[0].s).toBe(9);
  });

  step('a chat message is stored once per author and client nonce; a nonce-less message is never blocked', async () => {
    const ins = `insert into chat_messages (show_id, author_id, body, client_nonce) values ($1, $2, 'hi', $3)`;
    await t!.pool.query(ins, [showId, profileId, 'n1']);
    await expect(t!.pool.query(ins, [showId, profileId, 'n1'])).rejects.toMatchObject({ code: '23505' });
    await t!.pool.query(`insert into chat_messages (show_id, author_id, body) values ($1, $2, 'a'), ($1, $2, 'a')`, [showId, profileId]);
  });

  step('chat is pre-moderated: a new message is pending, and a mute or block is one row per show and wallet', async () => {
    const id = (await t!.pool.query(`insert into chat_messages (show_id, author_id, body) values ($1, $2, 'new') returning id`, [showId, profileId])).rows[0].id;
    expect((await t!.pool.query(`select status, moderated_at, moderated_by, source from chat_messages where id = $1`, [id])).rows[0]).toEqual({ status: 'pending', moderated_at: null, moderated_by: null, source: 'user' });
    const mute = `insert into chat_mutes (show_id, profile_id, kind, until, reason, by) values ($1, $2, $3, $4, 'spam', $2)`;
    await t!.pool.query(mute, [showId, profileId, 'block', null]); // a block has no end
    await expect(t!.pool.query(mute, [showId, profileId, 'mute', new Date()])).rejects.toMatchObject({ code: '23505' });
  });

  step('packs: one draw index per pack, one live draw per card, a daily counter per wallet and pack, and the pool list is unique per asset', async () => {
    const pack = (await t!.pool.query(`insert into pack_definitions (operator_profile_id, operator_wallet, name, mode, cluster, price, odds) values ($1, 'W', '{"de":"a","en":"a"}', 'chance', 'devnet', 5000000, '[]') returning id, status, per_wallet_daily_cap, is_house, pool_hash`, [profileId])).rows[0];
    expect(pack).toMatchObject({ status: 'draft', per_wallet_daily_cap: 5, is_house: false, pool_hash: null });
    const card = (await t!.pool.query(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1, 'A1', 'rare', 'c', 0) returning id, status`, [pack.id])).rows[0];
    expect(card.status).toBe('available');
    await expect(t!.pool.query(`insert into pack_pool_cards (pack_id, asset, tier, name, position) values ($1, 'A1', 'rare', 'again', 1)`, [pack.id])).rejects.toMatchObject({ code: '23505' });
    const draw = `insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, draw_index, age_confirmed_at, client_seed, card_id, price, status) values ($1, $2, 'B', 'devnet', $3, now(), 's', $4, 5000000, $5)`;
    await t!.pool.query(draw, [pack.id, profileId, 0, card.id, 'reserved']);
    await expect(t!.pool.query(draw, [pack.id, profileId, 0, null, 'reserved'])).rejects.toMatchObject({ code: '23505' }); // the same index twice
    await expect(t!.pool.query(draw, [pack.id, profileId, 1, card.id, 'reserved'])).rejects.toMatchObject({ code: '23505' }); // the same card in a second live draw
    await t!.pool.query(`update pack_draws set status = 'expired' where draw_index = 0`);
    await t!.pool.query(draw, [pack.id, profileId, 1, card.id, 'reserved']); // an expired draw frees the card
    const count = `insert into pack_purchase_counts (wallet, pack_id, day, count) values ('B', $1, '2026-10-05', 1)`;
    await t!.pool.query(count, [pack.id]);
    await expect(t!.pool.query(count, [pack.id])).rejects.toMatchObject({ code: '23505' });
  });

  it('the file is additive by the repository check and carries no destructive word', () => {
    const sql = fs.readFileSync(FILE, 'utf8').replace(/^--.*$/gm, '');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|RENAME|DELETE\s+FROM)\b/i);
    for (const stmt of sql.split('--> statement-breakpoint').map((x) => x.trim()).filter(Boolean)) {
      expect(stmt, stmt.slice(0, 60)).toMatch(/^(CREATE TABLE IF NOT EXISTS|CREATE (UNIQUE )?INDEX IF NOT EXISTS|ALTER TABLE "\w+" ADD COLUMN IF NOT EXISTS|DO \$\$ BEGIN ALTER TABLE "\w+" ADD CONSTRAINT)/);
    }
  });
});
