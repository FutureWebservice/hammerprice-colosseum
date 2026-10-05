/**
 * Timed shows (one lot, hours to days) on a real Postgres 18 with the real service and an injected clock:
 * the lazy clock closes a lot hours after its deadline at the deadline, anti-sniping works over minutes, the settlement window and the
 * seller's extend follow the show's kind, createShow refuses what a timed show must not be, and the lists carry the kind and the deadline.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LiveSnapshot, ShowDetail, ShowListResponse } from '@/contracts';
import { clearFlagMemo } from '@/app/api/auctions/_shared/flags';
import { startEnv, USDC, type Env } from './harness';

let env: Env | undefined; let skipReason: string | undefined;
beforeAll(async () => { const r = await startEnv(); if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); } else env = r.env; }, 180_000);
afterAll(async () => { await env?.stop(); });
afterEach(() => { vi.unstubAllEnvs(); clearFlagMemo(); });
const t = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

// Relative to now: the seller's extend runs on the real clock, so a fixed date in the past would have the lot already closed.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const at = (ms: number) => new Date(T0.getTime() + ms);
const S = 1000;
const MIN = 60 * S;
const H = 3600 * S;
const D = 24 * H;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const mint = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
const timedOn = () => { vi.stubEnv('FEATURE_TIMED', 'true'); clearFlagMemo(); };

/** A timed show through the real createShow (as the house rollover makes it). */
async function createTimed(e: Env, over: Record<string, unknown> = {}, lots = 1) {
  const seller = await e.profile();
  const mints = Array.from({ length: lots }, mint);
  const d = ShowDetail.parse(await e.svc.createShow({
    title: 'Timed lot', format: 'auction', mode: 'auto', kind: 'timed', isHouse: true, sellerProfileId: seller.id, scheduledAt: T0.toISOString(),
    lots: mints.map((m) => ({ mint: m, reserve: String(50n * USDC), openingPrice: String(50n * USDC), increment: String(5n * USDC) })),
    readiness: Object.fromEntries(mints.map((m) => [m, { eligible: true, reasons: [] }])), assets: Object.fromEntries(mints.map((m) => [m, { name: 'Charizard' }])), ...over,
  } as Parameters<typeof e.svc.createShow>[0]));
  return { seller, show: d.show, lot: d.lots[0].id };
}

