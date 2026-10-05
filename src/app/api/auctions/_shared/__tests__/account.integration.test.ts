/**
 * Buy Now, the public audit data of a lot, the signed-in wallet's own pages, the public status counters, the cron sweep and the health
 * check, through the real handlers on a real Postgres 18 with real signatures. Only the chain is a fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import {
  ActivityResponse, BuyNowResponse, ErrorResponseSchema, HealthResponse, LotBidsResponse, PaddlesResponse, ROUTES, ShowListResponse, StatusSettlementsResponse, SweepResponse,
} from '@/contracts';
import { verifySigned } from '@/lib/auth/ed25519';
import { bidLogHash } from '@/lib/auction/bidlog';
import { actor, bidBody, bidder, idCtx, nonce, req, resetLimits, signIn, startKit, USDC, type Bidder, type Kit } from './kit';

let kit: Kit | undefined; let skipReason: string | undefined;
type Handler = (r: Request, c?: { params: Promise<{ id: string }> }) => Promise<Response>;
let h: Record<string, Handler>;
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  h = {
    bids: (await import('@/app/api/bids/route')).POST as Handler,
    buyNow: (await import('@/app/api/lots/[id]/buy-now/route')).POST as Handler,
    lotBids: (await import('@/app/api/lots/[id]/bids/route')).GET as Handler,
    activity: (await import('@/app/api/me/activity/route')).GET as Handler,
    paddles: (await import('@/app/api/me/paddles/route')).GET as Handler,
    meShows: (await import('@/app/api/me/shows/route')).GET as Handler,
    status: (await import('@/app/api/status/settlements/route')).GET as Handler,
    sweep: (await import('@/app/api/cron/sweep/route')).GET as Handler,
    health: (await import('@/app/api/health/route')).GET as Handler,
  };
}, 180_000);
afterAll(async () => { await kit?.stop(); });

const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);
const code = async (res: Response) => ErrorResponseSchema.parse(await res.json()).code;
const inFuture = (s: number) => new Date(Date.now() + s * 1000);
const expectCdn = (res: Response, cdnS: number) => { expect(res.headers.get('vercel-cdn-cache-control')).toBe(`max-age=${cdnS}`); expect(res.headers.get('cache-control')).toBe('no-store'); };

async function seller(k: Kit) {
  const a = actor();
  const cookie = await signIn(a);
  return { a, cookie, id: (await k.env.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet])).rows[0].id as string };
}
/** A live show; its first lot is open and, when `buyNow` is given, carries that Buy Now price. */
async function arena(k: Kit, o: { buyNow?: bigint; lots?: number; closesIn?: number; state?: 'open' | 'catalogued' } = {}) {
  const s = await seller(k);
  // a show has one lot on the block at a time: the first is open, the rest wait in the catalogue
  const lots = Array.from({ length: o.lots ?? 1 }, (_, n) => (n === 0 ? { state: o.state ?? ('open' as const), openedAt: new Date(), closesAt: inFuture(o.closesIn ?? 3600) } : { state: 'catalogued' as const }));
  const show = await k.env.show({ sellerId: s.id, status: 'live', lots });
  if (o.buyNow) await k.env.pool.query(`update lots set buy_now_price = $2 where show_id = $1`, [show.id, o.buyNow.toString()]);
  const sellerPaddle = await bidder(k.env, show.id, { wallet: s.a });
  return { s, showId: show.id, lots: show.lots, lotId: show.lots[0], sellerPaddle };
}
const buyBody = (a: { showId: string; lotId: string }, who: Bidder, amount: bigint | string, over: Partial<Parameters<typeof bidBody>[0]> = {}) => {
  const { lotId, ...rest } = bidBody({ showId: a.showId, lotId: a.lotId, amount, who, ...over });
  void lotId;
  return rest;
};
const buy = (a: { lotId: string }, body: unknown, init: { cookie?: string; headers?: Record<string, string> } = {}) => h.buyNow(req(`/api/lots/${a.lotId}/buy-now`, { body, ...init }), idCtx(a.lotId));
const placeBid = (a: { showId: string; lotId: string }, who: Bidder, amount: bigint, signer: 'wallet' | 'session' = 'wallet') => h.bids(req('/api/bids', { body: bidBody({ showId: a.showId, lotId: a.lotId, amount, who, signer }) }));

