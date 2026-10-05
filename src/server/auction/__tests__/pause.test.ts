/**
 * The seller's pause against the real service on Postgres 18: who may pause, the limits, bids refused while paused,
 * the clock shift on resume (exact milliseconds), the lazy auto-resume, anti-sniping after a pause, the bid log, and a pause racing a bid.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@/contracts/errors';
import { LiveSnapshot } from '@/contracts/api';
import { EVENT_PAYLOADS, type EventKind } from '@/contracts/events';
import { bidLogHash } from '@/lib/auction/bidlog';
import { PAUSE_MAX_MS } from '@/lib/auction/rules';
import { startEnv, USDC, type Env } from './harness';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

const code = async (p: Promise<unknown>) => { try { await p; return 'no error'; } catch (e) { return e instanceof ApiError ? e.code : `other: ${(e as Error).message}`; } };
const ago = (ms: number) => new Date(Date.now() - ms);
const inFuture = (s: number) => new Date(Date.now() + s * 1000);

/** A live show with one open lot (closes in `closesIn` s, opened `openedAgo` s ago) and two bidders with paddles. */
async function arena(e: Env, o: { closesIn?: number; openedAgo?: number; cluster?: string | null; isHouse?: boolean; second?: boolean } = {}) {
  const seller = await e.profile();
  const lots = [{ state: 'open' as const, openedAt: ago((o.openedAgo ?? 5) * 1000), closesAt: inFuture(o.closesIn ?? 120), reserve: 100n * USDC }, ...(o.second ? [{}] : [])];
  const s = await e.show({ sellerId: seller.id, cluster: o.cluster, isHouse: o.isHouse, lots });
  const bob = await e.profile(); const amy = await e.profile();
  const bobPad = await e.paddle(s.id, bob.id); const amyPad = await e.paddle(s.id, amy.id);
  return { seller, actor: { profileId: seller.id, wallet: seller.wallet }, show: s, lot: s.lots[0], bob: { ...bob, paddle: bobPad }, amy: { ...amy, paddle: amyPad } };
}
const showRow = async (e: Env, id: string) => (await e.pool.query(`select * from shows where id=$1`, [id])).rows[0];
const ms = (d: Date) => d.getTime();

