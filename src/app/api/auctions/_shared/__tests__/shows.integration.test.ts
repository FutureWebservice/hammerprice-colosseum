/**
 * Shows, the schedule, the seller's controls and the live snapshot through the real handlers (embedded Postgres 18, the real engine,
 * real signatures and sessions; only the chain is a fake). Every route here gets its success path and each contract error code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { ErrorResponseSchema, LiveSnapshot, LotControlResponse, LotResponse, ROUTES, ShowDetail, ShowListResponse, ShowResponse, type RouteKey } from '@/contracts';
import { actor, bodyOf, bidBody, bidder, freshIp, idCtx, req, resetLimits, signIn, startKit, USDC, type Kit } from './kit';

let kit: Kit | undefined; let skipReason: string | undefined;
type Handler = (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>;
let h: Record<string, Handler>;
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  h = {
    showsGet: (await import('@/app/api/shows/route')).GET as Handler,
    showsPost: (await import('@/app/api/shows/route')).POST as Handler,
    show: (await import('@/app/api/shows/[id]/route')).GET as Handler,
    goLive: (await import('@/app/api/shows/[id]/go-live/route')).POST as Handler,
    end: (await import('@/app/api/shows/[id]/end/route')).POST as Handler,
    cancel: (await import('@/app/api/shows/[id]/cancel/route')).POST as Handler,
    pause: (await import('@/app/api/shows/[id]/pause/route')).POST as Handler,
    resume: (await import('@/app/api/shows/[id]/resume/route')).POST as Handler,
    lotPatch: (await import('@/app/api/lots/[id]/route')).PATCH as Handler,
    control: (await import('@/app/api/lots/[id]/control/route')).POST as Handler,
    live: (await import('@/app/api/auctions/[id]/live/route')).GET as Handler,
    bids: (await import('@/app/api/bids/route')).POST as Handler,
  };
}, 180_000);
afterAll(async () => { await kit?.stop(); });

const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);
const code = async (res: Response) => ErrorResponseSchema.parse(await res.json()).code;
const mint = () => actor().wallet; // a base58 32-byte key is a well-formed mint address
const inFuture = (s: number) => new Date(Date.now() + s * 1000);

/** A signed-in seller: cookie plus the profile id the session maps to. */
async function seller(k: Kit) {
  const a = actor();
  const cookie = await signIn(a);
  return { a, cookie, id: (await k.env.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet])).rows[0].id as string };
}
const createBody = (n = 2, over: Record<string, unknown> = {}) => ({ title: 'Saturday night slabs', lots: Array.from({ length: n }, () => ({ mint: mint() })), ...over });
const post = (handler: Handler, p: string, cookie: string | undefined, body?: unknown, c?: string) => handler(req(p, { body: body ?? '', cookie, method: 'POST' }), c ? idCtx(c) : undefined);
const expectCdn = (res: Response, cdnS: number) => { expect(res.headers.get('vercel-cdn-cache-control')).toBe(`max-age=${cdnS}`); expect(res.headers.get('cache-control')).toBe('no-store'); expect(`${res.headers.get('cache-control')}${res.headers.get('vercel-cdn-cache-control')}`).not.toContain('stale-while-revalidate'); };
const expectNoCdn = (res: Response) => { expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('vercel-cdn-cache-control')).toBeNull(); };