describe('POST /api/lots/:id/buy-now', () => {
  t('a wallet-signed intent for exactly the Buy Now price wins the lot and creates its settlement', async (k) => {
    const a = await arena(k, { buyNow: 300n * USDC });
    const bob = await bidder(k.env, a.showId);
    const res = await buy(a, buyBody(a, bob, 300n * USDC));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(ROUTES.lotBuyNow.cache).toBe('none');
    const { settlementId } = BuyNowResponse.parse(await res.json());
    const { rows: [st] } = await k.env.pool.query(`select status, buyer_id, gross_amount::text g, rail from settlements where id = $1`, [settlementId]);
    expect(st).toEqual({ status: 'awaiting_payment', buyer_id: bob.profileId, g: String(300n * USDC), rail: 'cosign' });
    expect((await k.env.lot(a.lotId)).state).toBe('sold');
    expect((await k.env.pool.query(`select via from bids where lot_id = $1`, [a.lotId])).rows[0].via).toBe('wallet');
  });

  t('not_buyable (no price, or the bidding already reached it), amount must equal the price (400)', async (k) => {
    const a = await arena(k);
    const bob = await bidder(k.env, a.showId);
    const none = await buy(a, buyBody(a, bob, 300n * USDC));
    expect(none.status).toBe(409);
    expect(await code(none)).toBe('not_buyable');
    const b = await arena(k, { buyNow: 300n * USDC });
    const amy = await bidder(k.env, b.showId); const cat = await bidder(k.env, b.showId);
    expect((await buy(b, buyBody(b, amy, 299n * USDC))).status).toBe(400);
    await k.env.pool.query(`update lots set high_bid = $2, high_bidder_id = $3, bid_count = 1 where id = $1`, [b.lotId, (300n * USDC).toString(), amy.profileId]);
    const reached = await buy(b, buyBody(b, cat, 300n * USDC));
    expect(reached.status).toBe(409);
    expect(await code(reached)).toBe('not_buyable');
  });

  t('lot_not_open, lot_closed, insufficient_funds, self_bid, no_paddle, balance_unavailable', async (k) => {
    const queued = await arena(k, { buyNow: 300n * USDC, state: 'catalogued' });
    expect(await code(await buy(queued, buyBody(queued, await bidder(k.env, queued.showId), 300n * USDC)))).toBe('lot_not_open');
    const late = await arena(k, { buyNow: 300n * USDC, closesIn: -5 });
    expect(await code(await buy(late, buyBody(late, await bidder(k.env, late.showId), 300n * USDC)))).toBe('lot_closed');

    const a = await arena(k, { buyNow: 300n * USDC });
    const poor = await bidder(k.env, a.showId);
    k.fake.balances.set(poor.actor.wallet, 299n * USDC);
    const res = await buy(a, buyBody(a, poor, 300n * USDC));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('insufficient_funds');
    expect(await code(await buy(a, buyBody(a, a.sellerPaddle, 300n * USDC)))).toBe('self_bid');
    const stranger = { ...(await bidder(k.env, a.showId)), paddleId: 'a4f1c8e3-5b27-4d09-96ae-8c3d7e1b2f18' };
    await k.env.pool.query(`delete from paddles where profile_id = $1`, [stranger.profileId]);
    expect(await code(await buy(a, buyBody(a, stranger, 300n * USDC)))).toBe('no_paddle');
    k.fake.chainDown = true;
    const down = await buy(a, buyBody(a, await bidder(k.env, a.showId), 300n * USDC));
    k.fake.chainDown = false;
    expect(down.status).toBe(503);
    expect(await code(down)).toBe('balance_unavailable');
    expect((await k.env.lot(a.lotId)).state).toBe('open');
  });

  t('bad_signature: a paddle key may not buy, a tampered amount or lot is refused; replay: one nonce cannot buy two lots', async (k) => {
    const a = await arena(k, { buyNow: 300n * USDC });
    const b = await arena(k, { buyNow: 300n * USDC });
    const bob = await bidder(k.env, a.showId);
    const bobInB = await bidder(k.env, b.showId, { wallet: bob.actor });
    const bySession = await buy(a, buyBody(a, bob, 300n * USDC, { signer: 'session' }));
    expect(bySession.status).toBe(401);
    expect(await code(bySession)).toBe('bad_signature');
    expect(await code(await buy(a, buyBody(a, bob, 300n * USDC, { text: { amount: String(1n) } })))).toBe('bad_signature');
    expect(await code(await buy(a, buyBody(a, bob, 300n * USDC, { text: { lot: b.lotId } })))).toBe('bad_signature');
    expect(await code(await buy(a, buyBody(a, bob, 300n * USDC, { signWith: actor() })))).toBe('bad_signature');

    const first = buyBody(a, bob, 300n * USDC);
    expect((await buy(a, first)).status).toBe(200);
    await resetLimits(k.env);
    const used = /nonce: ([0-9a-f]{16})/.exec(first.intent.message)![1];
    const replay = await buy(b, buyBody(b, bobInB, 300n * USDC, { text: { nonce: used } }));
    expect(replay.status).toBe(409);
    expect(await code(replay)).toBe('replay');
  });

  t('401-style guards: another origin 403, bad JSON 400, unknown lot 404', async (k) => {
    const a = await arena(k, { buyNow: 300n * USDC });
    const bob = await bidder(k.env, a.showId);
    expect((await buy(a, buyBody(a, bob, 300n * USDC), { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await h.buyNow(req(`/api/lots/${a.lotId}/buy-now`, { body: '{nope' }), idCtx(a.lotId))).status).toBe(400);
    const ghost = '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11';
    expect((await h.buyNow(req(`/api/lots/${ghost}/buy-now`, { body: buyBody({ showId: a.showId, lotId: ghost }, bob, 300n * USDC, { text: { lot: ghost } }) }), idCtx(ghost))).status).toBe(404);
  });
});

describe('GET /api/lots/:id/bids', () => {
  t('lists every accepted bid in log order with the key that signed it, and every signature verifies in the browser the same way', async (k) => {
    const a = await arena(k);
    const bob = await bidder(k.env, a.showId); const amy = await bidder(k.env, a.showId);
    expect((await placeBid(a, bob, 50n * USDC, 'wallet')).status).toBe(200);
    expect((await placeBid(a, amy, 55n * USDC, 'session')).status).toBe(200);
    const res = await h.lotBids(req(`/api/lots/${a.lotId}/bids`), idCtx(a.lotId));
    expect(res.status).toBe(200);
    expectCdn(res, 5);
    expect(ROUTES.lotBids.cache).toEqual({ cdnS: 5 });
    const body = LotBidsResponse.parse(await res.json());
    expect(body.lot).toMatchObject({ id: a.lotId, number: 1, showId: a.showId });
    expect(body.bids.map((b) => b.amount)).toEqual([String(50n * USDC), String(55n * USDC)]);
    expect(body.bids.map((b) => [b.signer, b.signerPubkey, b.paddle])).toEqual([['wallet', bob.actor.wallet, bob.number], ['session', amy.session.wallet, amy.number]]);
    for (const b of body.bids) expect(verifySigned(b.message, b.signature, b.signerPubkey)).toBe(true);
    expect(body.settlement).toBeNull(); // nothing sold yet
  });

  t('carries the settlement anchor once the lot is sold, and the bid-log hash recomputes from what the page shows', async (k) => {
    const a = await arena(k, { buyNow: 300n * USDC });
    const bob = await bidder(k.env, a.showId); const amy = await bidder(k.env, a.showId);
    expect((await placeBid(a, amy, 50n * USDC)).status).toBe(200);
    await resetLimits(k.env);
    expect((await buy(a, buyBody(a, bob, 300n * USDC))).status).toBe(200);
    const body = LotBidsResponse.parse(await (await h.lotBids(req(`/api/lots/${a.lotId}/bids`), idCtx(a.lotId))).json());
    expect(body.bids).toHaveLength(2);
    expect(body.settlement).toMatchObject({ txSignature: null, cluster: 'devnet' });
    expect(body.settlement!.bidLogHash).toBe(bidLogHash(body.bids.map((b) => ({ id: b.id, message: b.message, signature: b.signature, placedAt: b.placedAt }))));
    const { rows: [st] } = await k.env.pool.query(`select bid_log_hash from settlements where lot_id = $1`, [a.lotId]);
    expect(body.settlement!.bidLogHash).toBe(st.bid_log_hash);
  });

  t('a house bidder is a wallet signature by the bidder wallet; 404 for an unknown or malformed lot; never cached on an error', async (k) => {
    const a = await arena(k);
    const house = await bidder(k.env, a.showId);
    await k.env.pool.query(`update profiles set is_bot = true where id = $1`, [house.profileId]);
    await k.env.pool.query(`update shows set is_house = true where id = $1`, [a.showId]);
    const intent = bidBody({ showId: a.showId, lotId: a.lotId, amount: 50n * USDC, who: house }).intent;
    expect((await k.env.svc.placeBid({ lotId: a.lotId, amount: 50n * USDC, bidderProfileId: house.profileId, bidderWallet: house.actor.wallet, paddleId: house.paddleId, via: 'house', message: intent.message, signature: intent.signature, nonce: nonce(), fundsBalance: 10n ** 15n })).ok).toBe(true);
    const body = LotBidsResponse.parse(await (await h.lotBids(req(`/api/lots/${a.lotId}/bids`), idCtx(a.lotId))).json());
    expect(body.bids[0]).toMatchObject({ signer: 'wallet', signerPubkey: house.actor.wallet });
    for (const id of ['8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11', 'nope']) {
      const miss = await h.lotBids(req(`/api/lots/${id}/bids`), idCtx(id));
      expect(miss.status).toBe(404);
      expect(await code(miss.clone())).toBe('not_found');
      expect(miss.headers.get('vercel-cdn-cache-control')).toBeNull();
    }
  });
});

describe('the signed-in wallet\'s pages', () => {
  const get = (handler: Handler, p: string, cookie?: string) => handler(req(p, { cookie }));

  t('GET /api/me/activity: bids, wins and consignments, newest first, paged by cursor', async (k) => {
    const a = await arena(k);
    const b = await arena(k, { buyNow: 300n * USDC });
    const bob = await bidder(k.env, a.showId);
    const bobInB = await bidder(k.env, b.showId, { wallet: bob.actor });
    const cookie = await signIn(bob.actor);
    expect((await placeBid(a, bob, 50n * USDC)).status).toBe(200);
    await resetLimits(k.env);
    expect((await buy(b, buyBody(b, bobInB, 300n * USDC))).status).toBe(200);

    const bidsTab = ActivityResponse.parse(await (await get(h.activity, '/api/me/activity?tab=bids', cookie)).json());
    expect(bidsTab.tab).toBe('bids');
    expect(bidsTab.items.map((i) => ('amount' in i ? i.amount : ''))).toEqual([String(300n * USDC), String(50n * USDC)]);
    expect((bidsTab.items as Array<{ leading: boolean }>).map((i) => i.leading)).toEqual([false, true]); // the sold lot is no longer open, the first lot is
    const wins = ActivityResponse.parse(await (await get(h.activity, '/api/me/activity?tab=wins', cookie)).json());
    expect(wins.items).toHaveLength(1);
    expect(wins.items[0]).toMatchObject({ gross: String(300n * USDC), status: 'awaiting_payment', explorerUrl: null });
    const sellerCookie = await signIn(a.s.a);
    const cons = ActivityResponse.parse(await (await get(h.activity, '/api/me/activity?tab=consignments', sellerCookie)).json());
    expect(cons.items).toHaveLength(1);
    expect(cons.items[0]).toMatchObject({ lotId: a.lotId, consign: 'ready', state: 'open' });

    // 25 more bids: a page of 20 and a cursor for the rest
    for (let n = 0; n < 25; n++) await k.env.pool.query(`insert into bids (lot_id, bidder_id, amount, signature, message, nonce) values ($1, $2, 1, 's', 'm', $3)`, [a.lotId, bob.profileId, `bulk-${n}`]);
    const p1 = ActivityResponse.parse(await (await get(h.activity, '/api/me/activity?tab=bids', cookie)).json());
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).toBe('o20');
    const p2 = ActivityResponse.parse(await (await get(h.activity, `/api/me/activity?tab=bids&cursor=${p1.nextCursor}`, cookie)).json());
    expect(p2.items).toHaveLength(7);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => ('bidId' in i ? i.bidId : ''))).size).toBe(27);
  });

  t('GET /api/me/activity: 400 for a bad tab, a missing tab or an unknown parameter; 401 without a session; a garbage cursor means the first page', async (k) => {
    const cookie = await signIn(actor());
    for (const q of ['', '?tab=nope', '?tab=bids&x=1']) expect((await get(h.activity, `/api/me/activity${q}`, cookie)).status, q).toBe(400);
    expect((await get(h.activity, '/api/me/activity?tab=bids')).status).toBe(401);
    expect((await get(h.activity, '/api/me/activity?tab=bids&cursor=zzz', cookie)).status).toBe(200);
    void k;
  });

  t('GET /api/me/paddles: only working paddles, funded from the live balance, never failing because of the RPC', async (k) => {
    const a = await arena(k);
    const b = await arena(k);
    const bob = await bidder(k.env, a.showId);
    const old = await bidder(k.env, b.showId, { wallet: bob.actor });
    await k.env.pool.query(`update paddles set valid_until = now() - interval '1 minute' where id = $1`, [old.paddleId]);
    const cookie = await signIn(bob.actor);
    const ok = await get(h.paddles, '/api/me/paddles', cookie);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(PaddlesResponse.parse(await ok.json()).paddles).toEqual([expect.objectContaining({ showId: a.showId, number: bob.number, funded: true })]);
    k.fake.balances.set(bob.actor.wallet, 500_000n);
    expect(PaddlesResponse.parse(await (await get(h.paddles, '/api/me/paddles', cookie)).json()).paddles[0].funded).toBe(false);
    k.fake.chainDown = true;
    const down = await get(h.paddles, '/api/me/paddles', cookie);
    k.fake.chainDown = false;
    expect(down.status).toBe(200);
    expect(PaddlesResponse.parse(await down.json()).paddles[0].funded).toBe(false);
    await k.env.pool.query(`update paddles set revoked_at = now() where id = $1`, [bob.paddleId]);
    expect(PaddlesResponse.parse(await (await get(h.paddles, '/api/me/paddles', cookie)).json()).paddles).toEqual([]);
    expect((await get(h.paddles, '/api/me/paddles')).status).toBe(401);
  });

  t('GET /api/me/shows: only the shows this wallet runs, filterable, paged', async (k) => {
    const s = await seller(k); const other = await seller(k);
    const live = await k.env.show({ sellerId: s.id, status: 'live', lots: [{ state: 'catalogued' }] });
    const sched = await k.env.show({ sellerId: s.id, status: 'scheduled', lots: [{ state: 'catalogued' }, { state: 'catalogued' }] });
    await k.env.show({ sellerId: other.id, status: 'live', lots: [{ state: 'catalogued' }] });
    const res = await get(h.meShows, '/api/me/shows', s.cookie);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const all = ShowListResponse.parse(await res.json());
    expect(all.shows.map((x) => x.id).sort()).toEqual([live.id, sched.id].sort());
    expect(ShowListResponse.parse(await (await get(h.meShows, '/api/me/shows?status=scheduled', s.cookie)).json()).shows.map((x) => [x.id, x.lotCount])).toEqual([[sched.id, 2]]);
    const p1 = ShowListResponse.parse(await (await get(h.meShows, '/api/me/shows?limit=1', s.cookie)).json());
    expect(p1.nextCursor).toBe('o1');
    expect(ShowListResponse.parse(await (await get(h.meShows, `/api/me/shows?limit=1&cursor=${p1.nextCursor}`, s.cookie)).json()).nextCursor).toBeNull();
    expect((await get(h.meShows, '/api/me/shows?limit=0', s.cookie)).status).toBe(400);
    expect((await get(h.meShows, '/api/me/shows')).status).toBe(401);
  });
});