describe('pause and resume', () => {
  t('pauses the room: events, snapshot, frozen phase; resume moves the deadline by exactly the paused time', async (e) => {
    const a = await arena(e, { closesIn: 60 });
    const before = await e.lot(a.lot);
    const paused = await e.svc.pauseShow(a.show.id, a.actor);
    expect(paused.status).toBe('live'); // a paused room is still a live show
    const row = await showRow(e, a.show.id);
    expect(row.paused_at).not.toBeNull();
    expect(row.pause_count).toBe(1);
    // the deadline does not move while paused
    expect(ms((await e.lot(a.lot)).closes_at)).toBe(ms(before.closes_at));

    const ev = (await e.events(a.show.id)).filter((x) => x.kind === 'show.paused');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ lotId: a.lot, lotNumber: 1, count: 1, max: 2, resumesBy: new Date(ms(row.paused_at) + PAUSE_MAX_MS).toISOString() });
    expect(ev[0].payload.msLeft).toBe(ms(before.closes_at) - ms(row.paused_at));

    const snap = LiveSnapshot.parse(await e.svc.getLiveSnapshot(a.show.id));
    expect(snap.show.status).toBe('live');
    expect(snap.show.pause).toEqual({ paused: true, pausedAt: row.paused_at.toISOString(), resumesBy: new Date(ms(row.paused_at) + PAUSE_MAX_MS).toISOString(), used: 1, max: 2 });
    expect(snap.current?.closesAt).toBe(before.closes_at.toISOString());

    await new Promise((r) => setTimeout(r, 1300));
    const resumed = await e.svc.resumeShow(a.show.id, a.actor);
    expect(resumed.status).toBe('live');
    const after = await e.lot(a.lot);
    const rev = (await e.events(a.show.id)).filter((x) => x.kind === 'show.resumed');
    expect(rev).toHaveLength(1);
    const shifted = ms(after.closes_at) - ms(before.closes_at);
    expect(rev[0].payload).toMatchObject({ lotId: a.lot, lotNumber: 1, auto: false, shiftedMs: shifted, closesAt: after.closes_at.toISOString() });
    expect(shifted).toBeGreaterThanOrEqual(1300);
    expect(shifted).toBeLessThan(5000);
    expect(Number(after.paused_ms)).toBe(shifted);
    // the lot got back exactly the time it had when the room was paused
    const resumedAt = ms(new Date((await e.pool.query(`select created_at from show_events where id=$1`, [rev[0].id])).rows[0].created_at));
    expect(ms(after.closes_at) - resumedAt).toBeGreaterThanOrEqual(ev[0].payload.msLeft - 5);
    expect(ms(after.closes_at) - resumedAt).toBeLessThanOrEqual(ev[0].payload.msLeft + 5);
    expect((await showRow(e, a.show.id)).paused_at).toBeNull();
    expect((await showRow(e, a.show.id)).pause_count).toBe(1); // the count never goes down
    for (const x of await e.events(a.show.id)) expect(EVENT_PAYLOADS[x.kind as EventKind].safeParse(x.payload).success, x.kind).toBe(true);
    expect(LiveSnapshot.parse(await e.svc.getLiveSnapshot(a.show.id)).show.pause).toMatchObject({ paused: false, used: 1, max: 2 });
  });

  t('refuses bids while paused (show_paused, nothing recorded, nonce not burnt) and accepts them after the resume', async (e) => {
    const a = await arena(e);
    await e.svc.pauseShow(a.show.id, a.actor);
    const r = await e.bid(a.lot, a.bob, 50n * USDC, { nonce: 'paused-nonce' });
    expect(r).toMatchObject({ ok: false, code: 'show_paused' });
    expect((await e.pool.query(`select count(*)::int c from bids where lot_id=$1`, [a.lot])).rows[0].c).toBe(0);
    expect(await e.lot(a.lot)).toMatchObject({ high_bid: null, bid_count: 0 });
    await e.svc.resumeShow(a.show.id, a.actor);
    expect(await e.bid(a.lot, a.bob, 50n * USDC, { nonce: 'paused-nonce' })).toMatchObject({ ok: true }); // same nonce: the refused try left no trace
    expect(await e.bid(a.lot, a.amy, 55n * USDC, { nonce: 'paused-nonce' })).toMatchObject({ ok: true }); // nonce is per bidder
    expect((await e.pool.query(`select count(*)::int c from bids where lot_id=$1`, [a.lot])).rows[0].c).toBe(2);
  });

  t('house bidders are refused while paused too, and so is Buy Now', async (e) => {
    const a = await arena(e, { isHouse: true });
    const bot = await e.profile({ bot: true }); await e.paddle(a.show.id, bot.id);
    await e.pool.query(`update lots set buy_now_price=$2 where id=$1`, [a.lot, String(300n * USDC)]);
    await e.svc.pauseShow(a.show.id, a.actor);
    expect(await e.bid(a.lot, bot, 50n * USDC, { via: 'house' })).toMatchObject({ ok: false, code: 'show_paused' });
    expect(await code(e.svc.buyNow({ lotId: a.lot, buyerProfileId: a.bob.id, buyerWallet: a.bob.wallet, amount: 300n * USDC, fundsBalance: 1000n * USDC, message: 'buy', signature: 'sig', nonce: 'bn-paused' }))).toBe('show_paused');
    expect((await e.lot(a.lot)).state).toBe('open');
    await e.svc.resumeShow(a.show.id, a.actor);
    expect(await e.bid(a.lot, bot, 50n * USDC, { via: 'house' })).toMatchObject({ ok: true });
  });

  for (const cluster of ['devnet', 'mainnet-beta'] as const) {
    t(`a paused room that resumes takes funded bids on ${cluster} and refuses an unfunded one`, async (e) => {
      const a = await arena(e, { cluster });
      await e.svc.pauseShow(a.show.id, a.actor);
      expect(await e.bid(a.lot, a.bob, 50n * USDC)).toMatchObject({ ok: false, code: 'show_paused' });
      await e.svc.resumeShow(a.show.id, a.actor);
      expect(await e.bid(a.lot, a.bob, 50n * USDC, { fundsBalance: 10n * USDC })).toMatchObject({ ok: false, code: 'insufficient_funds' });
      expect(await e.bid(a.lot, a.bob, 50n * USDC)).toMatchObject({ ok: true });
    });
  }

  t('anti-sniping still works after a long pause: the extension cap counts the lot\'s own running time, not the paused time', async (e) => {
    // The room was paused 4 minutes ago with 12 s on the lot, 33 s into its 45 s.
    const seller = await e.profile(); const bob = await e.profile();
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: ago(4 * 60_000 + 33_000), closesAt: ago(4 * 60_000 - 12_000), reserve: null }] });
    await e.paddle(s.id, bob.id);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [s.id, ago(4 * 60_000)]);
    await e.svc.resumeShow(s.id, { profileId: seller.id, wallet: seller.wallet });
    const lot = await e.lot(s.lots[0]);
    expect(Number(lot.paused_ms)).toBeGreaterThanOrEqual(4 * 60_000);
    expect(Number(lot.paused_ms)).toBeLessThan(4 * 60_000 + 5000);
    const left = ms(lot.closes_at) - Date.now();
    expect(left).toBeGreaterThan(10_000); // 12 s, as at the pause
    expect(left).toBeLessThanOrEqual(12_000);
    const r = await e.bid(s.lots[0], bob, 50n * USDC); // 12 s left is inside the 15 s window: the bid extends to at least 15 s
    expect(r).toMatchObject({ ok: true, extended: true });
    expect(ms((await e.lot(s.lots[0])).closes_at) - Date.now()).toBeGreaterThan(14_000);
  });

  t('the extension cap still holds after a pause (opened + paused + duration + 120 s)', async (e) => {
    const seller = await e.profile(); const bob = await e.profile(); const amy = await e.profile();
    // 45 s lot, 10 s ago it already ran into its cap: closes in 8 s, cap is 8 s away too
    const s = await e.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: ago(45_000 + 120_000 - 8_000 + 3 * 60_000), closesAt: ago(3 * 60_000 - 8_000), reserve: null }] });
    await e.paddle(s.id, bob.id); await e.paddle(s.id, amy.id);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [s.id, ago(3 * 60_000)]);
    await e.svc.resumeShow(s.id, { profileId: seller.id, wallet: seller.wallet });
    const before = ms((await e.lot(s.lots[0])).closes_at);
    const r = await e.bid(s.lots[0], bob, 50n * USDC);
    expect(r).toMatchObject({ ok: true, extended: false }); // the cap was reached before the pause; a pause neither gives nor takes extension room
    expect(ms((await e.lot(s.lots[0])).closes_at)).toBe(before);
  });
});