describe('POST /api/shows', () => {
  t('creates a scheduled show with its lots in one transaction (201, the contract shape, never house)', async (k) => {
    const s = await seller(k);
    const res = await h.showsPost(req('/api/shows', { body: createBody(3, { scheduledAt: inFuture(3600).toISOString(), rules: { lotDurationS: 30 } }), cookie: s.cookie }));
    expect(res.status).toBe(201);
    expectNoCdn(res);
    const body = ShowDetail.parse(await res.json());
    expect(body.show).toMatchObject({ status: 'scheduled', mode: 'auto', settlementMode: 'onchain', cluster: 'devnet', isHouse: false });
    expect(body.lots.map((l) => l.lotNumber)).toEqual([1, 2, 3]);
    expect(body.lots.every((l) => l.consignStatus === 'ready' && l.nftStandard === 'core')).toBe(true);
    const { rows: [row] } = await k.env.pool.query(`select seller_id, is_house, rules from shows where id = $1`, [body.show.id]);
    expect(row).toMatchObject({ seller_id: s.id, is_house: false, rules: { lotDurationS: 30 } });
    expect((await k.env.pool.query(`select is_seller from profiles where id = $1`, [s.id])).rows[0].is_seller).toBe(true);
  });

  t('the settlement window is the platform\'s, not the seller\'s: a seller cannot give winners 60 seconds (strikes, then a ban) or 7 days (funds counted as owed)', async (k) => {
    const s = await seller(k);
    for (const settlementWindowS of [60, 900, 7 * 86_400]) {
      const res = await h.showsPost(req('/api/shows', { body: createBody(1, { rules: { settlementWindowS } }), cookie: s.cookie }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('validation');
    }
    expect((await k.env.pool.query(`select count(*)::int c from shows where seller_id = $1`, [s.id])).rows[0].c).toBe(0);
  });

  t('lot length: a preset is accepted and shown, 45 s stays the default, under 10 s is a 400 (contract), over an hour is clamped to an hour as before', async (k) => {
    const s = await seller(k);
    const made = ShowDetail.parse(await (await h.showsPost(req('/api/shows', { body: createBody(1, { rules: { lotDurationS: 90 } }), cookie: s.cookie }))).json());
    expect(made.show.lotDurationS).toBe(90);
    await resetLimits(k.env);
    expect(ShowDetail.parse(await (await h.showsPost(req('/api/shows', { body: createBody(1), cookie: s.cookie }))).json()).show.lotDurationS).toBe(45);
    await resetLimits(k.env);
    const tooShort = await h.showsPost(req('/api/shows', { body: createBody(1, { rules: { lotDurationS: 5 } }), cookie: s.cookie }));
    expect(tooShort.status).toBe(400);
    expect(await code(tooShort)).toBe('validation');
    await resetLimits(k.env);
    const long = await h.showsPost(req('/api/shows', { body: createBody(1, { rules: { lotDurationS: 7200 } }), cookie: s.cookie }));
    expect(ShowDetail.parse(await long.json()).show.lotDurationS).toBe(3600); // the engine's own clamp, the show reports what the room will use
    expect((await k.env.pool.query(`select count(*)::int c from shows where seller_id = $1`, [s.id])).rows[0].c).toBe(3);
  });

  t('takes name, photo and grade of a devnet replica from devnet_assets', async (k) => {
    const s = await seller(k);
    const m = mint();
    await k.env.pool.query(`insert into devnet_assets (mint, owner_wallet, name, image_url, attributes) values ($1, $2, 'Charizard (devnet replica)', 'https://img.example/c.png', '{"grade":"PRISTINE 10","grading_company":"CGC","set":"Base"}'::jsonb)`, [m, s.a.wallet]);
    const body = ShowDetail.parse(await (await h.showsPost(req('/api/shows', { body: { title: 'Replica night', lots: [{ mint: m, reserve: '100000000' }] }, cookie: s.cookie }))).json());
    expect(body.lots[0]).toMatchObject({ name: 'Charizard (devnet replica)', imageUrl: 'https://img.example/c.png', grade: 'PRISTINE 10', gradingCompany: 'CGC', setName: 'Base', reserve: '100000000' });
  });

  t('refuses without a session (401), from another origin (403), and with the wrong content type (400)', async (k) => {
    const s = await seller(k);
    const none = await h.showsPost(req('/api/shows', { body: createBody() }));
    expect(none.status).toBe(401);
    expect(await code(none)).toBe('unauthenticated');
    const evil = await h.showsPost(req('/api/shows', { body: createBody(), cookie: s.cookie, headers: { origin: 'https://evil.example' } }));
    expect(evil.status).toBe(403);
    expect(await code(evil)).toBe('forbidden');
    expect((await h.showsPost(req('/api/shows', { body: 'title=x', cookie: s.cookie, headers: { 'content-type': 'text/plain' } }))).status).toBe(400);
  });

  t('validation: no lots, 31 lots, manual mode, unknown fields, an odd title, the same card twice, an out-of-range price', async (k) => {
    const s = await seller(k);
    const bad: unknown[] = [
      createBody(0), createBody(31), createBody(1, { mode: 'manual' }), createBody(1, { extra: true }), createBody(1, { isHouse: true }), createBody(1, { isBot: true }), createBody(1, { title: 'x' }), createBody(1, { title: '<script>alert(1)</script>' }),
      { title: 'Valid title', lots: [{ mint: 'short' }] }, { title: 'Valid title', lots: [{ mint: mint(), reserve: '-1' }] },
    ];
    for (const b of bad) {
      const res = await h.showsPost(req('/api/shows', { body: b, cookie: s.cookie }));
      expect(res.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(await code(res)).toBe('validation');
    }
    const dup = mint();
    expect((await h.showsPost(req('/api/shows', { body: { title: 'Twice the card', lots: [{ mint: dup }, { mint: dup }] }, cookie: s.cookie }))).status).toBe(400);
    expect((await h.showsPost(req('/api/shows', { body: { title: 'Too dear', lots: [{ mint: mint(), reserve: String(10n ** 13n) }] }, cookie: s.cookie }))).status).toBe(400);
  });

  t('refuses a card that cannot be consigned with the readiness reason as the contract code, and creates nothing', async (k) => {
    const s = await seller(k);
    const before = (await k.env.pool.query(`select count(*)::int c from shows`)).rows[0].c;
    const cases: Array<[string[], number, string]> = [
      [['not_owner'], 403, 'not_owner'], [['not_found'], 403, 'not_owner'], [['frozen'], 409, 'frozen'], [['unsupported_standard'], 409, 'unsupported_standard'],
      [['royalty_rules_block_transfer'], 409, 'asset_not_ready'], [['foreign_delegate_blocks'], 409, 'asset_not_ready'],
    ];
    for (const [reasons, status, expected] of cases) {
      await resetLimits(k.env);
      const bad = mint();
      k.fake.readiness.set(bad, reasons);
      const res = await h.showsPost(req('/api/shows', { body: { title: 'One bad card', lots: [{ mint: mint() }, { mint: bad }] }, cookie: s.cookie }));
      expect(res.status, reasons.join()).toBe(status);
      expect(await code(res)).toBe(expected);
    }
    expect((await k.env.pool.query(`select count(*)::int c from shows`)).rows[0].c).toBe(before); // one ineligible card, no half-made show
  });

  t('seller_not_allowed when SELLER_ALLOWLIST names other wallets; rpc_unavailable when the chain cannot answer', async (k) => {
    const s = await seller(k);
    vi.stubEnv('SELLER_ALLOWLIST', `${actor().wallet}, ${actor().wallet}`);
    const no = await h.showsPost(req('/api/shows', { body: createBody(), cookie: s.cookie }));
    expect(no.status).toBe(403);
    expect(await code(no)).toBe('seller_not_allowed');
    vi.stubEnv('SELLER_ALLOWLIST', ` ${s.a.wallet} `);
    expect((await h.showsPost(req('/api/shows', { body: createBody(), cookie: s.cookie }))).status).toBe(201);
    vi.stubEnv('SELLER_ALLOWLIST', '');
    k.fake.readinessDown = true;
    await resetLimits(k.env);
    const down = await h.showsPost(req('/api/shows', { body: createBody(), cookie: s.cookie }));
    k.fake.readinessDown = false;
    expect(down.status).toBe(503);
    expect(await code(down)).toBe('rpc_unavailable');
  });

  t('rate_limited: the fourth show of the day is refused with Retry-After', async (k) => {
    const s = await seller(k);
    for (let n = 0; n < 3; n++) expect((await h.showsPost(req('/api/shows', { body: createBody(1), cookie: s.cookie }))).status).toBe(201);
    const res = await h.showsPost(req('/api/shows', { body: createBody(1), cookie: s.cookie }));
    expect(res.status).toBe(429);
    expect(await code(res.clone())).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('GET /api/shows and /api/shows/:id', () => {
  t('lists shows with the CDN cache header, filters by status, pages with a cursor', async (k) => {
    const s = await seller(k);
    const mk = (status: 'scheduled' | 'live' | 'ended') => k.env.show({ sellerId: s.id, status, lots: [{ state: 'catalogued' }, { state: 'catalogued' }] });
    const [live, sched, ended] = [await mk('live'), await mk('scheduled'), await mk('ended')];
    const res = await h.showsGet(req('/api/shows?limit=50'));
    expect(res.status).toBe(200);
    expectCdn(res, 5);
    expect(ROUTES.showsList.cache).toEqual({ cdnS: 5 });
    const body = ShowListResponse.parse(await res.json());
    const ids = body.shows.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([live.id, sched.id, ended.id]));
    expect(body.shows.find((x) => x.id === live.id)).toMatchObject({ status: 'live', lotCount: 2, soldCount: 0, hammerTotal: '0', isHouse: false });
    for (const status of ['live', 'scheduled', 'ended'] as const) {
      const f = ShowListResponse.parse(await (await h.showsGet(req(`/api/shows?status=${status}&limit=50`))).json());
      expect(f.shows.length).toBeGreaterThan(0);
      expect(f.shows.every((x) => x.status === status)).toBe(true);
    }
    const page1 = ShowListResponse.parse(await (await h.showsGet(req('/api/shows?limit=1'))).json());
    expect(page1.shows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = ShowListResponse.parse(await (await h.showsGet(req(`/api/shows?limit=1&cursor=${page1.nextCursor}`))).json());
    expect(page2.shows[0].id).not.toBe(page1.shows[0].id);
  });

  t('a seller cannot make a house show: isHouse in the body is refused, and a show made through the API is never a house show', async (k) => {
    const s = await seller(k);
    const res = await h.showsPost(req('/api/shows', { body: createBody(1, { isHouse: true }), cookie: s.cookie }));
    expect(res.status).toBe(400);
    const ok = await h.showsPost(req('/api/shows', { body: createBody(1), cookie: s.cookie }));
    expect(ok.status).toBe(201);
    const made = (await ok.json()) as { show: { id: string; isHouse: boolean } };
    expect(made.show.isHouse).toBe(false);
    expect((await k.env.pool.query(`select is_house from shows where id = $1`, [made.show.id])).rows[0].is_house).toBe(false);
    // ... and it is listed with the sellers' rooms, not with the demo.
    const sellers = ShowListResponse.parse(await (await h.showsGet(req('/api/shows?house=exclude&limit=50'))).json());
    expect(sellers.shows.map((x) => x.id)).toContain(made.show.id);
    const demo = ShowListResponse.parse(await (await h.showsGet(req('/api/shows?house=only&limit=50'))).json());
    expect(demo.shows.map((x) => x.id)).not.toContain(made.show.id);
    expect((await h.showsGet(req('/api/shows?house=maybe'))).status).toBe(400);
  });

  t('answers 400 for a bad status, a limit out of range or an unknown parameter', async () => {
    for (const q of ['status=bogus', 'limit=0', 'limit=51', 'limit=abc', 'foo=1']) {
      const res = await h.showsGet(req(`/api/shows?${q}`));
      expect(res.status, q).toBe(400);
      expect(await code(res)).toBe('validation');
    }
  });

  t('GET /api/shows/:id returns the catalogue (CDN 10 s), 404 for an unknown or malformed id', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }, { state: 'catalogued', reserve: null }] });
    const res = await h.show(req(`/api/shows/${show.id}`), idCtx(show.id));
    expect(res.status).toBe(200);
    expectCdn(res, 10);
    const body = ShowDetail.parse(await res.json());
    expect(body.show.id).toBe(show.id);
    expect(body.lots).toHaveLength(2);
    expect(body.lots[1].reserve).toBeNull();
    for (const id of ['8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', 'not-a-uuid', '1; drop table shows']) {
      const miss = await h.show(req(`/api/shows/${encodeURIComponent(id)}`), idCtx(id));
      expect(miss.status).toBe(404);
      expect(await code(miss)).toBe('not_found');
    }
  });
});

describe('go-live, end and cancel', () => {
  t('go-live starts the show and opens its first lot; end stops it; both answer the contract shape', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }, { state: 'catalogued' }] });
    const res = await post(h.goLive, `/api/shows/${show.id}/go-live`, s.cookie, undefined, show.id);
    expect(res.status).toBe(200);
    expectNoCdn(res);
    expect(ShowResponse.parse(await res.json()).show).toMatchObject({ id: show.id, status: 'live' });
    expect((await k.env.lot(show.lots[0])).state).toBe('open');
    const ended = await post(h.end, `/api/shows/${show.id}/end`, s.cookie, undefined, show.id);
    expect(ShowResponse.parse(await ended.json()).show.status).toBe('ended');
    expect((await k.env.lot(show.lots[1])).state).toBe('withdrawn'); // a lot that never opened is withdrawn with the show
  });

  t('cancel withdraws a show that has not started', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }] });
    const res = await post(h.cancel, `/api/shows/${show.id}/cancel`, s.cookie, undefined, show.id);
    expect(ShowResponse.parse(await res.json()).show.status).toBe('ended');
    expect((await k.env.pool.query(`select cancelled_at from shows where id = $1`, [show.id])).rows[0].cancelled_at).not.toBeNull();
  });

  t('not_seller (403) for another signed-in wallet, wrong_state (409) for the wrong moment, lots_not_ready (409)', async (k) => {
    const s = await seller(k); const other = await seller(k);
    const sched = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }] });
    const live = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'catalogued' }] });
    for (const [handler, p, id] of [[h.goLive, 'go-live', sched.id], [h.end, 'end', live.id], [h.cancel, 'cancel', sched.id]] as const) {
      const res = await post(handler, `/api/shows/${id}/${p}`, other.cookie, undefined, id);
      expect(res.status, p).toBe(403);
      expect(await code(res)).toBe('not_seller');
    }
    for (const [handler, p, id] of [[h.goLive, 'go-live', live.id], [h.end, 'end', sched.id], [h.cancel, 'cancel', live.id]] as const) {
      const res = await post(handler, `/api/shows/${id}/${p}`, s.cookie, undefined, id);
      expect(res.status, p).toBe(409);
      expect(await code(res)).toBe('wrong_state');
    }
    const notReady = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued', consign: 'pending' }] });
    const res = await post(h.goLive, `/api/shows/${notReady.id}/go-live`, s.cookie, undefined, notReady.id);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('lots_not_ready');
  });

  t('401 without a session, 403 across origins, 404 for an unknown show', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }] });
    expect((await post(h.goLive, `/api/shows/${show.id}/go-live`, undefined, undefined, show.id)).status).toBe(401);
    const evil = await h.goLive(req(`/api/shows/${show.id}/go-live`, { method: 'POST', cookie: s.cookie, headers: { origin: 'https://evil.example' } }), idCtx(show.id));
    expect(evil.status).toBe(403);
    expect(await code(evil)).toBe('forbidden');
    for (const id of ['8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', 'nope']) expect((await post(h.goLive, `/api/shows/${id}/go-live`, s.cookie, undefined, id)).status).toBe(404);
  });
});

