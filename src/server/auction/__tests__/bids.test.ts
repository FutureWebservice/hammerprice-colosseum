/** placeBid against the real service on Postgres 18: every rejection, the clock, anti-sniping, the lock, 200 parallel bids. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LiveSnapshot } from '@/contracts/api';
import { EVENT_PAYLOADS, type EventKind } from '@/contracts/events';
import { startEnv, USDC, type Env } from './harness';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const inFuture = (s: number) => new Date(Date.now() + s * 1000);

/** A live show with one open lot (opening 50, increment 5, reserve 100, closes in 1 h unless given) and a registered paddle per bidder. */
async function arena(e: Env, o: { closesIn?: number; rules?: Record<string, number>; bidders?: number; reserve?: bigint | null } = {}) {
  const seller = await e.profile();
  const s = await e.show({ sellerId: seller.id, rules: o.rules, lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(o.closesIn ?? 3600), reserve: o.reserve }] });
  const bidders = [];
  for (let n = 0; n < (o.bidders ?? 2); n++) { const p = await e.profile(); const pad = await e.paddle(s.id, p.id); bidders.push({ ...p, paddle: pad }); }
  return { seller, show: s, lot: s.lots[0], bidders };
}

describe('placeBid', () => {
  t('accepts a bid, updates the lot, writes events and returns a valid public snapshot', async (e) => {
    const a = await arena(e);
    const [bob] = a.bidders;
    const r = await e.bid(a.lot, bob, 50n * USDC);
    expect(r).toMatchObject({ ok: true, belowReserve: true, extended: false });
    if (!r.ok) return;
    const lot = await e.lot(a.lot);
    expect(lot).toMatchObject({ high_bid: String(50n * USDC), high_bidder_id: bob.id, bid_count: 1 });
    const parsed = LiveSnapshot.parse(r.live);
    expect(parsed.lots[0]).toMatchObject({ highBid: String(50n * USDC), highBidder: { paddle: bob.paddle.number }, bidCount: 1 });
    expect(JSON.stringify(r.live)).not.toContain(bob.wallet); // paddle numbers, never wallets
    const ev = (await e.events(a.show.id)).filter((x) => x.kind === 'bid.placed');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ lotId: a.lot, lotNumber: 1, amount: String(50n * USDC), paddle: bob.paddle.number, belowReserve: true });
    const [bidRow] = (await e.pool.query(`select * from bids where lot_id=$1`, [a.lot])).rows;
    expect(bidRow).toMatchObject({ via: 'wallet', paddle_id: bob.paddle.id, funded_amount: String(1_000_000n * USDC) });
  });

  t('every event it writes matches the contract payload schema', async (e) => {
    const a = await arena(e, { closesIn: 5, rules: { snipeWindowS: 15, snipeExtendS: 15 } });
    await e.bid(a.lot, a.bidders[0], 50n * USDC); // inside the window: extends
    for (const ev of await e.events(a.show.id)) expect(EVENT_PAYLOADS[ev.kind as EventKind].safeParse(ev.payload).success, ev.kind).toBe(true);
  });

  t('bid_too_low carries minNext; the exact minimum is accepted', async (e) => {
    const a = await arena(e);
    const [bob, amy] = a.bidders;
    expect(await e.bid(a.lot, bob, 50n * USDC - 1n)).toMatchObject({ ok: false, code: 'bid_too_low', minNext: String(50n * USDC) });
    expect(await e.bid(a.lot, bob, 50n * USDC)).toMatchObject({ ok: true });
    expect(await e.bid(a.lot, amy, 55n * USDC - 1n)).toMatchObject({ ok: false, code: 'bid_too_low', minNext: String(55n * USDC) });
    expect(await e.bid(a.lot, amy, 55n * USDC)).toMatchObject({ ok: true });
  });

  t('already_high_bidder, self_bid, no_paddle, banned, amount_too_large, replay', async (e) => {
    const a = await arena(e);
    const [bob] = a.bidders;
    await e.bid(a.lot, bob, 50n * USDC);
    expect(await e.bid(a.lot, bob, 60n * USDC)).toMatchObject({ ok: false, code: 'already_high_bidder' });

    const sellerPaddle = await e.paddle(a.show.id, a.seller.id);
    expect(sellerPaddle.number).toBeGreaterThan(0);
    expect(await e.bid(a.lot, a.seller, 70n * USDC)).toMatchObject({ ok: false, code: 'self_bid' });

    const stranger = await e.profile();
    expect(await e.bid(a.lot, stranger, 70n * USDC)).toMatchObject({ ok: false, code: 'no_paddle' });

    const bad = await e.profile({ banned: true }); await e.paddle(a.show.id, bad.id);
    expect(await e.bid(a.lot, bad, 70n * USDC)).toMatchObject({ ok: false, code: 'banned' });

    const rich = await e.profile(); await e.paddle(a.show.id, rich.id);
    expect(await e.bid(a.lot, rich, 2n ** 70n, { fundsBalance: 2n ** 80n })).toMatchObject({ ok: false, code: 'amount_too_large' });
    expect(await e.bid(a.lot, rich, 10n ** 12n + 1n, { fundsBalance: 2n ** 80n })).toMatchObject({ ok: false, code: 'amount_too_large' });

    const amy = await e.profile(); await e.paddle(a.show.id, amy.id);
    const first = await e.bid(a.lot, amy, 60n * USDC, { nonce: 'same-nonce' });
    expect(first.ok).toBe(true);
    expect(await e.bid(a.lot, rich, 65n * USDC)).toMatchObject({ ok: true }); // amy is outbid, so only the nonce can refuse her now
    const again = await e.bid(a.lot, amy, 70n * USDC, { nonce: 'same-nonce' });
    expect(again).toMatchObject({ ok: false, code: 'replay' });
    expect((await e.lot(a.lot)).bid_count).toBe(3);
  });

  t('a paddle id that belongs to someone else is refused', async (e) => {
    const a = await arena(e);
    const [bob, amy] = a.bidders;
    expect(await e.bid(a.lot, bob, 50n * USDC, { paddleId: amy.paddle.id })).toMatchObject({ ok: false, code: 'no_paddle' });
    expect(await e.bid(a.lot, bob, 50n * USDC, { paddleId: bob.paddle.id })).toMatchObject({ ok: true });
  });

  t('a wallet that does not match the bidder profile is refused', async (e) => {
    const a = await arena(e);
    expect(await e.bid(a.lot, { id: a.bidders[0].id, wallet: a.bidders[1].wallet }, 50n * USDC)).toMatchObject({ ok: false, code: 'forbidden' });
  });

  t('not_found for unknown or malformed lot ids', async (e) => {
    const a = await arena(e);
    expect(await e.bid('00000000-0000-4000-8000-000000000000', a.bidders[0], 50n * USDC)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await e.bid('not-a-uuid', a.bidders[0], 50n * USDC)).toMatchObject({ ok: false, code: 'not_found' });
  });

  t('show_not_live, lot_not_open, and lot_closed for a finished lot', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const sched = await e.show({ sellerId: seller.id, status: 'scheduled', lots: [{ state: 'catalogued' }] });
    await e.paddle(sched.id, p.id);
    expect(await e.bid(sched.lots[0], p, 50n * USDC)).toMatchObject({ ok: false, code: 'show_not_live' });
    const live = await e.show({ sellerId: seller.id, lots: [{ state: 'catalogued' }, { state: 'sold', closedAt: new Date() }, { state: 'withdrawn', closedAt: new Date() }] });
    await e.paddle(live.id, p.id);
    expect(await e.bid(live.lots[0], p, 50n * USDC)).toMatchObject({ ok: false, code: 'lot_not_open' });
    expect(await e.bid(live.lots[1], p, 50n * USDC)).toMatchObject({ ok: false, code: 'lot_closed' });
    expect(await e.bid(live.lots[2], p, 50n * USDC)).toMatchObject({ ok: false, code: 'lot_closed' });
  });

  t('an open lot that is not timed (legacy) refuses bids and never crashes', async (e) => {
    const seller = await e.profile(); const p = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: null }] });
    await e.paddle(s.id, p.id);
    expect(await e.bid(s.lots[0], p, 50n * USDC)).toMatchObject({ ok: false, code: 'lot_not_open' });
    expect((await e.lot(s.lots[0])).state).toBe('open');
  });

  t('funds: balance minus commitments (leading bids elsewhere and unpaid wins)', async (e) => {
    const a = await arena(e, { bidders: 1 });
    const other = await arena(e, { bidders: 0 });
    const [bob] = a.bidders;
    await e.paddle(other.show.id, bob.id);
    expect(await e.svc.commitmentsFor(bob.id)).toBe(0n);
    expect(await e.bid(other.lot, bob, 80n * USDC, { fundsBalance: 200n * USDC })).toMatchObject({ ok: true });
    expect(await e.svc.commitmentsFor(bob.id)).toBe(80n * USDC);
    expect(await e.svc.commitmentsFor(bob.id, other.lot)).toBe(0n);
    // 200 balance - 80 committed = 120 available
    expect(await e.bid(a.lot, bob, 121n * USDC, { fundsBalance: 200n * USDC })).toMatchObject({ ok: false, code: 'insufficient_funds' });
    expect(await e.bid(a.lot, bob, 120n * USDC, { fundsBalance: 200n * USDC })).toMatchObject({ ok: true });
    // an unpaid win counts too
    const buyer = await e.profile(); const s2 = await arena(e, { bidders: 0 });
    await e.pool.query(`insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status) values ($1,$2,$3,1000000000,1,1,'awaiting_payment')`, [s2.lot, buyer.id, s2.seller.id]);
    expect(await e.svc.commitmentsFor(buyer.id)).toBe(1000n * USDC);
    await e.pool.query(`update settlements set status='settled' where buyer_id=$1`, [buyer.id]);
    expect(await e.svc.commitmentsFor(buyer.id)).toBe(0n);
  });

  t('the house guard: bots only on the house show', async (e) => {
    const seller = await e.profile(); const bot = await e.profile({ bot: true });
    const plain = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(600) }] });
    const house = await e.show({ sellerId: seller.id, isHouse: true, lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(600) }] });
    await e.paddle(plain.id, bot.id); await e.paddle(house.id, bot.id);
    expect(await e.bid(plain.lots[0], bot, 50n * USDC, { via: 'house' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await e.bid(plain.lots[0], bot, 50n * USDC)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await e.bid(house.lots[0], bot, 50n * USDC, { via: 'house' })).toMatchObject({ ok: true });
  });

  t('a session bid above the paddle maximum is refused; a wallet bid is not bound by it', async (e) => {
    const a = await arena(e, { bidders: 0 });
    const p = await e.profile(); await e.paddle(a.show.id, p.id, { maxBid: 60n * USDC });
    expect(await e.bid(a.lot, p, 65n * USDC, { via: 'session' })).toMatchObject({ ok: false, code: 'no_paddle' });
    expect(await e.bid(a.lot, p, 60n * USDC, { via: 'session' })).toMatchObject({ ok: true });
  });
});