describe('limits that protect bidders', () => {
  t('at most 2 pauses per show, then pause_limit', async (e) => {
    const a = await arena(e);
    for (let n = 1; n <= 2; n++) {
      await e.svc.pauseShow(a.show.id, a.actor);
      expect(await code(e.svc.pauseShow(a.show.id, a.actor))).toBe('show_paused'); // already paused
      await e.svc.resumeShow(a.show.id, a.actor);
      expect((await showRow(e, a.show.id)).pause_count).toBe(n);
    }
    expect(await code(e.svc.pauseShow(a.show.id, a.actor))).toBe('pause_limit');
    expect((await showRow(e, a.show.id)).paused_at).toBeNull();
    expect((await showRow(e, a.show.id)).pause_count).toBe(2);
    expect((await e.events(a.show.id)).filter((x) => x.kind === 'show.paused')).toHaveLength(2);
  });

  t('not in the last 10 seconds of a lot (pause_too_late), but fine with 15 s left', async (e) => {
    const late = await arena(e, { closesIn: 6 });
    expect(await code(e.svc.pauseShow(late.show.id, late.actor))).toBe('pause_too_late');
    expect((await showRow(e, late.show.id)).paused_at).toBeNull();
    expect((await showRow(e, late.show.id)).pause_count).toBe(0); // a refused pause does not use one up
    const ok = await arena(e, { closesIn: 15 });
    await e.svc.pauseShow(ok.show.id, ok.actor);
  });

  t('needs a live show of the live kind with a lot on the block', async (e) => {
    const seller = await e.profile(); const actor = { profileId: seller.id, wallet: seller.wallet };
    const sched = await e.show({ sellerId: seller.id, status: 'scheduled', lots: [{}] });
    expect(await code(e.svc.pauseShow(sched.id, actor))).toBe('wrong_state');
    const ended = await e.show({ sellerId: seller.id, status: 'ended', lots: [{ state: 'sold' }] });
    expect(await code(e.svc.pauseShow(ended.id, actor))).toBe('wrong_state');
    const between = await e.show({ sellerId: seller.id, rules: { gapS: 600 }, lots: [{ state: 'sold', closedAt: new Date() }, {}] }); // the gap after lot 1 has not passed: nothing on the block
    expect(await code(e.svc.pauseShow(between.id, actor))).toBe('lot_not_open');
    const timed = await arena(e, { closesIn: 3600 });
    await e.pool.query(`update shows set kind='timed' where id=$1`, [timed.show.id]);
    expect(await code(e.svc.pauseShow(timed.show.id, timed.actor))).toBe('wrong_state');
    expect(await code(e.svc.pauseShow('not-a-uuid', actor))).toBe('not_found');
    expect(await code(e.svc.pauseShow('8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', actor))).toBe('not_found');
    expect(await code(e.svc.resumeShow(between.id, actor))).toBe('wrong_state'); // not paused
  });
});