describe('pause and resume (the seller\'s Rostrum)', () => {
  const liveShow = (k: Kit, sellerId: string, closesIn = 120) => k.env.show({ sellerId, lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(closesIn) }] });

  t('pause answers the contract shape, shows in the public snapshot, refuses a bid with show_paused (409) and resume gives the time back', async (k) => {
    const s = await seller(k);
    const show = await liveShow(k, s.id);
    const b = await bidder(k.env, show.id);
    const before = (await k.env.lot(show.lots[0])).closes_at as Date;

    const res = await post(h.pause, `/api/shows/${show.id}/pause`, s.cookie, undefined, show.id);
    expect(res.status).toBe(200);
    expectNoCdn(res);
    expect(ShowResponse.parse(await res.json()).show).toMatchObject({ id: show.id, status: 'live' });

    const live = LiveSnapshot.parse(await (await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id))).json());
    expect(live.show.pause).toMatchObject({ paused: true, used: 1, max: 2 });
    expect(live.events.at(-1)?.kind).toBe('show.paused');
    expect(live.current?.closesAt).toBe(before.toISOString());

    const refused = await h.bids(req('/api/bids', { body: bidBody({ showId: show.id, lotId: show.lots[0], amount: 50n * USDC, who: b }), ip: freshIp() }));
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe('show_paused');
    expect((await k.env.pool.query(`select count(*)::int c from bids where lot_id = $1`, [show.lots[0]])).rows[0].c).toBe(0);

    const back = await post(h.resume, `/api/shows/${show.id}/resume`, s.cookie, undefined, show.id);
    expect(back.status).toBe(200);
    expect(ShowResponse.parse(await back.json()).show.status).toBe('live');
    expect(((await k.env.lot(show.lots[0])).closes_at as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());
    const live2 = LiveSnapshot.parse(await (await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id))).json());
    expect(live2.show.pause).toMatchObject({ paused: false, used: 1 });
    expect(live2.events.at(-1)?.kind).toBe('show.resumed');
    await resetLimits(k.env); // the refused try counted against the 1 per 2 s limit
    const ok = await h.bids(req('/api/bids', { body: bidBody({ showId: show.id, lotId: show.lots[0], amount: 50n * USDC, who: b }), ip: freshIp() }));
    expect(ok.status).toBe(200);
  });

  t('not_seller (403) for another wallet, wrong_state (409) when not live or not paused, the limits as their own codes', async (k) => {
    const s = await seller(k); const other = await seller(k);
    const show = await liveShow(k, s.id);
    for (const [handler, p] of [[h.pause, 'pause'], [h.resume, 'resume']] as const) {
      const res = await post(handler, `/api/shows/${show.id}/${p}`, other.cookie, undefined, show.id);
      expect(res.status, p).toBe(403);
      expect(await code(res)).toBe('not_seller');
    }
    const resumeIdle = await post(h.resume, `/api/shows/${show.id}/resume`, s.cookie, undefined, show.id);
    expect(resumeIdle.status).toBe(409);
    expect(await code(resumeIdle)).toBe('wrong_state');
    const sched = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }] });
    expect(await code(await post(h.pause, `/api/shows/${sched.id}/pause`, s.cookie, undefined, sched.id))).toBe('wrong_state');

    const late = await liveShow(k, s.id, 5);
    const tooLate = await post(h.pause, `/api/shows/${late.id}/pause`, s.cookie, undefined, late.id);
    expect(tooLate.status).toBe(409);
    expect(await code(tooLate)).toBe('pause_too_late');

    await post(h.pause, `/api/shows/${show.id}/pause`, s.cookie, undefined, show.id);
    expect(await code(await post(h.pause, `/api/shows/${show.id}/pause`, s.cookie, undefined, show.id))).toBe('show_paused');
    await post(h.resume, `/api/shows/${show.id}/resume`, s.cookie, undefined, show.id);
    await post(h.pause, `/api/shows/${show.id}/pause`, s.cookie, undefined, show.id);
    await post(h.resume, `/api/shows/${show.id}/resume`, s.cookie, undefined, show.id);
    const third = await post(h.pause, `/api/shows/${show.id}/pause`, s.cookie, undefined, show.id);
    expect(third.status).toBe(409);
    expect(await code(third)).toBe('pause_limit');
  });

  t('401 without a session, 403 across origins, 404 for an unknown show', async (k) => {
    const s = await seller(k);
    const show = await liveShow(k, s.id);
    for (const [handler, p] of [[h.pause, 'pause'], [h.resume, 'resume']] as const) {
      expect((await post(handler, `/api/shows/${show.id}/${p}`, undefined, undefined, show.id)).status).toBe(401);
      const evil = await handler(req(`/api/shows/${show.id}/${p}`, { method: 'POST', cookie: s.cookie, headers: { origin: 'https://evil.example' } }), idCtx(show.id));
      expect(evil.status).toBe(403);
      expect(await code(evil)).toBe('forbidden');
      for (const id of ['8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', 'nope']) expect((await post(handler, `/api/shows/${id}/${p}`, s.cookie, undefined, id)).status).toBe(404);
    }
    expect((await k.env.pool.query(`select paused_at from shows where id = $1`, [show.id])).rows[0].paused_at).toBeNull();
  });
});

