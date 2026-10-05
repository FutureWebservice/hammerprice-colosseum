/**
 * The lock plan for bid acceptance, lazy closing, anti-sniping and "one open lot per show", proven on a REAL Postgres 18
 * (embedded-postgres, same major as Neon) against the NEW schema (migrations 0000..0002).
 *
 * The bid/advance/close logic below is plain SQL, exactly the algorithm that server/auction/service.ts
 * ports into drizzle; what this file pins down is the database side: the row lock, the partial unique indexes and the clock.
 * The tests are sequential steps of one story (one show, two lots).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { startTestPg, type TestPg } from './pg-harness';

const RULES = { lotDurationS: 6, snipeWindowS: 3, snipeExtendS: 4, maxExtensionS: 30, gapS: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextMin = (lot: { high_bid: string | null; opening_price: string; increment: string }) =>
  lot.high_bid === null ? BigInt(lot.opening_price) : BigInt(lot.high_bid) + BigInt(lot.increment);

let t: TestPg | undefined;
let skipReason: string | undefined;
let pool: Pool;
beforeAll(async () => {
  const r = await startTestPg();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg; pool = t.pool;
}, 120_000);
afterAll(async () => { await t?.stop(); });

// Sequential steps share state, so a skipped environment skips every step.
const step = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

// pg rows are untyped here; the columns used are the ones in the SQL above.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function closeDueLot(c: PoolClient, lot: Record<string, any>, nowTs: Date) {
  const high = lot.high_bid === null ? null : BigInt(lot.high_bid);
  const reserve = lot.reserve === null ? null : BigInt(lot.reserve);
  const sold = high !== null && (reserve === null || high >= reserve);
  const { rowCount } = await c.query(`update lots set state=$2, closed_at=closes_at, closed_reason='timer' where id=$1 and state='open'`, [lot.id, sold ? 'sold' : 'passed']);
  if (!rowCount) return null;
  if (sold) await c.query(
    `insert into settlements (lot_id,buyer_id,seller_id,gross_amount,platform_fee,seller_amount,due_at)
     values ($1,$2,$3,$4::bigint,($4::bigint*250/10000),($4::bigint-$4::bigint*250/10000),$5::timestamptz + interval '10 minutes') on conflict do nothing`,
    [lot.id, lot.high_bidder_id, lot.seller_id, lot.high_bid, nowTs]);
  await c.query(`insert into show_events (show_id, kind, payload) values ($1,$2,$3)`, [lot.show_id, sold ? 'lot.sold' : 'lot.passed', { lotId: lot.id, highBid: lot.high_bid }]);
  return sold ? 'sold' : 'passed';
}

async function placeBid(a: { lotId: string; bidderId: string; amount: bigint; nonce: string }): Promise<{ ok: boolean; code?: string; extended?: boolean; error?: string }> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const { rows: [lot] } = await c.query(`select l.*, clock_timestamp() as now_ts from lots l where l.id=$1 for update`, [a.lotId]);
    if (!lot || lot.state !== 'open') { await c.query('rollback'); return { ok: false, code: 'lot_not_open' }; }
    const now = lot.now_ts.getTime(); const closes = lot.closes_at.getTime();
    if (now >= closes) { await closeDueLot(c, lot, lot.now_ts); await c.query('commit'); return { ok: false, code: 'lot_closed' }; }
    if (lot.high_bidder_id === a.bidderId) { await c.query('rollback'); return { ok: false, code: 'already_high_bidder' }; }
    if (a.amount < nextMin(lot)) { await c.query('rollback'); return { ok: false, code: 'bid_too_low' }; }
    let newCloses = closes; let extended = false;
    if (closes - now <= RULES.snipeWindowS * 1000) {
      const cap = lot.opened_at.getTime() + (RULES.lotDurationS + RULES.maxExtensionS) * 1000;
      newCloses = Math.min(Math.max(closes, now + RULES.snipeExtendS * 1000), cap); extended = newCloses > closes;
    }
    await c.query(`insert into bids (lot_id,bidder_id,amount,signature,message,nonce,placed_at) values ($1,$2,$3,'s','m',$4,clock_timestamp())`, [a.lotId, a.bidderId, a.amount.toString(), a.nonce]);
    await c.query(`update lots set high_bid=$2, high_bidder_id=$3, bid_count=bid_count+1, closes_at=$4 where id=$1`, [a.lotId, a.amount.toString(), a.bidderId, new Date(newCloses)]);
    await c.query(`insert into show_events (show_id,kind,payload) values ($1,'bid.placed',$2)`, [lot.show_id, { lotId: a.lotId, amount: a.amount.toString() }]);
    if (extended) await c.query(`insert into show_events (show_id,kind,payload) values ($1,'lot.extended',$2)`, [lot.show_id, { lotId: a.lotId }]);
    await c.query('commit'); return { ok: true, extended };
  } catch (e) { await c.query('rollback').catch(() => {}); return { ok: false, code: 'error', error: (e as Error).message }; } finally { c.release(); }
}

// Serialised per show by locking the SHOW row; bids never take it, so a bid is never blocked by an advancer (lock order: show, then lot).
async function advanceShow(showId: string): Promise<string[]> {
  const c = await pool.connect(); const acts: string[] = [];
  try {
    await c.query('begin');
    await c.query(`select id from shows where id=$1 for update`, [showId]);
    const { rows: due } = await c.query(`select *, clock_timestamp() as now_ts from lots where show_id=$1 and state='open' and closes_at <= clock_timestamp() for update`, [showId]);
    for (const lot of due) acts.push((await closeDueLot(c, lot, lot.now_ts)) ?? 'noop');
    const { rows: [open] } = await c.query(`select id from lots where show_id=$1 and state='open'`, [showId]);
    if (!open) {
      const { rows: [last] } = await c.query(`select max(closed_at) as t from lots where show_id=$1`, [showId]);
      if (!last.t || Date.now() - last.t.getTime() >= RULES.gapS * 1000) {
        const { rows: [next] } = await c.query(`select id from lots where show_id=$1 and state='catalogued' order by lot_number limit 1 for update`, [showId]);
        if (next) {
          await c.query(`update lots set state='open', opened_at=clock_timestamp(), closes_at=clock_timestamp()+($2||' seconds')::interval where id=$1`, [next.id, RULES.lotDurationS]);
          await c.query(`insert into show_events (show_id,kind,payload) values ($1,'lot.opened',$2)`, [showId, { lotId: next.id }]); acts.push('opened');
        }
      }
    }
    await c.query('commit'); return acts;
  } catch (e) { await c.query('rollback').catch(() => {}); return ['error:' + (e as Error).message]; } finally { c.release(); }
}

describe('auction concurrency on Postgres 18 with the 0002 schema', () => {
  let show = ''; let lot1 = ''; let lot2 = ''; let seller = ''; const bidders: string[] = [];
  let highAfterA = 0n;

  step('migrations applied, real PG 18, the new columns and indexes exist', async () => {
    expect((await pool.query('show server_version')).rows[0].server_version).toMatch(/^18\./);
    const idx = (await pool.query(`select indexname from pg_indexes where indexname in ('lots_one_open_per_show','settlements_one_active_per_lot','settlements_tx_idx','bids_bidder_nonce_idx','paddles_show_number_idx')`)).rows.map((r) => r.indexname);
    expect(idx.sort()).toEqual(['bids_bidder_nonce_idx', 'lots_one_open_per_show', 'paddles_show_number_idx', 'settlements_one_active_per_lot', 'settlements_tx_idx']);
    const mk = async (w: string) => (await pool.query(`insert into profiles (wallet_address) values ($1) returning id`, [w])).rows[0].id as string;
    seller = await mk('SELLER');
    for (let i = 0; i < 30; i++) bidders.push(await mk('BIDDER' + i));
    show = (await pool.query(`insert into shows (seller_id,title,status,mode,settlement_mode) values ($1,'spike','live','auto','onchain') returning id`, [seller])).rows[0].id;
    const mkLot = async (n: number) => (await pool.query(`insert into lots (show_id,seller_id,lot_number,mint_address,nft_standard,name,reserve,increment,opening_price) values ($1,$2,$3::int,'MINT'||$3::text,'core','Lot '||$3::text,5000000,100000,1000000) returning id`, [show, seller, n])).rows[0].id as string;
    lot1 = await mkLot(1); lot2 = await mkLot(2);
    expect(await advanceShow(show)).toEqual(['opened']);
  });

  step('200 parallel bids: strictly increasing, high_bid == last accepted, bid_count == accepted', async () => {
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) =>
      placeBid({ lotId: lot1, bidderId: bidders[i % 30], amount: 1_000_000n + BigInt(i) * 100_000n, nonce: 'n' + i })));
    const accepted = results.filter((r) => r.ok).length;
    const codes = Object.fromEntries([...new Set(results.filter((r) => !r.ok).map((r) => r.code))].map((c) => [c, results.filter((r) => r.code === c).length]));
    expect(codes).not.toHaveProperty('error');
    expect(accepted).toBeGreaterThan(0);
    const amounts = (await pool.query(`select amount::text a from bids where lot_id=$1 order by placed_at, id`, [lot1])).rows.map((r) => BigInt(r.a));
    for (let i = 1; i < amounts.length; i++) expect(amounts[i]).toBeGreaterThan(amounts[i - 1]);
    const lot = (await pool.query(`select high_bid::text hb, bid_count from lots where id=$1`, [lot1])).rows[0];
    expect(BigInt(lot.hb)).toBe(amounts.at(-1));
    expect(lot.bid_count).toBe(amounts.length);
    expect(amounts.length).toBe(accepted);
    highAfterA = BigInt(lot.hb);
    console.log(`200 parallel bids -> accepted=${accepted} rejected=${JSON.stringify(codes)}`);
  });

  step('a bid inside the snipe window moves closes_at forward, never back', async () => {
    const before = (await pool.query(`select closes_at from lots where id=$1`, [lot1])).rows[0].closes_at.getTime();
    await sleep(Math.max(0, before - Date.now() - 1500));
    const snipe = await placeBid({ lotId: lot1, bidderId: bidders[29], amount: highAfterA + 200_000n, nonce: 'snipe' });
    const after = (await pool.query(`select closes_at from lots where id=$1`, [lot1])).rows[0].closes_at.getTime();
    expect(after).toBeGreaterThanOrEqual(before);
    if (snipe.ok) expect(snipe.extended).toBe(true);
    console.log(`snipe bid ok=${snipe.ok} closes_at moved +${after - before} ms`);
  });

  step('after the deadline 10 parallel late bids are all refused and the lot closes exactly once', async () => {
    const closes = (await pool.query(`select closes_at from lots where id=$1`, [lot1])).rows[0].closes_at.getTime();
    await sleep(Math.max(0, closes - Date.now() + 200));
    const late = await Promise.all(Array.from({ length: 10 }, (_, i) => placeBid({ lotId: lot1, bidderId: bidders[i], amount: 9_000_000n, nonce: 'late' + i })));
    expect(late.every((r) => !r.ok)).toBe(true);
    expect((await pool.query(`select state from lots where id=$1`, [lot1])).rows[0].state).toBe('sold');
    expect((await pool.query(`select count(*)::int c from settlements where lot_id=$1`, [lot1])).rows[0].c).toBe(1);
  });

  step('40 parallel advance() calls: one lot.sold, one settlement for the high bidder, lot 2 opened exactly once', async () => {
    await Promise.all(Array.from({ length: 40 }, () => advanceShow(show)));
    await sleep(1200);
    const res = await Promise.all(Array.from({ length: 40 }, () => advanceShow(show)));
    expect(res.flat().filter((a) => a.startsWith('error'))).toEqual([]);
    const ev = Object.fromEntries((await pool.query(`select kind, count(*)::int c from show_events where show_id=$1 group by kind`, [show])).rows.map((e) => [e.kind, e.c]));
    expect(ev['lot.sold']).toBe(1);
    expect(ev['lot.opened']).toBe(2);
    const s = (await pool.query(`select s.buyer_id, s.status, s.rail, s.attempt, s.due_at, l.high_bidder_id from settlements s join lots l on l.id = s.lot_id where s.lot_id=$1`, [lot1])).rows;
    expect(s).toHaveLength(1);
    expect(s[0].buyer_id).toBe(s[0].high_bidder_id);
    expect([s[0].status, s[0].rail, s[0].attempt]).toEqual(['awaiting_payment', 'cosign', 1]);
    expect(s[0].due_at).toBeInstanceOf(Date);
    expect((await pool.query(`select count(*)::int c from lots where show_id=$1 and state='open'`, [show])).rows[0].c).toBe(1);
  });

  step('the database itself refuses a second open lot (forced update and 20 parallel opens)', async () => {
    await expect(pool.query(`update lots set state='open', opened_at=now(), closes_at=now()+interval '1 minute' where id=$1`, [lot1])).rejects.toThrow(/lots_one_open_per_show/);
    // A fresh show with 20 catalogued lots: 20 racing "open" statements, exactly one wins, the rest hit the unique index.
    const s2 = (await pool.query(`insert into shows (seller_id,title,status) values ($1,'race','live') returning id`, [seller])).rows[0].id as string;
    const ids: string[] = [];
    for (let n = 1; n <= 20; n++) ids.push((await pool.query(`insert into lots (show_id,seller_id,lot_number,mint_address,nft_standard,name,increment,opening_price) values ($1,$2,$3::int,'M'||$3::text,'core','L',1,1) returning id`, [s2, seller, n])).rows[0].id);
    const out = await Promise.allSettled(ids.map((id) => pool.query(`update lots set state='open', opened_at=now(), closes_at=now()+interval '1 minute' where id=$1`, [id])));
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(out.filter((o) => o.status === 'rejected').every((o) => /lots_one_open_per_show/.test((o as PromiseRejectedResult).reason.message))).toBe(true);
    expect((await pool.query(`select count(*)::int c from lots where show_id=$1 and state='open'`, [s2])).rows[0].c).toBe(1);
  });

  step('one live settlement per lot: a second is refused, allowed again after expiry; tx_signature is unique only when set', async () => {
    const ins = (lot: string, extra = '') => pool.query(`insert into settlements (lot_id,buyer_id,seller_id,gross_amount,platform_fee,seller_amount${extra ? ',' + extra.split('=')[0] : ''}) values ($1,$2,$3,100,3,97${extra ? ',' + extra.split('=')[1] : ''})`, [lot, bidders[0], seller]);
    const lot = (await pool.query(`select id from lots where lot_number=2 and show_id=$1`, [show])).rows[0].id as string;
    await ins(lot);
    await expect(ins(lot)).rejects.toThrow(/settlements_one_active_per_lot/);
    await pool.query(`update settlements set status='expired' where lot_id=$1`, [lot]);
    await ins(lot, "tx_signature='SIG1'");
    await pool.query(`update settlements set status='failed' where lot_id=$1 and tx_signature='SIG1'`, [lot]);
    await expect(ins(lot, "tx_signature='SIG1'")).rejects.toThrow(/settlements_tx_idx/);
    // several rows with NULL tx_signature are fine (only one of them can be live; the others are expired/failed)
    const nulls = (await pool.query(`select count(*)::int c from settlements where lot_id=$1 and tx_signature is null`, [lot])).rows[0].c;
    expect(nulls).toBe(1);
  });

  step('a bid signature cannot be replayed: unique (bidder, nonce)', async () => {
    const insert = () => pool.query(`insert into bids (lot_id,bidder_id,amount,signature,message,nonce) values ($1,$2,1,'s','m','replay')`, [lot2, bidders[1]]);
    await insert();
    await expect(insert()).rejects.toThrow(/bids_bidder_nonce_idx/);
  });
});