describe('GET /api/status/settlements', () => {
  /** A settlement row with the given status for a fresh lot. */
  async function settlement(k: Kit, status: string, tx: string | null, settledAt: string | null, gross = 120n * USDC) {
    const a = await arena(k);
    const bob = await bidder(k.env, a.showId);
    const sig = tx ?? null;
    await k.env.pool.query(
      `insert into settlements (lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status, tx_signature, settled_at, cluster) values ($1,$2,$3,$4,3000000,117000000,$5,$6,$7,'devnet')`,
      [a.lotId, bob.profileId, a.s.id, gross.toString(), status, sig, settledAt],
    );
    return a;
  }
  const sig = () => Keypair.generate().publicKey.toBase58() + Keypair.generate().publicKey.toBase58().slice(0, 40); // 64 to 90 base58 characters

  t('lists only verified sales (status settled, with a transaction), newest first, with explorer links; nothing invented', async (k) => {
    const first = sig(); const second = sig();
    await settlement(k, 'settled', first, new Date(Date.now() - 60_000).toISOString(), 100n * USDC);
    await settlement(k, 'settled', second, new Date().toISOString(), 200n * USDC);
    await settlement(k, 'awaiting_payment', null, null);
    await settlement(k, 'expired', null, null);
    await settlement(k, 'submitted', sig(), null);
    const res = await h.status(req('/api/status/settlements?limit=50'));
    expect(res.status).toBe(200);
    expectCdn(res, 15);
    expect(ROUTES.statusSettlements.cache).toEqual({ cdnS: 15 });
    const body = StatusSettlementsResponse.parse(await res.json());
    expect(body.items.map((i) => i.txSignature)).toEqual([second, first]);
    expect(body.items[0]).toMatchObject({ amount: String(200n * USDC), explorerUrl: `https://explorer.solana.com/tx/${second}?cluster=devnet` });
    expect(StatusSettlementsResponse.parse(await (await h.status(req('/api/status/settlements?limit=1'))).json()).items).toHaveLength(1);
    for (const q of ['limit=0', 'limit=51', 'limit=x', 'foo=1']) expect((await h.status(req(`/api/status/settlements?${q}`))).status, q).toBe(400);
  });

  t('is empty, not invented, when nothing has settled', async (k) => {
    await k.env.pool.query(`delete from settlements`);
    expect(StatusSettlementsResponse.parse(await (await h.status(req('/api/status/settlements'))).json())).toEqual({ items: [] });
  });
});