describe('PATCH /api/lots/:id and POST /api/lots/:id/control', () => {
  const patch = (cookie: string | undefined, id: string, body: unknown) => h.lotPatch(req(`/api/lots/${id}`, { method: 'PATCH', body, cookie }), idCtx(id));
  const control = (cookie: string | undefined, id: string, body: unknown) => h.control(req(`/api/lots/${id}/control`, { body, cookie }), idCtx(id));

  t('PATCH edits the terms before the lot opens, and answers the catalogue row', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }] });
    const res = await patch(s.cookie, show.lots[0], { reserve: '90000000', openingPrice: '40000000', increment: '2000000', buyNowPrice: '300000000' });
    expect(res.status).toBe(200);
    expectNoCdn(res);
    expect(LotResponse.parse(await res.json()).lot).toMatchObject({ reserve: '90000000', openingPrice: '40000000', increment: '2000000', buyNowPrice: '300000000' });
  });

  t('PATCH: wrong_state once open, not_seller for another wallet, 400 for an empty or unknown or out-of-range body, 401 without a session, 404', async (k) => {
    const s = await seller(k); const other = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(60) }, { state: 'catalogued' }] });
    const open = await patch(s.cookie, show.lots[0], { reserve: '1' });
    expect(open.status).toBe(409);
    expect(await code(open)).toBe('wrong_state');
    const stranger = await patch(other.cookie, show.lots[1], { reserve: '1' });
    expect(stranger.status).toBe(403);
    expect(await code(stranger)).toBe('not_seller');
    for (const b of [{}, { nope: 1 }, { reserve: 'abc' }, { reserve: String(10n ** 13n) }, { increment: '0' }]) expect((await patch(s.cookie, show.lots[1], b)).status, JSON.stringify(b)).toBe(400);
    expect((await patch(undefined, show.lots[1], { reserve: '1' })).status).toBe(401);
    expect((await patch(s.cookie, '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', { reserve: '1' })).status).toBe(404);
    expect((await patch(s.cookie, 'nope', { reserve: '1' })).status).toBe(404);
  });

  t('control: withdraw and extend work while the lot has no bid and answer lot plus snapshot', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(30) }, { state: 'catalogued' }] });
    const before = new Date((await k.env.lot(show.lots[0])).closes_at).getTime();
    const ext = await control(s.cookie, show.lots[0], { action: 'extend', seconds: 20 });
    expect(ext.status).toBe(200);
    const eb = LotControlResponse.parse(await ext.json());
    expect(LiveSnapshot.parse(eb.live).show.id).toBe(show.id);
    expect(new Date((await k.env.lot(show.lots[0])).closes_at).getTime() - before).toBe(20_000);
    const wd = LotControlResponse.parse(await (await control(s.cookie, show.lots[1], { action: 'withdraw' })).json());
    expect(wd.lot.id).toBe(show.lots[1]);
    expect((await k.env.lot(show.lots[1])).state).toBe('withdrawn');
  });

  t('control: once a bid exists the lot is untouchable (wrong_state); not_seller; validation; 401', async (k) => {
    const s = await seller(k); const other = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(60) }, { state: 'catalogued' }] });
    const bob = await bidder(k.env, show.id);
    expect((await h.bids(req('/api/bids', { body: bidBody({ showId: show.id, lotId: show.lots[0], amount: 50n * USDC, who: bob }) }))).status).toBe(200);
    for (const action of [{ action: 'withdraw' }, { action: 'extend', seconds: 10 }]) {
      const res = await control(s.cookie, show.lots[0], action);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('wrong_state');
    }
    expect((await k.env.lot(show.lots[0])).state).toBe('open');
    const stranger = await control(other.cookie, show.lots[1], { action: 'withdraw' });
    expect(stranger.status).toBe(403);
    expect(await code(stranger)).toBe('not_seller');
    for (const b of [{ action: 'hammer' }, { action: 'extend', seconds: 0 }, { action: 'extend', seconds: 3601 }, {}, { action: 'withdraw', extra: 1 }]) expect((await control(s.cookie, show.lots[1], b)).status, JSON.stringify(b)).toBe(400);
    expect((await control(undefined, show.lots[1], { action: 'withdraw' })).status).toBe(401);
    expect((await control(s.cookie, show.lots[1], { action: 'extend' })).status).toBe(409); // a catalogued lot has no clock to extend
  });
});