describe('the lazy clock over hours and days', () => {
  t('a day-long lot: opens at the start, anti-snipes in minutes, closes at the deadline when read hours late, settlement window 72 h, show ends in the same read', async (e) => {
    timedOn();
    const { seller, show, lot } = await createTimed(e);
    expect(show.kind).toBe('timed');
    const [bob, amy] = [await e.profile(), await e.profile()];
    await e.paddle(show.id, bob.id, { hours: 24 * 60 }); await e.paddle(show.id, amy.id, { hours: 24 * 60 });

    expect(await e.svc.advanceShow(show.id, at(-1000))).toMatchObject({ wentLive: false, opened: 0 });
    expect(await e.svc.advanceShow(show.id, T0)).toEqual({ showId: show.id, wentLive: true, closed: 0, opened: 1, ended: false });
    let l = await e.lot(lot);
    expect(l.closes_at.getTime()).toBe(T0.getTime() + D); // the default timed duration: one day

    // A bid hours before the end changes nothing; a bid inside the last 5 minutes moves the deadline to now + 5 minutes.
    expect(await e.bid(lot, bob, 50n * USDC, { now: at(3 * H) })).toMatchObject({ ok: true, extended: false, closesAt: new Date(T0.getTime() + D).toISOString() });
    const lateBid = T0.getTime() + D - 4 * MIN;
    expect(await e.bid(lot, amy, 55n * USDC, { now: new Date(lateBid) })).toMatchObject({ ok: true, extended: true, closesAt: new Date(lateBid + 5 * MIN).toISOString() });
    l = await e.lot(lot);
    expect(l.closes_at.getTime()).toBe(lateBid + 5 * MIN);
    expect((await e.events(show.id)).filter((x) => x.kind === 'lot.extended')).toHaveLength(1);

    // Nobody looked for 9 hours after the deadline. The first reader closes the lot AT the deadline, not at the time they noticed.
    const deadline = lateBid + 5 * MIN;
    expect(await e.svc.advanceShow(show.id, new Date(deadline - 1))).toMatchObject({ closed: 0, ended: false });
    expect(await e.svc.advanceShow(show.id, new Date(deadline + 9 * H))).toEqual({ showId: show.id, wentLive: false, closed: 1, opened: 0, ended: true });
    l = await e.lot(lot);
    expect(l).toMatchObject({ state: 'sold', closed_reason: 'timer', high_bid: String(55n * USDC), high_bidder_id: amy.id });
    expect(l.closed_at.getTime()).toBe(deadline);

    const { rows: [st] } = await e.pool.query(`select * from settlements where lot_id = $1`, [lot]);
    expect(st).toMatchObject({ buyer_id: amy.id, seller_id: seller.id, status: 'awaiting_payment' });
    expect(st.due_at.getTime()).toBe(deadline + 72 * H); // the lateness never shortens the window
    expect((await e.pool.query(`select status from shows where id = $1`, [show.id])).rows[0].status).toBe('ended');
    expect(await e.svc.advanceShow(show.id, new Date(deadline + 10 * H))).toMatchObject({ closed: 0, ended: false }); // idempotent
  });

  t('a lot with no bid passes, with no settlement, and the show ends', async (e) => {
    timedOn();
    const { show, lot } = await createTimed(e, { rules: { lotDurationS: 3600 } });
    await e.svc.advanceShow(show.id, T0);
    expect((await e.lot(lot)).closes_at.getTime()).toBe(T0.getTime() + H);
    expect(await e.svc.advanceShow(show.id, at(2 * H))).toMatchObject({ closed: 1, ended: true });
    expect(await e.lot(lot)).toMatchObject({ state: 'passed' });
    expect((await e.pool.query(`select count(*)::int n from settlements where lot_id = $1`, [lot])).rows[0].n).toBe(0);
  });

  t('the extension total is capped: with maxExtensionS 10 minutes the deadline never passes duration + 10 minutes', async (e) => {
    timedOn();
    const { show, lot } = await createTimed(e, { rules: { lotDurationS: 3600, maxExtensionS: 600, snipeWindowS: 300, snipeExtendS: 300 } });
    const bidders = [await e.profile(), await e.profile()];
    for (const b of bidders) await e.paddle(show.id, b.id, { hours: 24 * 60 });
    await e.svc.advanceShow(show.id, T0);
    const cap = T0.getTime() + H + 10 * MIN;
    let amount = 50n * USDC;
    let n = 0;
    for (let now = T0.getTime() + H - 4 * MIN; now < cap; now += 3 * MIN) {
      const r = await e.bid(lot, bidders[n++ % 2], amount, { now: new Date(now) });
      amount += 5n * USDC;
      if (!r.ok) break;
      expect(r.closesAt <= new Date(cap).toISOString()).toBe(true);
    }
    expect((await e.lot(lot)).closes_at.getTime()).toBe(cap);
  });

  t('a bid that arrives after the deadline, before anyone advanced the clock, closes the lot (lot_closed) at the deadline', async (e) => {
    timedOn();
    const { show, lot } = await createTimed(e, { rules: { lotDurationS: 3600 } });
    const bob = await e.profile();
    await e.paddle(show.id, bob.id, { hours: 24 * 60 });
    await e.svc.advanceShow(show.id, T0);
    expect(await e.bid(lot, bob, 50n * USDC, { now: at(H + 5 * H) })).toMatchObject({ ok: false, code: 'lot_closed' });
    const l = await e.lot(lot);
    expect(l.state).toBe('passed');
    expect(l.closed_at.getTime()).toBe(T0.getTime() + H);
  });

  t('a live show on the same service keeps its short clock and its 15 minute settlement window', async (e) => {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'scheduled', scheduledAt: T0, rules: { lotDurationS: 3600 }, lots: [{ reserve: 50n * USDC }] });
    const bob = await e.profile();
    await e.paddle(s.id, bob.id, { hours: 24 * 60 });
    await e.svc.advanceShow(s.id, T0);
    expect((await e.lot(s.lots[0])).closes_at.getTime()).toBe(T0.getTime() + H);
    await e.bid(s.lots[0], bob, 50n * USDC, { now: at(10 * MIN) });
    await e.svc.advanceShow(s.id, at(H));
    const { rows: [st] } = await e.pool.query(`select due_at from settlements where lot_id = $1`, [s.lots[0]]);
    expect(st.due_at.getTime()).toBe(T0.getTime() + H + 900 * S);
  });

  t('the snapshot of a timed show says so and draws the phase from the timed thresholds', async (e) => {
    timedOn();
    const { show, lot } = await createTimed(e, { rules: { lotDurationS: 3600 }, scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await e.svc.advanceShow(show.id);
    const phaseWhenLeft = async (interval: string) => {
      await e.pool.query(`update lots set closes_at = now() + $2::interval where id = $1`, [lot, interval]);
      return LiveSnapshot.parse(await e.svc.getLiveSnapshot(show.id)).current?.phase;
    };
    expect(LiveSnapshot.parse(await e.svc.getLiveSnapshot(show.id)).show.kind).toBe('timed');
    expect(await phaseWhenLeft('30 minutes')).toBe('open');
    expect(await phaseWhenLeft('4 minutes')).toBe('going_once'); // inside the 5 minutes of callOnceS
    expect(await phaseWhenLeft('30 seconds')).toBe('going_twice'); // inside the last minute
  });
});

