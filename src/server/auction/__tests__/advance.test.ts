/** advanceShow, closeDueLot, sweep, the snapshot and legacy rows: the real service on Postgres 18. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveSnapshot } from '@/contracts/api';
import { EVENT_PAYLOADS, type EventKind } from '@/contracts/events';
import { settlementMemo } from '@/contracts/chain';
import { bidLogHash } from '@/lib/auction/bidlog';
import { startEnv, USDC, type Env } from './harness';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const T0 = new Date('2026-10-05T18:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('the life of a show, on an injected clock', () => {
  t('scheduled -> live -> lot 1 -> sold with a settlement -> gap -> lot 2 -> passed -> ended', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'scheduled', scheduledAt: T0, rules: { lotDurationS: 20, gapS: 6, snipeWindowS: 3 }, lots: [{ reserve: 50n * USDC }, { reserve: null }] });
    const [bob, amy] = [await e.profile(), await e.profile()];
    await e.paddle(s.id, bob.id, { hours: 24 * 60 }); await e.paddle(s.id, amy.id, { hours: 24 * 60 });
    const [L1, L2] = s.lots;

    expect(await e.svc.advanceShow(s.id, at(-1000))).toEqual({ showId: s.id, wentLive: false, closed: 0, opened: 0, ended: false });
    expect((await e.pool.query(`select status from shows where id=$1`, [s.id])).rows[0].status).toBe('scheduled');

    expect(await e.svc.advanceShow(s.id, T0)).toEqual({ showId: s.id, wentLive: true, closed: 0, opened: 1, ended: false });
    let l1 = await e.lot(L1);
    expect(l1).toMatchObject({ state: 'open' });
    expect(l1.opened_at.getTime()).toBe(T0.getTime());
    expect(l1.closes_at.getTime()).toBe(T0.getTime() + 20_000);
    expect((await e.pool.query(`select status, started_at from shows where id=$1`, [s.id])).rows[0]).toMatchObject({ status: 'live', started_at: T0 });
    expect(await e.svc.advanceShow(s.id, T0)).toMatchObject({ wentLive: false, opened: 0 }); // idempotent

    expect(await e.bid(L1, bob, 50n * USDC, { now: at(5_000) })).toMatchObject({ ok: true });
    expect(await e.bid(L1, amy, 55n * USDC, { now: at(8_000) })).toMatchObject({ ok: true });
    expect(await e.svc.advanceShow(s.id, at(19_999))).toMatchObject({ closed: 0 });

    expect(await e.svc.advanceShow(s.id, at(20_000))).toEqual({ showId: s.id, wentLive: false, closed: 1, opened: 0, ended: false });
    l1 = await e.lot(L1);
    expect(l1).toMatchObject({ state: 'sold', closed_reason: 'timer', high_bid: String(55n * USDC), high_bidder_id: amy.id, bid_count: 2 });
    expect(l1.closed_at.getTime()).toBe(T0.getTime() + 20_000);

    const { rows: st } = await e.pool.query(`select * from settlements where lot_id=$1`, [L1]);
    expect(st).toHaveLength(1);
    const { rows: bidRows } = await e.pool.query(`select id, message, signature, placed_at from bids where lot_id=$1`, [L1]);
    const hash = bidLogHash(bidRows.map((b) => ({ id: b.id, message: b.message, signature: b.signature, placedAt: b.placed_at })));
    expect(st[0]).toMatchObject({
      buyer_id: amy.id, seller_id: seller.id, status: 'awaiting_payment', rail: 'cosign', attempt: 1, cluster: 'devnet',
      gross_amount: String(55n * USDC), platform_fee: '1375000', seller_amount: String(55n * USDC - 1_375_000n), royalty_amount: '0',
      bid_log_hash: hash, tx_signature: null, settled_at: null, royalty_recipient: null, buyer_signature: null, seller_signature: null,
    });
    expect(st[0].due_at.getTime()).toBe(T0.getTime() + 20_000 + 900_000); // closes_at + SETTLEMENT_WINDOW_S
    expect(st[0].memo).toBe(settlementMemo(st[0].id, hash));
    expect(st[0].rail_state).toEqual({ v: 1, bidLogHash: hash, rounds: [] });
    expect(st[0].mint_address).toBe(l1.mint_address);

    expect(await e.svc.advanceShow(s.id, at(25_999))).toMatchObject({ opened: 0 }); // gap not over
    expect(await e.svc.advanceShow(s.id, at(26_000))).toMatchObject({ opened: 1, closed: 0 });
    const l2 = await e.lot(L2);
    expect(l2).toMatchObject({ state: 'open' });
    expect(l2.closes_at.getTime()).toBe(T0.getTime() + 46_000);

    expect(await e.svc.advanceShow(s.id, at(46_000))).toMatchObject({ closed: 1, ended: false });
    expect(await e.lot(L2)).toMatchObject({ state: 'passed', high_bid: null });
    expect((await e.pool.query(`select count(*)::int as n from settlements where lot_id=$1`, [L2])).rows[0].n).toBe(0);
    expect(await e.svc.advanceShow(s.id, at(51_999))).toMatchObject({ ended: false });
    expect(await e.svc.advanceShow(s.id, at(52_000))).toMatchObject({ ended: true });
    expect((await e.pool.query(`select status, ended_at from shows where id=$1`, [s.id])).rows[0]).toMatchObject({ status: 'ended' });
    expect(await e.svc.advanceShow(s.id, at(99_000))).toEqual({ showId: s.id, wentLive: false, closed: 0, opened: 0, ended: false });

    const events = await e.events(s.id);
    expect(events.map((x) => x.kind)).toEqual(['show.live', 'lot.opened', 'bid.placed', 'bid.placed', 'lot.sold', 'settlement.awaiting', 'lot.opened', 'lot.passed', 'show.ended']);
    for (const ev of events) expect(EVENT_PAYLOADS[ev.kind as EventKind].safeParse(ev.payload).success, `${ev.kind} ${JSON.stringify(ev.payload)}`).toBe(true);
    expect(events.find((x) => x.kind === 'lot.sold')!.payload).toMatchObject({ highBid: String(55n * USDC), paddle: 2 });
  });

  t('a lot with a bid below the reserve passes and creates no settlement', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 20 }, lots: [{ state: 'open', openedAt: T0, closesAt: at(20_000), reserve: 100n * USDC }] });
    await e.paddle(s.id, p.id, { hours: 24 * 60 });
    await e.bid(s.lots[0], p, 60n * USDC, { now: at(1_000) });
    await e.svc.advanceShow(s.id, at(20_000));
    expect(await e.lot(s.lots[0])).toMatchObject({ state: 'passed', high_bid: String(60n * USDC) });
    expect((await e.pool.query(`select count(*)::int as n from settlements where lot_id=$1`, [s.lots[0]])).rows[0].n).toBe(0);
    expect((await e.events(s.id)).find((x) => x.kind === 'lot.passed')!.payload).toMatchObject({ highBid: String(60n * USDC) });
  });

  t('the settlement window follows the show rules, and the fee follows PLATFORM_FEE_BPS', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    process.env.PLATFORM_FEE_BPS = '400';
    try {
      const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 20, settlementWindowS: 300 }, lots: [{ state: 'open', openedAt: T0, closesAt: at(20_000), reserve: null }] });
      await e.paddle(s.id, p.id, { hours: 24 * 60 });
      await e.bid(s.lots[0], p, 100n * USDC, { now: at(1_000) });
      await e.svc.advanceShow(s.id, at(20_000));
      const { rows: [st] } = await e.pool.query(`select * from settlements where lot_id=$1`, [s.lots[0]]);
      expect(st).toMatchObject({ platform_fee: String(4n * USDC), seller_amount: String(96n * USDC) });
      expect(st.due_at.getTime()).toBe(T0.getTime() + 20_000 + 300_000);
    } finally { delete process.env.PLATFORM_FEE_BPS; }
  });

  t('not-ready lots are skipped and withdrawn when the show ends; ending with a lot running lets it finish', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 20, gapS: 0 }, lots: [{ state: 'open', openedAt: T0, closesAt: at(20_000) }, { consign: 'pending' }] });
    const actor = { profileId: seller.id, wallet: seller.wallet };
    await e.svc.endShow(s.id, actor);
    expect((await e.pool.query(`select status from shows where id=$1`, [s.id])).rows[0].status).toBe('ended');
    expect(await e.lot(s.lots[1])).toMatchObject({ state: 'withdrawn', closed_reason: 'show_ended' });
    expect(await e.lot(s.lots[0])).toMatchObject({ state: 'open' }); // still on the block
    // a running lot of an ended show is still closed by time, and opens nothing after it
    expect(await e.svc.advanceShow(s.id, at(20_000))).toMatchObject({ closed: 1, opened: 0, ended: false });
    expect(await e.lot(s.lots[0])).toMatchObject({ state: 'passed' });
    expect((await e.events(s.id)).map((x) => x.kind)).toEqual(expect.arrayContaining(['lot.withdrawn', 'show.ended', 'lot.passed']));
  });
});

describe('concurrency', () => {
  t('40 parallel advanceShow on a due lot: one lot.sold, one settlement, the next lot opened once', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const past = new Date(Date.now() - 20_000);
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 20, gapS: 0 }, lots: [
      { state: 'open', openedAt: new Date(Date.now() - 40_000), closesAt: past, reserve: null, highBid: 60n * USDC, highBidderId: p.id, bidCount: 1 },
      { reserve: null }, { reserve: null },
    ] });
    await e.paddle(s.id, p.id);
    const rs = await Promise.all(Array.from({ length: 40 }, () => e.svc.advanceShow(s.id)));
    expect(rs.reduce((n, r) => n + r.closed, 0)).toBe(1);
    expect(rs.reduce((n, r) => n + r.opened, 0)).toBe(1);
    const events = await e.events(s.id);
    expect(events.filter((x) => x.kind === 'lot.sold')).toHaveLength(1);
    expect(events.filter((x) => x.kind === 'settlement.awaiting')).toHaveLength(1);
    expect(events.filter((x) => x.kind === 'lot.opened')).toHaveLength(1);
    expect((await e.pool.query(`select count(*)::int as n from settlements where lot_id=$1`, [s.lots[0]])).rows[0].n).toBe(1);
    const { rows: states } = await e.pool.query(`select lot_number, state from lots where show_id=$1 order by lot_number`, [s.id]);
    expect(states.map((r) => r.state)).toEqual(['sold', 'open', 'catalogued']);
  }, 120_000);

  t('advancers racing late bids that also close the lot: still exactly one settlement', async (e) => {
    const seller = await e.profile(); const winner = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { gapS: 600 }, lots: [{ state: 'open', openedAt: new Date(Date.now() - 40_000), closesAt: new Date(Date.now() - 1_000), reserve: null, highBid: 60n * USDC, highBidderId: winner.id, bidCount: 1 }] });
    const bidders = []; for (let n = 0; n < 10; n++) { const p = await e.profile(); await e.paddle(s.id, p.id); bidders.push(p); }
    const work = [
      ...bidders.map((p, n) => e.bid(s.lots[0], p, BigInt(70 + n * 5) * USDC)),
      ...Array.from({ length: 10 }, () => e.svc.advanceShow(s.id)),
    ];
    await Promise.all(work);
    expect((await e.pool.query(`select count(*)::int as n from settlements where lot_id=$1`, [s.lots[0]])).rows[0].n).toBe(1);
    expect(await e.lot(s.lots[0])).toMatchObject({ state: 'sold', high_bid: String(60n * USDC), bid_count: 1 });
    expect((await e.events(s.id)).filter((x) => x.kind === 'lot.sold')).toHaveLength(1);
  }, 120_000);

  t('bids and advancers together never wait on each other into a deadlock', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 3600 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 3_600_000) }] });
    const ps = []; for (let n = 0; n < 40; n++) { const p = await e.profile(); await e.paddle(s.id, p.id); ps.push(p); }
    const work = [...ps.map((p, n) => e.bid(s.lots[0], p, BigInt(50 + n * 5) * USDC)), ...Array.from({ length: 40 }, () => e.svc.advanceShow(s.id))];
    await Promise.all(work); // a deadlock would surface as a rejected promise
    expect((await e.lot(s.lots[0])).bid_count).toBeGreaterThan(0);
  }, 120_000);
});

describe('database invariants', () => {
  t('at most one open lot per show: the database refuses a second one', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }, {}] });
    await expect(e.pool.query(`update lots set state='open' where id=$1`, [s.lots[1]])).rejects.toMatchObject({ code: '23505' });
    await expect(e.show({ sellerId: seller.id, lots: [] }).then(() => e.pool.query(`insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price, state) values ($1,$2,9,'m','core','x',1,1,'open')`, [s.id, seller.id]))).rejects.toMatchObject({ code: '23505' });
  });

  t('the engine does not open a second lot when one is already open (even if a legacy route opened it)', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { gapS: 0 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 60_000) }, {}] });
    expect(await e.svc.advanceShow(s.id)).toMatchObject({ opened: 0 });
    expect((await e.lot(s.lots[1])).state).toBe('catalogued');
  });

  t('one live settlement per lot: a second insert is refused, an expired one does not block', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'sold', closedAt: new Date() }] });
    const ins = (status: string) => e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status) values ($1,$2,$3,1,0,1,$4)`, [s.lots[0], p.id, seller.id, status]);
    await ins('awaiting_payment');
    await expect(ins('awaiting_payment')).rejects.toMatchObject({ code: '23505' });
    await e.pool.query(`update settlements set status='expired' where lot_id=$1`, [s.lots[0]]);
    await expect(ins('awaiting_payment')).resolves.toBeDefined();
  });
});

describe('legacy rows (closes_at NULL)', () => {
  t('an open lot that is not timed is never closed, blocks the next lot, and nothing crashes', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { gapS: 0 }, lots: [{ state: 'open', openedAt: new Date(Date.now() - 999_000), closesAt: null }, {}] });
    expect(await e.svc.advanceShow(s.id)).toEqual({ showId: s.id, wentLive: false, closed: 0, opened: 0, ended: false });
    expect((await e.lot(s.lots[0])).state).toBe('open');
    expect((await e.lot(s.lots[1])).state).toBe('catalogued');
    expect(await e.svc.sweep()).toBeDefined();
    const snap = await e.svc.getLiveSnapshot(s.id);
    expect(LiveSnapshot.parse(snap).current).toMatchObject({ phase: 'open', closesAt: null, nextOpensAt: null });
  });

  t('shows with settlement_mode "none" or manual mode are never advanced, whatever their lots look like', async (e) => {
    const seller = await e.profile();
    const legacy = await e.show({ sellerId: seller.id, settlementMode: 'none', rules: { gapS: 0 }, lots: [{}, {}] });
    const manual = await e.show({ sellerId: seller.id, mode: 'manual', lots: [{}] });
    const sched = await e.show({ sellerId: seller.id, status: 'scheduled', settlementMode: 'none', scheduledAt: new Date(Date.now() - 60_000), lots: [{}] });
    for (const s of [legacy, manual, sched]) expect(await e.svc.advanceShow(s.id)).toMatchObject({ wentLive: false, opened: 0, closed: 0, ended: false });
    await e.svc.sweep();
    expect((await e.lot(legacy.lots[0])).state).toBe('catalogued');
    expect((await e.lot(manual.lots[0])).state).toBe('catalogued');
    expect((await e.pool.query(`select status from shows where id=$1`, [sched.id])).rows[0].status).toBe('scheduled');
  });

  t('legacy event kinds are normalised and legacy wallet payloads never reach the public snapshot', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, settlementMode: 'none', lots: [{ state: 'sold', closedAt: new Date(), highBid: 10n * USDC }] });
    await e.pool.query(`insert into show_events (show_id, kind, payload) values ($1,'lot_opened',$2), ($1,'bid.placed',$3), ($1,'demo_reset','{}'), ($1,'lot_sold',$4)`, [
      s.id, { lotId: s.lots[0], lotNumber: 1 }, { lotId: s.lots[0], amount: '10000000', walletAddress: 'LEGACYWALLET', bidderId: 'B1', bidId: 'x' },
      { lotId: s.lots[0], lotNumber: 1, highBid: '10000000' },
    ]);
    const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id));
    expect(snap.events.map((x) => x.kind)).toEqual(['lot.opened', 'bid.placed', 'demo.reset', 'lot.sold']);
    expect(JSON.stringify(snap)).not.toContain('LEGACYWALLET');
    expect(snap.events[1].payload).toEqual({ lotId: s.lots[0], amount: '10000000', bidId: 'x' });
    expect(snap.show.settlementMode).toBe('none');
  });
});

describe('getLiveSnapshot and sweep', () => {
  t('a read closes a lot nobody bid on and opens the next; the snapshot is public-safe and valid', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 20, gapS: 0 }, lots: [{ state: 'open', openedAt: new Date(Date.now() - 30_000), closesAt: new Date(Date.now() - 1_000) }, {}] });
    const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id));
    expect(snap.lots.map((l) => l.state)).toEqual(['passed', 'open']);
    expect(snap.current).toMatchObject({ lotNumber: 2, phase: 'open', nextOpensAt: null });
    expect(snap.events.map((x) => x.kind)).toEqual(['lot.passed', 'lot.opened']);
    expect(snap.lastEventId).toBe(snap.events[1].id);
    expect(Math.abs(snap.serverNow - Date.now())).toBeLessThan(5_000);
  });

  t('phases and the gap: going_twice inside 5 s, hammered then awaiting payment after a sale, nextOpensAt during the gap', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { lotDurationS: 20, gapS: 600 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 3_000), reserve: null }, {}] });
    await e.paddle(s.id, p.id);
    expect(LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id)).current!.phase).toBe('going_twice');
    await e.pool.query(`update lots set high_bid=60000000, high_bidder_id=$2, bid_count=1, closes_at=now() - interval '1 second' where id=$1`, [s.lots[0], p.id]);
    const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id));
    expect(snap.current).toMatchObject({ lotNumber: 1, phase: 'hammered' }); // the stamp is on screen for gapS
    expect(snap.current!.nextOpensAt).not.toBeNull();
    expect(snap.lots[0]).toMatchObject({ state: 'sold', highBid: '60000000', highBidder: { paddle: 1 }, settlement: { status: 'awaiting_payment' } });
    expect(snap.lots[1]).toMatchObject({ state: 'catalogued', highBid: null, highBidder: null });
  });

  t('after the stamp a sold lot shows the settlement overlay (awaiting, paying, settled, lapsed)', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules: { gapS: 0 }, lots: [{ state: 'sold', closesAt: new Date(Date.now() - 60_000), closedAt: new Date(Date.now() - 60_000), highBid: 60n * USDC, highBidderId: p.id }] });
    await e.paddle(s.id, p.id);
    await e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount) values ($1,$2,$3,60000000,1500000,58500000)`, [s.lots[0], p.id, seller.id]);
    const phase = async () => LiveSnapshot.parse(await e.svc.getLiveSnapshot(s.id)).current!.phase;
    expect(await phase()).toBe('sold_awaiting_payment');
    for (const [status, expected] of [['submitted', 'sold_paying'], ['settled', 'settled'], ['expired', 'lapsed'], ['failed', 'lapsed']] as const) {
      await e.pool.query(`update settlements set status=$2 where lot_id=$1`, [s.lots[0], status]);
      expect(await phase(), status).toBe(expected);
    }
  });

  t('unknown and malformed show ids give null', async (e) => {
    expect(await e.svc.getLiveSnapshot('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await e.svc.getLiveSnapshot('nope')).toBeNull();
    expect(await e.svc.advanceShow('nope')).toMatchObject({ closed: 0 });
    expect(await e.svc.getCatalogue('nope')).toBeNull();
  });

  t('the cheap path is one query when nothing is due', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 600_000) }, {}] });
    const seen: string[] = [];
    const { Pool } = await import('pg');
    const spy = Pool.prototype.query;
    Pool.prototype.query = function (this: unknown, ...a: unknown[]) { seen.push(typeof a[0] === 'string' ? a[0] : (a[0] as { text: string }).text); return (spy as (...x: unknown[]) => unknown).apply(this, a); } as typeof spy;
    try {
      const r = await e.svc.advanceShow(s.id);
      expect(r).toMatchObject({ closed: 0, opened: 0 });
    } finally { Pool.prototype.query = spy; }
    expect(seen.filter((q) => !/^\s*(begin|commit|rollback)/i.test(q))).toHaveLength(1);
  });

  t('sweep advances every due show and reports how many changed', async (e) => {
    const seller = await e.profile();
    const mk = () => e.show({ sellerId: seller.id, rules: { gapS: 0 }, lots: [{ state: 'open', openedAt: new Date(Date.now() - 30_000), closesAt: new Date(Date.now() - 1_000) }, {}] });
    const [a, b] = [await mk(), await mk()];
    const quiet = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 600_000) }] });
    const r = await e.svc.sweep();
    expect(r.advanced).toBeGreaterThanOrEqual(2);
    expect(r.expired).toBe(0);
    expect((await e.lot(a.lots[0])).state).toBe('passed'); expect((await e.lot(b.lots[0])).state).toBe('passed');
    expect((await e.lot(quiet.lots[0])).state).toBe('open');
    expect((await e.svc.sweep()).advanced).toBe(0);
  });
});