describe('GET /api/auctions/:id/live', () => {
  t('carries the 1 s CDN header and nothing that could make it per-viewer or stale', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(60) }] });
    const res = await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id));
    expect(res.status).toBe(200);
    expect(ROUTES.auctionLive.cache).toEqual({ cdnS: 1 });
    expect(res.headers.get('vercel-cdn-cache-control')).toBe('max-age=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    for (const name of ['cache-control', 'vercel-cdn-cache-control', 'cdn-cache-control', 'surrogate-control']) expect(res.headers.get(name) ?? '').not.toMatch(/stale-while-revalidate|s-maxage/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
    expect(LiveSnapshot.parse(await res.json()).show.id).toBe(show.id);
  });

  t('is identical for every viewer: with and without a session, a different address, the body differs only by the clock', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(60) }] });
    const bob = await bidder(k.env, show.id);
    await h.bids(req('/api/bids', { body: bidBody({ showId: show.id, lotId: show.lots[0], amount: 50n * USDC, who: bob }) }));
    const a = await bodyOf(await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id)));
    const b = await bodyOf(await h.live(req(`/api/auctions/${show.id}/live`, { cookie: s.cookie, headers: { 'user-agent': 'curl/8.4.0', accept: 'text/html' } }), idCtx(show.id)));
    expect({ ...a, serverNow: 0 }).toEqual({ ...b, serverNow: 0 });
    expect(JSON.stringify(a)).not.toContain(bob.actor.wallet); // paddle numbers, never wallets
    expect(a.lots[0]).toMatchObject({ highBid: String(50n * USDC), highBidder: { paddle: bob.number } });
  });

  t('closes a due lot on the read (lazy engine) and answers 404 for an unknown or malformed show', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(Date.now() - 60_000), closesAt: inFuture(-5) }, { state: 'catalogued' }] });
    const snap = LiveSnapshot.parse(await (await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id))).json());
    expect(snap.lots.map((l) => l.state)).toEqual(['passed', 'catalogued']); // the next lot opens after the gap
    expect((await k.env.lot(show.lots[0])).state).toBe('passed');
    for (const id of ['8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', 'nope']) {
      const miss = await h.live(req(`/api/auctions/${id}/live`), idCtx(id));
      expect(miss.status).toBe(404);
      expect(await code(miss)).toBe('not_found');
      expect(miss.headers.get('vercel-cdn-cache-control')).toBeNull(); // an error is never cached
    }
  });

  t('touches the database three times when nothing is due: one cheap "is anything due" read and the two snapshot queries', async (k) => {
    const s = await seller(k);
    const show = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(600) }, { state: 'catalogued' }] });
    await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id)); // warm: module loads, first connections
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    try {
      const res = await h.live(req(`/api/auctions/${show.id}/live`), idCtx(show.id));
      expect(res.status).toBe(200);
      expect(spy.mock.calls.length).toBe(3);
    } finally { spy.mockRestore(); }
  });
});

