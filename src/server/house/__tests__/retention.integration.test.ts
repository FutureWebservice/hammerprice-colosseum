/**
 * Retention of the house (demo) rooms on a real Postgres 18: an ended house show older than HOUSE_RETENTION_DAYS goes with its lots, bids,
 * events and paddles; a real room, a recent or running house show, and any house show with a real settlement (a person's payment, a strike,
 * a settled sale) are never touched. Also the env knobs (HOUSE_RETENTION_DAYS, TIMED_HOUSE_COUNT).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startEnv, USDC, type Env } from '@/server/auction/__tests__/harness';
import { DEFAULT_RETENTION_DAYS, houseRetentionDays } from '../retention';
import { houseTimedCount, TIMED_HOUSE_COUNT } from '../rollover';

let env: Env | undefined; let skipReason: string | undefined;
let P: typeof import('../retention');
beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  P = await import('../retention');
}, 180_000);
afterAll(async () => { await env?.stop(); });
beforeEach(async () => {
  if (!env) return;
  await env.pool.query('delete from settlements; delete from paddles; delete from show_events; delete from bids; delete from lots; delete from shows');
});
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const DAYS = 86_400_000;
const NOW = new Date();
const ago = (d: number) => new Date(NOW.getTime() - d * DAYS);

/** A show with 2 lots (state per `lot2`), a bid on lot 1, an event and a paddle each. */
async function show(e: Env, o: { house: boolean; status: 'ended' | 'live' | 'scheduled'; endedDaysAgo?: number; lot2?: 'sold' | 'open' | 'passed' }) {
  const seller = await e.profile();
  const bidder = await e.profile({ bot: o.house });
  const s = await e.show({ sellerId: seller.id, status: o.status, isHouse: o.house, lots: [{ state: 'sold', closedAt: ago(8) }, { state: o.lot2 ?? 'passed', closedAt: ago(8) }] });
  await e.pool.query(`update shows set ended_at = $2 where id = $1`, [s.id, o.endedDaysAgo === undefined ? null : ago(o.endedDaysAgo)]);
  await e.pool.query(`insert into bids (lot_id, bidder_id, amount, signature, message, nonce) values ($1,$2,$3,'sig','msg',$4)`, [s.lots[0], bidder.id, (60n * USDC).toString(), `nonce-${s.id}`]);
  await e.pool.query(`insert into show_events (show_id, kind, payload) values ($1,'bid.placed','{}'::jsonb), ($1,'lot.closed','{}'::jsonb)`, [s.id]);
  await e.pool.query(`insert into paddles (show_id, profile_id, number, valid_until, auth_message, auth_signature) values ($1,$2,1, now(), 'm','s')`, [s.id, bidder.id]);
  return { ...s, sellerId: seller.id, bidderId: bidder.id };
}
async function settlement(e: Env, s: { lots: string[]; sellerId: string; bidderId: string }, status: string, failureCode: string | null = null) {
  await e.pool.query(
    `insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status, failure_code) values ($1,$2,$3,60000000,3000000,57000000,$4,$5)`,
    [s.lots[0], s.bidderId, s.sellerId, status, failureCode],
  );
}
const exists = async (e: Env, id: string) => (await e.pool.query(`select 1 from shows where id = $1`, [id])).rowCount === 1;
const count = async (e: Env, table: string) => (await e.pool.query(`select count(*)::int c from ${table}`)).rows[0].c as number;