describe('createShow for a timed show', () => {
  t('is refused while FEATURE_TIMED is off and writes nothing', async (e) => {
    const before = (await e.pool.query(`select count(*)::int n from shows`)).rows[0].n;
    await expect(createTimed(e)).rejects.toMatchObject({ code: 'feature_off' });
    expect((await e.pool.query(`select count(*)::int n from shows`)).rows[0].n).toBe(before);
  });

  t('a stranger is refused plainly; an operator wallet and the house are allowed', async (e) => {
    timedOn();
    await expect(createTimed(e, { isHouse: false })).rejects.toMatchObject({ code: 'feature_off', message: expect.stringMatching(/Hammerprice room/) });
    const op = await e.profile();
    vi.stubEnv('OPERATOR_WALLETS', `${mint()}, ${op.wallet}`);
    const mints = [mint()];
    const d = ShowDetail.parse(await e.svc.createShow({
      title: 'Operator timed', format: 'auction', mode: 'auto', kind: 'timed', sellerProfileId: op.id, lots: [{ mint: mints[0] }],
      readiness: { [mints[0]]: { eligible: true, reasons: [] } },
    } as Parameters<typeof e.svc.createShow>[0]));
    expect(d.show).toMatchObject({ kind: 'timed', isHouse: false });
    await expect(createTimed(e, { isHouse: false })).rejects.toMatchObject({ code: 'feature_off' }); // another wallet is still a stranger
    expect((await createTimed(e)).show.kind).toBe('timed'); // the house
  });

  t('a timed auction has exactly one lot', async (e) => {
    timedOn();
    await expect(createTimed(e, {}, 2)).rejects.toMatchObject({ code: 'validation', message: expect.stringMatching(/exactly one lot/) });
    const one = await createTimed(e, {}, 1);
    expect(ShowDetail.parse(await e.svc.getCatalogue(one.show.id)).lots).toHaveLength(1);
  });

  t('the minimum length is 10 minutes: shorter is refused, never silently stretched; a devnet test environment may lower it', async (e) => {
    timedOn();
    await expect(createTimed(e, { rules: { lotDurationS: 300 } })).rejects.toMatchObject({ code: 'validation', message: expect.stringMatching(/at least 10 minutes/) });
    await expect(createTimed(e, { rules: { lotDurationS: 20 } })).rejects.toMatchObject({ code: 'validation' });
    expect((await createTimed(e, { rules: { lotDurationS: 600 } })).show.kind).toBe('timed');
    vi.stubEnv('TIMED_MIN_DURATION_S', '20');
    const short = await createTimed(e, { rules: { lotDurationS: 20 } });
    await e.svc.advanceShow(short.show.id, T0);
    expect((await e.lot(short.lot)).closes_at.getTime()).toBe(T0.getTime() + 20 * S);
  });

  t('on mainnet the test minimum has no effect', async (e) => {
    timedOn();
    vi.stubEnv('TIMED_MIN_DURATION_S', '20');
    vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta');
    await expect(createTimed(e, { rules: { lotDurationS: 20 }, cluster: 'mainnet-beta' })).rejects.toMatchObject({ code: 'validation', message: expect.stringMatching(/at least 10 minutes/) });
    expect((await createTimed(e, { rules: { lotDurationS: 600 }, cluster: 'mainnet-beta' })).show.kind).toBe('timed');
  });

  t('a live request for a long lot is still clamped to the live range (1 hour)', async (e) => {
    const seller = await e.profile();
    const m = mint();
    const d = ShowDetail.parse(await e.svc.createShow({
      title: 'Live clamp', format: 'auction', mode: 'auto', sellerProfileId: seller.id, rules: { lotDurationS: 86_400, maxExtensionS: 86_400 }, scheduledAt: T0.toISOString(),
      lots: [{ mint: m }], readiness: { [m]: { eligible: true, reasons: [] } },
    } as Parameters<typeof e.svc.createShow>[0]));
    await e.svc.advanceShow(d.show.id, T0);
    expect((await e.lot(d.lots[0].id)).closes_at.getTime()).toBe(T0.getTime() + H);
  });
});