describe('every LIVE route in the contract has a handler', () => {
  const MINE = Object.entries(ROUTES).filter(([k, r]) => r.agent === 'LIVE' || k === 'meActivity' || k === 'mePaddles') as Array<[RouteKey, (typeof ROUTES)[RouteKey]]>;
  it('lists the routes the task names', () => {
    expect(MINE.map(([k]) => k).sort()).toEqual(['auctionLive', 'bidsPlace', 'cronSweep', 'health', 'lotBids', 'lotBuyNow', 'lotControl', 'lotPatch', 'meActivity', 'mePaddles', 'meShows', 'showCancel', 'showEnd', 'showGoLive', 'showPause', 'showResume', 'showsCreate', 'showsGet', 'showsList', 'statusSettlements'].sort());
  });
  for (const [key, r] of MINE) {
    it(`${r.method} ${r.path} -> route.ts exports ${r.method}`, async () => {
      const file = path.join(process.cwd(), 'src', 'app', r.path.replace(/:id/g, '[id]'), 'route.ts');
      expect(fs.existsSync(file), file).toBe(true);
      const mod = await import(/* @vite-ignore */ file);
      expect(typeof mod[r.method], `${key} ${r.method}`).toBe('function');
    });
  }
  it('the legacy surface is gone', () => {
    for (const gone of ['src/app/api/live', 'src/app/api/lots/[id]/open', 'src/app/api/lots/[id]/hammer', 'src/app/api/shows/[id]/lots', 'src/app/api/catalogue']) {
      expect(fs.existsSync(path.join(process.cwd(), gone)), gone).toBe(false);
    }
  });
});