describe('purgeHouseDemoData', () => {
  t('removes an old ended house show with its lots, bids, events, paddles and the house\'s own written-off settlement; reports the counts', async (e) => {
    const old = await show(e, { house: true, status: 'ended', endedDaysAgo: 9 });
    await settlement(e, old, 'expired', 'house_bidder');
    const r = await P.purgeHouseDemoData({ now: NOW });
    expect(r).toEqual({ shows: 1, lots: 2, bids: 1, events: 2 });
    expect(await exists(e, old.id)).toBe(false);
    for (const tbl of ['lots', 'bids', 'show_events', 'paddles', 'settlements']) expect(await count(e, tbl), tbl).toBe(0);
  });

  t('keeps everything else: a real room, a recent house show, a live or scheduled one, one with a lot still on the block', async (e) => {
    const keep = [
      await show(e, { house: false, status: 'ended', endedDaysAgo: 30 }), // a seller's real room, however old
      await show(e, { house: true, status: 'ended', endedDaysAgo: 3 }), // recent
      await show(e, { house: true, status: 'live' }),
      await show(e, { house: true, status: 'scheduled' }),
      await show(e, { house: true, status: 'ended', endedDaysAgo: 20, lot2: 'open' }), // a timed lot still running
    ];
    const r = await P.purgeHouseDemoData({ now: NOW });
    expect(r.shows).toBe(0);
    for (const s of keep) expect(await exists(e, s.id)).toBe(true);
    expect(await count(e, 'bids')).toBe(5);
  });

  t('never touches a settlement that is a person\'s: awaiting payment, submitted, settled, failed, or expired for any reason but a house bidder', async (e) => {
    const cases: [string, string | null][] = [['awaiting_payment', null], ['submitted', null], ['settled', null], ['failed', 'x'], ['expired', 'timeout'], ['expired', null]];
    const shows: string[] = [];
    for (const [status, code] of cases) {
      const s = await show(e, { house: true, status: 'ended', endedDaysAgo: 40 });
      await settlement(e, s, status, code);
      shows.push(s.id);
    }
    const r = await P.purgeHouseDemoData({ now: NOW });
    expect(r.shows).toBe(0);
    for (const id of shows) expect(await exists(e, id), id).toBe(true);
    expect(await count(e, 'settlements')).toBe(cases.length);
  });

  t('removes the old ones and leaves the others in one run, and a second run finds nothing', async (e) => {
    const gone = [await show(e, { house: true, status: 'ended', endedDaysAgo: 8 }), await show(e, { house: true, status: 'ended', endedDaysAgo: 100 })];
    const kept = [await show(e, { house: true, status: 'ended', endedDaysAgo: 6 }), await show(e, { house: false, status: 'ended', endedDaysAgo: 100 })];
    const paid = await show(e, { house: true, status: 'ended', endedDaysAgo: 100 });
    await settlement(e, paid, 'settled');
    expect((await P.purgeHouseDemoData({ now: NOW })).shows).toBe(2);
    for (const s of gone) expect(await exists(e, s.id)).toBe(false);
    for (const s of [...kept, paid]) expect(await exists(e, s.id)).toBe(true);
    expect(await P.purgeHouseDemoData({ now: NOW })).toEqual({ shows: 0, lots: 0, bids: 0, events: 0 });
  });

  t('HOUSE_RETENTION_DAYS moves the line, and "off" keeps everything', async (e) => {
    const s = await show(e, { house: true, status: 'ended', endedDaysAgo: 3 });
    expect((await P.purgeHouseDemoData({ now: NOW, env: { HOUSE_RETENTION_DAYS: 'off' } })).shows).toBe(0);
    expect((await P.purgeHouseDemoData({ now: NOW, env: { HOUSE_RETENTION_DAYS: '5' } })).shows).toBe(0);
    expect(await exists(e, s.id)).toBe(true);
    expect((await P.purgeHouseDemoData({ now: NOW, env: { HOUSE_RETENTION_DAYS: '2' } })).shows).toBe(1);
    expect(await exists(e, s.id)).toBe(false);
  });

  t('a large backlog is removed in batches within one run', async (e) => {
    const seller = await e.profile();
    for (let i = 0; i < 230; i++) {
      const s = await e.show({ sellerId: seller.id, status: 'ended', isHouse: true, lots: [{ state: 'passed' }] });
      await e.pool.query(`update shows set ended_at = $2 where id = $1`, [s.id, ago(30)]);
    }
    expect((await P.purgeHouseDemoData({ now: NOW })).shows).toBe(230);
    expect(await count(e, 'shows')).toBe(0);
  }, 120_000);
});

describe('the env knobs', () => {
  it('HOUSE_RETENTION_DAYS: 1 to 365, default 7, "off" is null, anything else is the default', () => {
    expect(houseRetentionDays({})).toBe(DEFAULT_RETENTION_DAYS);
    expect(houseRetentionDays({ HOUSE_RETENTION_DAYS: '14' })).toBe(14);
    expect(houseRetentionDays({ HOUSE_RETENTION_DAYS: ' OFF ' })).toBeNull();
    for (const bad of ['0', '-1', '366', '1.5', 'abc', '', '7 days']) expect(houseRetentionDays({ HOUSE_RETENTION_DAYS: bad }), bad).toBe(DEFAULT_RETENTION_DAYS);
  });
  it('TIMED_HOUSE_COUNT: 0 to 4, default 2, anything else is the default', () => {
    expect(TIMED_HOUSE_COUNT).toBe(2);
    expect(houseTimedCount({})).toBe(2);
    expect([0, 1, 2, 3, 4].map((n) => houseTimedCount({ TIMED_HOUSE_COUNT: String(n) }))).toEqual([0, 1, 2, 3, 4]);
    for (const bad of ['5', '-1', '1.5', 'two', '', '12']) expect(houseTimedCount({ TIMED_HOUSE_COUNT: bad }), bad).toBe(2);
  });
});