describe("the seller's extend", () => {
  const extend = (e: Env, lotId: string, actor: string, seconds?: number) => e.svc.controlLot({ lotId, action: 'extend', actorProfileId: actor, ...(seconds === undefined ? {} : { seconds }) });

  t('a timed lot may be extended by up to an hour, a live lot by up to 10 minutes; both are bounded by the same cap', async (e) => {
    timedOn();
    const { seller, show, lot } = await createTimed(e, { rules: { lotDurationS: 3600, maxExtensionS: 7200 } });
    await e.svc.advanceShow(show.id, T0);
    await expect(extend(e, lot, seller.id, 3601)).rejects.toMatchObject({ code: 'validation' });
    await extend(e, lot, seller.id, 3600);
    expect((await e.lot(lot)).closes_at.getTime()).toBe(T0.getTime() + H + 3600 * S);

    const liveSeller = await e.profile();
    const s = await e.show({ sellerId: liveSeller.id, status: 'live', rules: { lotDurationS: 600 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 600_000) }] });
    await expect(extend(e, s.lots[0], liveSeller.id, 601)).rejects.toMatchObject({ code: 'validation', message: expect.stringMatching(/1 to 600/) });
    await expect(extend(e, s.lots[0], liveSeller.id, 600)).resolves.toBeTruthy();
  });
});

describe('the lists', () => {
  t('carry the kind and the deadline of the open lot, and filter by kind', async (e) => {
    timedOn();
    const { show, lot } = await createTimed(e, { rules: { lotDurationS: 7200 }, scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await e.svc.advanceShow(show.id);
    const deadline = (await e.lot(lot)).closes_at as Date;
    const onlyTimed = ShowListResponse.parse(await e.svc.listShows({ kind: 'timed', status: 'live', limit: 50 }));
    expect(onlyTimed.shows.find((x) => x.id === show.id)).toMatchObject({ kind: 'timed', status: 'live', closesAt: deadline.toISOString() });
    expect(onlyTimed.shows.every((x) => x.kind === 'timed')).toBe(true);
    const liveKind = ShowListResponse.parse(await e.svc.listShows({ kind: 'live', limit: 50 }));
    expect(liveKind.shows.some((x) => x.id === show.id)).toBe(false);
    // a show with no open lot has no deadline
    const ended = ShowListResponse.parse(await e.svc.listShows({ status: 'ended', limit: 50 }));
    expect(ended.shows.every((x) => x.closesAt == null)).toBe(true);
  });
});