describe('GET /api/cron/sweep', () => {
  const SECRET = 'cron-secret-cron-secret-0123456789';
  const call = (authorization?: string) => h.sweep(req('/api/cron/sweep', { headers: authorization === undefined ? {} : { authorization } }));

  t('refuses everything but the exact Bearer secret (401), including when no secret is configured', async () => {
    vi.stubEnv('CRON_SECRET', SECRET);
    for (const bad of [undefined, '', SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `bearer ${SECRET}`, `Bearer  ${SECRET}`, 'Bearer ', `Basic ${SECRET}`, `Bearer ${'x'.repeat(5000)}`]) {
      const res = await call(bad);
      expect(res.status, String(bad)).toBe(401);
      expect(await code(res)).toBe('unauthenticated');
    }
    vi.stubEnv('CRON_SECRET', '');
    for (const bad of ['Bearer ', 'Bearer undefined', 'Bearer', '']) expect((await call(bad)).status, bad).toBe(401);
    vi.unstubAllEnvs();
  });

  t('with the secret: advances due shows, expires settlements, answers the contract shape, and a second run changes nothing', async (k) => {
    vi.stubEnv('CRON_SECRET', SECRET);
    // One database serves the whole file, and the tests before this one leave shows with a timer still running (a lot sold a moment ago waits gapS = 6 s for the next to open).
    // Under load the first run takes long enough for such a timer to fire between the two runs, which is time passing, not the sweep being unstable. Retire them: only the show below may move.
    await k.env.pool.query(`update lots set state = 'passed' where state in ('open', 'catalogued')`);
    await k.env.pool.query(`update shows set status = 'ended' where status in ('live', 'scheduled')`);
    const s = await seller(k);
    const due = await k.env.show({ sellerId: s.id, status: 'scheduled', scheduledAt: new Date(Date.now() - 5000), lots: [{ state: 'catalogued' }] });
    k.fake.expired = 2;
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(ROUTES.cronSweep.cache).toBe('none');
    const body = SweepResponse.parse(await res.json());
    expect(body.advanced).toBeGreaterThanOrEqual(1);
    expect(body.expired).toBe(2);
    expect((await k.env.pool.query(`select status from shows where id = $1`, [due.id])).rows[0].status).toBe('live');
    expect((await k.env.lot(due.lots[0])).state).toBe('open');
    k.fake.expired = 0;
    expect(SweepResponse.parse(await (await call(`Bearer ${SECRET}`)).json())).toEqual({ advanced: 0, expired: 0, finalized: 0 });
    vi.unstubAllEnvs();
  });

  t('reports the settlement sweep numbers, and zeros when payments are paused or the chain config is broken', async (k) => {
    vi.stubEnv('CRON_SECRET', SECRET);
    const { setLiveServices } = await import('../deps');
    const { ApiError } = await import('@/contracts');
    k.fake.expired = 1;
    k.fake.finalized = 3;
    expect(SweepResponse.parse(await (await call(`Bearer ${SECRET}`)).json())).toMatchObject({ expired: 1, finalized: 3 });
    setLiveServices({ settlement: { sweep: async () => { throw new ApiError('paused', 'Payments are paused'); } } });
    let res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(SweepResponse.parse(await res.json())).toMatchObject({ expired: 0, finalized: 0 });
    setLiveServices({ settlement: { sweep: async () => { throw new Error('PLATFORM_WALLET_ADDRESS is not set'); } } });
    res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(SweepResponse.parse(await res.json())).toMatchObject({ expired: 0, finalized: 0 });
    setLiveServices({ settlement: { sweep: async () => ({ expired: k.fake.expired, finalized: k.fake.finalized }) } });
    vi.unstubAllEnvs();
  });

  t('is a GET only', async () => {
    const mod = await import('@/app/api/cron/sweep/route');
    expect(Object.keys(mod).filter((x) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(x))).toEqual(['GET']);
  });
});