describe('who may pause', () => {
  t('only the seller; another wallet gets not_seller and nothing changes', async (e) => {
    const a = await arena(e);
    expect(await code(e.svc.pauseShow(a.show.id, { profileId: a.bob.id, wallet: a.bob.wallet }))).toBe('not_seller');
    expect((await showRow(e, a.show.id)).paused_at).toBeNull();
    await e.svc.pauseShow(a.show.id, a.actor);
    expect(await code(e.svc.resumeShow(a.show.id, { profileId: a.bob.id, wallet: a.bob.wallet }))).toBe('not_seller');
    expect((await showRow(e, a.show.id)).paused_at).not.toBeNull();
  });

  t('an operator wallet may pause the house show and nobody else\'s show', async (e) => {
    const op = await e.profile();
    process.env.OPERATOR_WALLETS = op.wallet;
    try {
      const house = await arena(e, { isHouse: true });
      await e.svc.pauseShow(house.show.id, { profileId: op.id, wallet: op.wallet });
      await e.svc.resumeShow(house.show.id, { profileId: op.id, wallet: op.wallet });
      const theirs = await arena(e);
      expect(await code(e.svc.pauseShow(theirs.show.id, { profileId: op.id, wallet: op.wallet }))).toBe('not_seller');
    } finally { delete process.env.OPERATOR_WALLETS; }
  });
});