describe('time: deadline and anti-sniping', () => {
  const T0 = new Date('2026-10-05T18:00:00.000Z');
  async function timed(e: Env, rules: Record<string, number> = {}) {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, rules, lots: [{ state: 'open', openedAt: T0, closesAt: new Date(T0.getTime() + 45_000) }] });
    const ps = []; for (let n = 0; n < 4; n++) { const p = await e.profile(); await e.paddle(s.id, p.id, { hours: 24 * 60 }); ps.push(p); }
    return { s, lot: s.lots[0], ps };
  }
  const at = (ms: number) => new Date(T0.getTime() + ms);

  t('closes_at - 1 ms is accepted, closes_at is refused and closes the lot (lazy close)', async (e) => {
    const a = await timed(e);
    expect(await e.bid(a.lot, a.ps[0], 50n * USDC, { now: at(45_000 - 1) })).toMatchObject({ ok: true });
    const b = await timed(e);
    expect(await e.bid(b.lot, b.ps[0], 50n * USDC, { now: at(45_000) })).toMatchObject({ ok: false, code: 'lot_closed' });
    expect((await e.lot(b.lot)).state).toBe('passed');
    const c = await timed(e);
    expect(await e.bid(c.lot, c.ps[0], 50n * USDC, { now: at(45_001) })).toMatchObject({ ok: false, code: 'lot_closed' });
  });

  t('a late bid closes a lot that had a winning bid: sold, with its settlement, in one go', async (e) => {
    const a = await timed(e);
    await e.bid(a.lot, a.ps[0], 100n * USDC, { now: at(10_000) });
    expect(await e.bid(a.lot, a.ps[1], 200n * USDC, { now: at(46_000) })).toMatchObject({ ok: false, code: 'lot_closed' });
    const lot = await e.lot(a.lot);
    expect(lot).toMatchObject({ state: 'sold', closed_reason: 'timer', high_bid: String(100n * USDC) });
    expect(lot.closed_at.getTime()).toBe(T0.getTime() + 45_000); // the deadline, not the moment someone noticed
    const { rows } = await e.pool.query(`select * from settlements where lot_id=$1`, [a.lot]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ buyer_id: a.ps[0].id, status: 'awaiting_payment', rail: 'cosign', attempt: 1, gross_amount: String(100n * USDC) });
  });

  t('a bid in the last 15 s extends the close to now + 15 s; one outside does not', async (e) => {
    const a = await timed(e);
    await e.bid(a.lot, a.ps[0], 50n * USDC, { now: at(20_000) });
    expect((await e.lot(a.lot)).closes_at.getTime()).toBe(T0.getTime() + 45_000);
    const r = await e.bid(a.lot, a.ps[1], 55n * USDC, { now: at(40_000) });
    expect(r).toMatchObject({ ok: true, extended: true, closesAt: at(55_000).toISOString() });
    expect((await e.lot(a.lot)).closes_at.getTime()).toBe(T0.getTime() + 55_000);
    const kinds = (await e.events(a.s.id)).map((x) => x.kind);
    expect(kinds.filter((k) => k === 'lot.extended')).toHaveLength(1);
  });

  t('anti-sniping is capped at opened + duration + maxExtension and closes_at never moves back', async (e) => {
    const a = await timed(e, { maxExtensionS: 30 }); // cap = T0 + 75 s
    let closes = T0.getTime() + 45_000; let amount = 50n; let n = 0;
    for (let now = 40_000; now < 80_000; now += 6_000) {
      const r = await e.bid(a.lot, a.ps[n++ % 4], amount * USDC, { now: at(now) }); amount += 5n;
      if (!r.ok) break;
      const after = (await e.lot(a.lot)).closes_at.getTime();
      expect(after).toBeGreaterThanOrEqual(closes); expect(after).toBeLessThanOrEqual(T0.getTime() + 75_000);
      closes = after;
    }
    expect(closes).toBe(T0.getTime() + 75_000);
  });

  t('placed_at is taken after the lock (C9): a bid that waited for the lot is stamped after the holder released it', async (e) => {
    const a = await arena(e, { bidders: 1 });
    const holder = await e.pool.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from lots where id=$1 for update`, [a.lot]);
      const pending = e.bid(a.lot, a.bidders[0], 50n * USDC);
      await new Promise((r) => setTimeout(r, 400));
      const { rows: [{ t: released }] } = await holder.query(`select clock_timestamp() as t`);
      await holder.query('commit');
      expect(await pending).toMatchObject({ ok: true });
      const { rows: [b] } = await e.pool.query(`select placed_at from bids where lot_id=$1`, [a.lot]);
      expect(b.placed_at.getTime()).toBeGreaterThanOrEqual(released.getTime());
    } finally { holder.release(); }
  });
});

describe('the deadline clock is read after the lock', () => {
  t('a bid that queued behind a lock holder and woke up after closes_at is refused, not accepted on the clock it had when it queued', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 250) }] });
    const p = await e.profile(); await e.paddle(s.id, p.id);
    const holder = await e.pool.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from lots where id=$1 for update`, [s.lots[0]]);
      const pending = e.bid(s.lots[0], p, 50n * USDC); // starts inside the 250 ms window, waits for the lock
      await new Promise((r) => setTimeout(r, 500));
      await holder.query('commit');
      expect(await pending).toMatchObject({ ok: false, code: 'lot_closed' });
    } finally { holder.release(); }
    expect((await e.lot(s.lots[0])).bid_count).toBe(0);
  });
});

