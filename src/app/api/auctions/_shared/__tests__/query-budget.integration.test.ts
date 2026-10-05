/**
 * How many SQL statements one request costs (BEGIN and COMMIT count). On the real stack every statement is one round trip to Neon, and
 * a bid holds the lot's row lock for all of them, so this number is the latency of the hottest path and the DB work per viewer poll.
 * Pinned with a little headroom: a change that adds queries to a bid or to the polled snapshot fails here and has to say why.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { actor, bidBody, bidder, idCtx, req, startKit, USDC, type Kit } from './kit';

/** Measured 13 to 14 for a bid (3 before its transaction, about 9 inside it, 3 for the snapshot it answers with) and 3 for a cold snapshot. */
const BID_BUDGET = 16;
const POLL_BUDGET = 4;
/**
 * The schedule page (/rooms) asks GET /api/shows four times at once: the demo room, live, upcoming and ended. Measured 7 statements in all: ONE shared check for
 * due shows (the four lists share it while it runs) plus the advance of the one open show in the kit, and four list queries, each of which picks its page of shows
 * and counts only their lots. It was 13 here (each list did its own check and advance) and about 30 on a real deployment, where each list also ran the house check
 * (now shared too: src/server/house/sweep.ts). 8 leaves room for one more read, not for a query per row.
 */
const SCHEDULE_BUDGET = 8;
/** The room's catalogue (GET /api/shows/:id) is the show and its lots. */
const CATALOGUE_BUDGET = 2;

let kit: Kit | undefined; let skipReason: string | undefined;
let bid: (r: Request) => Promise<Response>;
let shows: (r: Request) => Promise<Response>;
let showOne: (r: Request, c: ReturnType<typeof idCtx>) => Promise<Response>;
let live: (r: Request, c: ReturnType<typeof idCtx>) => Promise<Response>;
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  bid = (await import('@/app/api/bids/route')).POST;
  live = (await import('@/app/api/auctions/[id]/live/route')).GET;
  shows = (await import('@/app/api/shows/route')).GET;
  showOne = (await import('@/app/api/shows/[id]/route')).GET;
}, 180_000);
afterAll(async () => { await kit?.stop(); });

/** Counts every statement the application's own pool sends while `fn` runs. */
async function statements(fn: () => Promise<void>): Promise<number> {
  const proto = pg.Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const real = proto.query;
  let n = 0;
  proto.query = function (this: unknown, ...a: unknown[]) { n++; return real.apply(this, a); };
  try { await fn(); } finally { proto.query = real; }
  return n;
}

describe('statements per request', () => {
  it('a bid and a cold snapshot stay inside their budgets', async (ctx) => {
    if (!kit) return ctx.skip(skipReason);
    const seller = await kit.env.profile({ wallet: actor().wallet });
    const s = await kit.env.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 3_600_000) }] });
    const bob = await bidder(kit.env, s.id), amy = await bidder(kit.env, s.id);
    const lotId = s.lots[0];
    await kit.env.pool.query('delete from rate_limits');

    const first = bidBody({ showId: s.id, lotId, amount: 50n * USDC, who: bob });
    let status = 0;
    const perBid = await statements(async () => { status = (await bid(req('/api/bids', { body: first }))).status; });
    expect(status).toBe(200);
    const second = bidBody({ showId: s.id, lotId, amount: 55n * USDC, who: amy });
    const perBid2 = await statements(async () => { status = (await bid(req('/api/bids', { body: second }))).status; });
    expect(status).toBe(200);
    const perPoll = await statements(async () => { status = (await live(req(`/api/auctions/${s.id}/live`), idCtx(s.id))).status; });
    expect(status).toBe(200);
    console.log(`statements: bid ${perBid} / ${perBid2}, cold snapshot ${perPoll}`);
    expect(Math.max(perBid, perBid2)).toBeLessThanOrEqual(BID_BUDGET);
    expect(perPoll).toBeLessThanOrEqual(POLL_BUDGET);
  });
});

describe('statements for the schedule and the room page', () => {
  it('the four lists of the schedule page and the catalogue of a room stay inside their budgets, however many shows exist', async (ctx) => {
    if (!kit) return ctx.skip(skipReason);
    const seller = await kit.env.profile({ wallet: actor().wallet });
    // Many ended shows with lots: the list must not read them all to show eight.
    for (let i = 0; i < 12; i++) await kit.env.show({ sellerId: seller.id, status: 'ended', lots: [{ state: 'sold' }, { state: 'passed' }] });
    const s = await kit.env.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 3_600_000) }] });

    const schedule = ['?house=only&limit=8', '?status=live&house=exclude&limit=10', '?status=scheduled&house=exclude&limit=30', '?status=ended&house=exclude&limit=10'];
    const statuses: number[] = [];
    const perSchedule = await statements(async () => {
      for (const r of await Promise.all(schedule.map((q) => shows(req(`/api/shows${q}`))))) statuses.push(r.status);
    });
    expect(statuses).toEqual([200, 200, 200, 200]);
    const perCatalogue = await statements(async () => { statuses.push((await showOne(req(`/api/shows/${s.id}`), idCtx(s.id))).status); });
    expect(statuses[4]).toBe(200);
    console.log(`statements: schedule (4 lists) ${perSchedule}, catalogue ${perCatalogue}`);
    expect(perSchedule).toBeLessThanOrEqual(SCHEDULE_BUDGET);
    expect(perCatalogue).toBeLessThanOrEqual(CATALOGUE_BUDGET);
  });

  it('a list answers with the right counts for the page it picked', async (ctx) => {
    if (!kit) return ctx.skip(skipReason);
    const seller = await kit.env.profile({ wallet: actor().wallet });
    const a = await kit.env.show({ sellerId: seller.id, status: 'ended', lots: [{ state: 'sold' }, { state: 'sold' }, { state: 'passed' }] });
    const body = await (await shows(req('/api/shows?status=ended&limit=50'))).json() as { shows: { id: string; lotCount: number; soldCount: number }[] };
    const row = body.shows.find((x) => x.id === a.id);
    expect(row).toMatchObject({ lotCount: 3, soldCount: 2 });
  });
});