describe('GET /api/health', () => {
  const sa = Keypair.generate();
  const rpc = (ok: boolean) => vi.fn(async (_url: unknown, init?: { body?: string }) => {
    if (!ok) throw new Error('network down');
    const { method } = JSON.parse(String(init?.body));
    const result = method === 'getBalance' ? { context: { slot: 1 }, value: 3_200_000_000 } : 123_456;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
  });

  t('answers the contract shape with the settlement authority\'s balance, the cluster and the switch states, and no secret', async (k) => {
    (await import('../../../health/probe')).clearHealthMemo();
    vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify([...sa.secretKey]));
    vi.stubEnv('SOLANA_RPC_URL', 'http://localhost:8899');
    vi.stubGlobal('fetch', rpc(true));
    await k.env.pool.query(`insert into app_flags (key, value) values ('faucet', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`);
    const { clearFlagMemo } = await import('../flags');
    clearFlagMemo();
    const res = await h.health(req('/api/health', { headers: { 'user-agent': 'curl/8.4.0' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-health-status')).toBe('ok');
    const text = await res.text();
    const body = HealthResponse.parse(JSON.parse(text));
    expect(body).toMatchObject({ ok: true, cluster: 'devnet', sa: { sol: 3.2 }, flags: { bidding: true, settlement: true, faucet: false, mint: true, house_bots: true } });
    expect(body.db.ms).toBeGreaterThanOrEqual(0);
    for (const secret of [JSON.stringify([...sa.secretKey]).slice(1, 40), Buffer.from(sa.secretKey).toString('base64').slice(0, 20), process.env.DATABASE_URL!.slice(10), 'postgresql://']) expect(text).not.toContain(secret);
    expect(text).not.toContain(sa.publicKey.toBase58()); // the balance is public, the address is not needed
    await k.env.pool.query(`delete from app_flags where key = 'faucet'`);
    clearFlagMemo();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  t('is degraded, still 200, when the RPC is down: sa.sol is null and the header says so', async (k) => {
    (await import('../../../health/probe')).clearHealthMemo();
    vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify([...sa.secretKey]));
    vi.stubEnv('SOLANA_RPC_URL', 'http://localhost:8899');
    vi.stubGlobal('fetch', rpc(false));
    const res = await h.health(req('/api/health'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-health-status')).toBe('degraded');
    expect(HealthResponse.parse(await res.json()).sa.sol).toBeNull();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    void k;
  });

  t('SEC: the chain probe is memoised (a flood of public hits costs two RPC calls, not two per hit) and the balance is coarse', async (k) => {
    (await import('../../../health/probe')).clearHealthMemo();
    vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify([...sa.secretKey]));
    vi.stubEnv('SOLANA_RPC_URL', 'http://localhost:8899');
    const f = vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const { method } = JSON.parse(String(init?.body));
      const result = method === 'getBalance' ? { context: { slot: 1 }, value: 4_927_750_840 } : 123_456;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', f);
    const bodies = await Promise.all(Array.from({ length: 25 }, async (_, i) => HealthResponse.parse(await (await h.health(req(`/api/health?cachebust=${i}`))).json())));
    expect(f).toHaveBeenCalledTimes(2); // block height + balance, once, for 25 requests (the first 25 may race the memo: at most one probe per instance)
    for (const b of bodies) expect(b.sa.sol).toBe(4.9); // 4.92775084 SOL is floored to 0.1 SOL
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    void k;
  });

  t('is 503 only when the database is down', async () => {
    const { db } = await import('@/db');
    const spy = vi.spyOn(db, 'execute').mockRejectedValueOnce(new Error('connection refused'));
    const res = await h.health(req('/api/health'));
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(await res.json())).toMatchObject({ ok: false });
    expect((await h.health(req('/api/health'))).status).toBe(200);
  });
});