describe('the lazy timers', () => {
  t('a frozen clock does not close the lot: even with the deadline long past, advance does nothing and a bid says show_paused, not lot_closed', async (e) => {
    const a = await arena(e);
    // paused 2 minutes ago with 20 s left: the stored deadline is 100 s in the past
    await e.pool.query(`update lots set closes_at=$2 where id=$1`, [a.lot, ago(100_000)]);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [a.show.id, ago(120_000)]);
    const r = await e.svc.advanceShow(a.show.id);
    expect(r).toMatchObject({ closed: 0, opened: 0, ended: false });
    expect((await e.lot(a.lot)).state).toBe('open');
    expect(await e.bid(a.lot, a.bob, 50n * USDC)).toMatchObject({ ok: false, code: 'show_paused' });
    const snap = await e.svc.getLiveSnapshot(a.show.id);
    expect(snap?.current?.phase).toBe('open'); // drawn at the moment of the pause (20 s left), not "hammered"
    expect(snap?.show.pause.paused).toBe(true);
  });

  t('the pause ends by itself after 5 minutes: the next read resumes, shifts the deadline by exactly 5 minutes and says so', async (e) => {
    const a = await arena(e);
    // paused 5 min 2 s ago with 60 s left: bidders got the room back 2 s ago and have 58 s
    const pausedAt = ago(PAUSE_MAX_MS + 2000);
    await e.pool.query(`update lots set closes_at=$2 where id=$1`, [a.lot, new Date(ms(pausedAt) + 60_000)]);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [a.show.id, pausedAt]);
    const r = await e.svc.advanceShow(a.show.id);
    expect(r.closed).toBe(0);
    const lot = await e.lot(a.lot);
    expect(ms(lot.closes_at)).toBe(ms(pausedAt) + 60_000 + PAUSE_MAX_MS); // exactly the limit, not the 5 min 2 s it took to notice
    expect(Number(lot.paused_ms)).toBe(PAUSE_MAX_MS);
    expect((await showRow(e, a.show.id)).paused_at).toBeNull();
    const ev = (await e.events(a.show.id)).find((x) => x.kind === 'show.resumed')!;
    expect(ev.payload).toMatchObject({ auto: true, shiftedMs: PAUSE_MAX_MS, lotId: a.lot });
    expect(await e.svc.advanceShow(a.show.id)).toMatchObject({ closed: 0 }); // idempotent
    expect((await e.events(a.show.id)).filter((x) => x.kind === 'show.resumed')).toHaveLength(1);
  });

  t('a bid that arrives after the limit resumes the room first and is accepted', async (e) => {
    const a = await arena(e);
    const pausedAt = ago(PAUSE_MAX_MS + 1000);
    await e.pool.query(`update lots set closes_at=$2 where id=$1`, [a.lot, new Date(ms(pausedAt) + 60_000)]);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [a.show.id, pausedAt]);
    expect(await e.bid(a.lot, a.bob, 50n * USDC)).toMatchObject({ ok: true });
    expect((await showRow(e, a.show.id)).paused_at).toBeNull();
    expect((await e.events(a.show.id)).filter((x) => x.kind === 'show.resumed')).toHaveLength(1);
  });

  t('a lot whose shifted deadline has passed by the time the pause is noticed closes on its shifted deadline, with the sale recorded', async (e) => {
    const a = await arena(e);
    await e.bid(a.lot, a.bob, 120n * USDC); // above the reserve
    // paused 7 minutes ago with 30 s left: it resumed 2 minutes ago and its 30 s are long over
    const pausedAt = ago(7 * 60_000);
    await e.pool.query(`update lots set closes_at=$2 where id=$1`, [a.lot, new Date(ms(pausedAt) + 30_000)]);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [a.show.id, pausedAt]);
    expect(await e.svc.advanceShow(a.show.id)).toMatchObject({ closed: 1 });
    const lot = await e.lot(a.lot);
    expect(lot.state).toBe('sold');
    expect(ms(lot.closed_at)).toBe(ms(pausedAt) + 30_000 + PAUSE_MAX_MS);
    const kinds = (await e.events(a.show.id)).map((x) => x.kind);
    expect(kinds.indexOf('show.resumed')).toBeGreaterThan(-1);
    expect(kinds.indexOf('show.resumed')).toBeLessThan(kinds.indexOf('lot.sold'));
  });

  t('ending a paused show resumes it first: the open lot runs to its shifted end', async (e) => {
    const a = await arena(e, { closesIn: 90 });
    await e.svc.pauseShow(a.show.id, a.actor);
    const before = await e.lot(a.lot);
    await new Promise((r) => setTimeout(r, 1100));
    const ended = await e.svc.endShow(a.show.id, a.actor);
    expect(ended.status).toBe('ended');
    const after = await e.lot(a.lot);
    expect(after.state).toBe('open');
    expect(ms(after.closes_at)).toBeGreaterThan(ms(before.closes_at) + 1000);
    expect((await showRow(e, a.show.id)).paused_at).toBeNull();
    const kinds = (await e.events(a.show.id)).map((x) => x.kind);
    expect(kinds.filter((k) => k.startsWith('show.')).slice(-3)).toEqual(['show.paused', 'show.resumed', 'show.ended']);
    expect(await e.bid(a.lot, a.bob, 50n * USDC)).toMatchObject({ ok: true }); // the lot on the block keeps taking bids until it closes
  });

  t('while paused the seller can still withdraw a lot without bids but cannot extend it', async (e) => {
    const a = await arena(e);
    await e.svc.pauseShow(a.show.id, a.actor);
    expect(await code(e.svc.controlLot({ lotId: a.lot, actorProfileId: a.seller.id, action: 'extend', seconds: 30 }))).toBe('show_paused');
    await e.svc.controlLot({ lotId: a.lot, actorProfileId: a.seller.id, action: 'withdraw' });
    expect((await e.lot(a.lot)).state).toBe('withdrawn');
    await e.svc.resumeShow(a.show.id, a.actor); // nothing on the block: resuming still works and says so
    const rev = (await e.events(a.show.id)).find((x) => x.kind === 'show.resumed')!;
    expect(rev.payload).toMatchObject({ lotId: null, lotNumber: null, closesAt: null, shiftedMs: expect.any(Number) });
  });

  t('while paused the next lot does not open, even when the gap would be over', async (e) => {
    const a = await arena(e, { second: true });
    await e.bid(a.lot, a.bob, 120n * USDC);
    await e.svc.pauseShow(a.show.id, a.actor);
    await e.pool.query(`update shows set paused_at=$2 where id=$1`, [a.show.id, ago(60_000)]);
    await e.pool.query(`update lots set closes_at=$2 where id=$1`, [a.lot, ago(30_000)]);
    expect(await e.svc.advanceShow(a.show.id)).toMatchObject({ opened: 0, closed: 0 });
    expect((await e.lot(a.show.lots[1])).state).toBe('catalogued');
  });
});