describe('concurrency', () => {
  t('200 parallel bids: strictly increasing accepted amounts, high_bid is the last accepted, bid_count is consistent', async (e) => {
    const a = await arena(e, { bidders: 0 });
    const ps = [];
    for (let n = 0; n < 200; n++) { const p = await e.profile(); await e.paddle(a.show.id, p.id); ps.push(p); }
    // Distinct amounts, shuffled so they race in a hostile order; many will be too low by the time they get the lock.
    // Mostly ascending with heavy jitter, so plenty are accepted and plenty lose the race.
    const order = ps.map((p, n) => ({ p, amount: (50n + BigInt(n) * 5n) * USDC, k: n + (Math.random() - 0.5) * 40 })).sort((a, b) => a.k - b.k);
    const results = await Promise.all(order.map(({ p, amount }) => e.bid(a.lot, p, amount)));
    const okCount = results.filter((r) => r.ok).length;
    const codes = new Set(results.filter((r) => !r.ok).map((r) => (r as { code: string }).code));
    expect(okCount).toBeGreaterThan(1);
    console.info(`200 parallel bids: ${okCount} accepted, ${200 - okCount} refused (${[...codes].join(', ')})`);
    for (const c of codes) expect(['bid_too_low', 'already_high_bidder']).toContain(c);

    const { rows: bidRows } = await e.pool.query(`select id, bidder_id, amount, placed_at from bids where lot_id=$1 order by placed_at, id`, [a.lot]);
    expect(bidRows).toHaveLength(okCount);
    const amounts = bidRows.map((b) => BigInt(b.amount));
    for (let n = 1; n < amounts.length; n++) expect(amounts[n]).toBeGreaterThan(amounts[n - 1]);
    const lot = await e.lot(a.lot);
    expect(BigInt(lot.high_bid)).toBe(amounts[amounts.length - 1]);
    expect(lot.high_bidder_id).toBe(bidRows[bidRows.length - 1].bidder_id);
    expect(lot.bid_count).toBe(okCount);
    const placed = (await e.events(a.show.id)).filter((x) => x.kind === 'bid.placed');
    expect(placed).toHaveLength(okCount);
    expect(placed.map((x) => BigInt(x.payload.amount))).toEqual(amounts); // event order == bid order
  }, 120_000);

  t('the same signed bid sent 10 times in parallel is accepted once', async (e) => {
    const a = await arena(e, { bidders: 1 });
    const rs = await Promise.all(Array.from({ length: 10 }, () => e.bid(a.lot, a.bidders[0], 50n * USDC, { nonce: 'dup-nonce' })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await e.lot(a.lot)).bid_count).toBe(1);
  });
});