describe('the bid log and the audit trail', () => {
  t('a pause leaves the signed bid log untouched: same rows, same hash in the settlement, pause events in the feed in order', async (e) => {
    const a = await arena(e, { closesIn: 90 });
    expect(await e.bid(a.lot, a.bob, 110n * USDC)).toMatchObject({ ok: true });
    await e.svc.pauseShow(a.show.id, a.actor);
    expect(await e.bid(a.lot, a.amy, 120n * USDC)).toMatchObject({ ok: false, code: 'show_paused' }); // refused bids never enter the log
    await e.svc.resumeShow(a.show.id, a.actor);
    expect(await e.bid(a.lot, a.amy, 120n * USDC)).toMatchObject({ ok: true });
    await e.pool.query(`update lots set closes_at=$2 where id=$1`, [a.lot, ago(1000)]);
    expect(await e.svc.advanceShow(a.show.id)).toMatchObject({ closed: 1 });
    const { rows: bidRows } = await e.pool.query(`select id, message, signature, placed_at as "placedAt" from bids where lot_id=$1`, [a.lot]);
    expect(bidRows).toHaveLength(2);
    const { rows: [st] } = await e.pool.query(`select bid_log_hash, memo from settlements where lot_id=$1`, [a.lot]);
    expect(st.bid_log_hash).toBe(bidLogHash(bidRows));
    expect(st.memo).toContain(st.bid_log_hash);
    const kinds = (await e.events(a.show.id)).map((x) => x.kind).filter((k) => k !== 'settlement.awaiting');
    expect(kinds).toEqual(['bid.placed', 'show.paused', 'show.resumed', 'bid.placed', 'lot.sold']);
    // every bid was placed while the room was running
    const paused = (await e.pool.query(`select created_at from show_events where show_id=$1 and kind='show.paused'`, [a.show.id])).rows[0].created_at;
    const resumed = (await e.pool.query(`select created_at from show_events where show_id=$1 and kind='show.resumed'`, [a.show.id])).rows[0].created_at;
    for (const b of bidRows) expect(ms(b.placedAt) <= ms(paused) || ms(b.placedAt) >= ms(resumed)).toBe(true);
  });
});

describe('the audit log', () => {
  const audit = async (e: Env, showId: string) => (await e.pool.query(`select action, actor_wallet, detail from audit_logs where target=$1 order by created_at, id`, [showId])).rows;

  t('records who paused and who resumed (wallet in the audit log only, never in the public feed), and a timer resume without a wallet', async (e) => {
    const a = await arena(e);
    await e.svc.pauseShow(a.show.id, a.actor);
    await e.svc.resumeShow(a.show.id, a.actor);
    const rows = await audit(e, a.show.id);
    expect(rows.map((r) => r.action)).toEqual(['show.pause', 'show.resume']);
    expect(rows[0]).toMatchObject({ actor_wallet: a.seller.wallet, detail: { by: 'seller', count: 1, lotId: a.lot } });
    expect(rows[1]).toMatchObject({ actor_wallet: a.seller.wallet, detail: { by: 'seller', auto: false, lotId: a.lot } });
    expect(JSON.stringify(await e.events(a.show.id))).not.toContain(a.seller.wallet);

    const b = await arena(e);
    await e.pool.query(`update shows set paused_at=$2, pause_count=1 where id=$1`, [b.show.id, ago(PAUSE_MAX_MS + 5000)]);
    await e.svc.advanceShow(b.show.id);
    expect(await audit(e, b.show.id)).toMatchObject([{ action: 'show.resume', actor_wallet: null, detail: { by: 'timer', auto: true, shiftedMs: PAUSE_MAX_MS } }]);
  });

  t('an operator pause on the house show is recorded as the operator', async (e) => {
    const op = await e.profile();
    process.env.OPERATOR_WALLETS = op.wallet;
    try {
      const house = await arena(e, { isHouse: true });
      await e.svc.pauseShow(house.show.id, { profileId: op.id, wallet: op.wallet });
      expect((await audit(e, house.show.id))[0]).toMatchObject({ action: 'show.pause', actor_wallet: op.wallet, detail: { by: 'operator' } });
    } finally { delete process.env.OPERATOR_WALLETS; }
  });
});

describe('a pause racing a bid', () => {
  t('every bid is either accepted before the pause or refused: none is recorded while paused', async (e) => {
    for (let round = 0; round < 12; round++) {
      const a = await arena(e, { closesIn: 120 });
      const [p, b] = await Promise.allSettled([e.svc.pauseShow(a.show.id, a.actor), e.bid(a.lot, a.bob, 50n * USDC)]);
      expect(p.status).toBe('fulfilled');
      const row = await showRow(e, a.show.id);
      expect(row.paused_at).not.toBeNull();
      const { rows } = await e.pool.query(`select placed_at from bids where lot_id=$1`, [a.lot]);
      if (b.status === 'fulfilled' && b.value.ok) {
        expect(rows).toHaveLength(1);
        expect(ms(rows[0].placed_at)).toBeLessThanOrEqual(ms(row.paused_at) + 1); // placed before the pause took hold
      } else {
        expect(rows).toHaveLength(0);
        if (b.status === 'fulfilled' && !b.value.ok) expect(b.value.code).toBe('show_paused');
      }
      // the pause saw the lot as it stood, bid or not: resuming gives back exactly what it had
      const ev = (await e.events(a.show.id)).find((x) => x.kind === 'show.paused')!;
      const lot = await e.lot(a.lot);
      expect(ev.payload.msLeft).toBe(ms(lot.closes_at) - ms(row.paused_at));
    }
  }, 120_000);

  t('two simultaneous pauses use one pause', async (e) => {
    const a = await arena(e);
    const r = await Promise.allSettled([e.svc.pauseShow(a.show.id, a.actor), e.svc.pauseShow(a.show.id, a.actor), e.svc.pauseShow(a.show.id, a.actor)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await showRow(e, a.show.id)).pause_count).toBe(1);
    expect((await e.events(a.show.id)).filter((x) => x.kind === 'show.paused')).toHaveLength(1);
  });

  t('two simultaneous resumes shift the deadline once', async (e) => {
    const a = await arena(e);
    await e.svc.pauseShow(a.show.id, a.actor);
    await new Promise((r) => setTimeout(r, 300));
    const r = await Promise.allSettled([e.svc.resumeShow(a.show.id, a.actor), e.svc.resumeShow(a.show.id, a.actor)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rev = (await e.events(a.show.id)).filter((x) => x.kind === 'show.resumed');
    expect(rev).toHaveLength(1);
    expect(Number((await e.lot(a.lot)).paused_ms)).toBe(rev[0].payload.shiftedMs);
  });
});
