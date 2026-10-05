/**
 * POST /api/bids through the real handler, a real Postgres 18 and real signatures. The order of the checks is the contract:
 *   size/JSON guard -> parse + verify the intent -> the paddle's limits -> rate limits -> USDC balance read -> the engine's transaction.
 * Each rejection below is one of the contract's error codes, and the ones that must happen BEFORE a cost (rate budget, RPC call) are
 * asserted by counting the chain reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BidResponse, ErrorResponseSchema, LiveSnapshot, ROUTES } from '@/contracts';
import { bidBody, bidder, bodyOf, freshIp, req, resetLimits, startKit, USDC, type Bidder, type Kit, actor } from './kit';

let kit: Kit | undefined; let skipReason: string | undefined;
let POST: (r: Request) => Promise<Response>;
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  POST = (await import('@/app/api/bids/route')).POST;
}, 180_000);
afterAll(async () => { await kit?.stop(); });
beforeEach(async () => { if (kit) { await resetLimits(kit.env); kit.fake.chainDown = false; kit.fake.balanceCalls = 0; kit.fake.balances.clear(); } });

const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);
const inFuture = (s: number) => new Date(Date.now() + s * 1000);

/** A live show with one open lot (opening 50, increment 5, reserve 100) and `n` registered bidders; the seller has a paddle too. */
async function arena(k: Kit, o: { bidders?: number; closesIn?: number; show?: Partial<Parameters<Kit['env']['show']>[0]>; lot?: Parameters<Kit['env']['show']>[0]['lots'][number] } = {}) {
  const sellerActor = actor();
  const seller = await k.env.profile({ wallet: sellerActor.wallet });
  const s = await k.env.show({ sellerId: seller.id, lots: [{ state: 'open', openedAt: new Date(), closesAt: inFuture(o.closesIn ?? 3600), ...(o.lot ?? {}) }], ...(o.show ?? {}) });
  const list: Bidder[] = [];
  for (let n = 0; n < (o.bidders ?? 2); n++) list.push(await bidder(k.env, s.id));
  const sellerPaddle = await bidder(k.env, s.id, { wallet: sellerActor });
  return { showId: s.id, lotId: s.lots[0], bidders: list, seller: sellerPaddle };
}

const send = (body: unknown, init: { ip?: string; cookie?: string; headers?: Record<string, string> } = {}) => POST(req('/api/bids', { body, ...init }));
const code = async (res: Response) => { const b = ErrorResponseSchema.parse(await res.json()); return b.code; };

/** Wait for the next fixed-window boundary when fewer than `needMs` of the current window are left. */
const windowStart = async (windowMs: number, needMs: number) => {
  const left = windowMs - (Date.now() % windowMs);
  if (left < needMs) await new Promise((r) => setTimeout(r, left + 20));
};

describe('success', () => {
  t('a wallet-signed bid is recorded, answers the contract shape with a fresh public snapshot, and is cached nowhere', async (k) => {
    const a = await arena(k);
    const [bob] = a.bidders;
    k.fake.balances.set(bob.actor.wallet, 777n * USDC);
    const res = await send(bidBody({ ...a, amount: 50n * USDC, who: bob }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vercel-cdn-cache-control')).toBeNull();
    const body = BidResponse.parse(await res.json());
    expect(body).toMatchObject({ ok: true, amount: String(50n * USDC), belowReserve: true, extended: false });
    expect(LiveSnapshot.parse(body.live).lots[0]).toMatchObject({ highBid: String(50n * USDC), highBidder: { paddle: bob.number }, bidCount: 1 });
    expect(ROUTES.bidsPlace.cache).toBe('none');
    const { rows: [row] } = await k.env.pool.query(`select via, paddle_id, funded_amount::text from bids where id = $1`, [body.bidId]);
    expect(row).toEqual({ via: 'wallet', paddle_id: bob.paddleId, funded_amount: String(777n * USDC) }); // the balance that was read, before the transaction
    expect(JSON.stringify(body)).not.toContain(bob.actor.wallet);
  });

  t('a bid signed by the paddle session key (no popup) is recorded as via session; a cookie, when present, may accompany either', async (k) => {
    const a = await arena(k);
    const [bob, amy] = a.bidders;
    const r1 = await send(bidBody({ ...a, amount: 50n * USDC, who: bob, signer: 'session' }));
    expect(r1.status).toBe(200);
    expect((await k.env.pool.query(`select via from bids where id = $1`, [(await bodyOf(r1)).bidId])).rows[0].via).toBe('session');
    const { signIn } = await import('./kit');
    const cookie = await signIn(amy.actor);
    expect((await send(bidBody({ ...a, amount: 55n * USDC, who: amy }), { cookie })).status).toBe(200);
  });

  t('the 2 s window is per wallet: two wallets bid in the same second, one wallet twice is limited', async (k) => {
    await windowStart(2000, 1000); // the limiter is a fixed window: do not straddle its boundary
    const a = await arena(k, { bidders: 2 });
    const [bob, amy] = a.bidders;
    expect((await send(bidBody({ ...a, amount: 50n * USDC, who: bob }))).status).toBe(200);
    expect((await send(bidBody({ ...a, amount: 55n * USDC, who: amy }))).status).toBe(200);
    const again = await send(bidBody({ ...a, amount: 60n * USDC, who: bob }));
    expect(again.status).toBe(429);
    expect(await code(again.clone())).toBe('rate_limited');
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await bodyOf(again)).retryAfterS).toBeGreaterThanOrEqual(1);
  });

  t('60 requests a minute per address, whichever wallet signs', async (k) => {
    await windowStart(60_000, 40_000);
    const a = await arena(k, { bidders: 1 });
    const [bob] = a.bidders;
    const ip = freshIp();
    for (let n = 0; n < 60; n++) {
      await k.env.pool.query(`delete from rate_limits where key like 'w:%'`); // keep the wallet window out of the way
      const res = await send(bidBody({ ...a, amount: 1n, who: bob }), { ip }); // too low: a cheap rejection that still counts against the address
      expect(res.status, `request ${n}`).toBe(409);
    }
    await k.env.pool.query(`delete from rate_limits where key like 'w:%'`);
    const res = await send(bidBody({ ...a, amount: 1n, who: bob }), { ip });
    expect(res.status).toBe(429);
    expect(await code(res)).toBe('rate_limited');
    await k.env.pool.query(`delete from rate_limits where key like 'w:%'`);
    expect((await send(bidBody({ ...a, amount: 1n, who: bob }), { ip: freshIp() })).status).toBe(409); // another address is unaffected
  });
});

describe('the engine rejections, each mapped to its contract code', () => {
  t('bid_too_low carries minNext; the minimum itself is accepted', async (k) => {
    const a = await arena(k);
    const [bob, amy] = a.bidders;
    const low = await send(bidBody({ ...a, amount: 50n * USDC - 1n, who: bob }));
    expect(low.status).toBe(409);
    expect(ErrorResponseSchema.parse(await low.json())).toMatchObject({ code: 'bid_too_low', minNext: String(50n * USDC) });
    await resetLimits(k.env);
    expect((await send(bidBody({ ...a, amount: 50n * USDC, who: bob }))).status).toBe(200);
    const low2 = await send(bidBody({ ...a, amount: 55n * USDC - 1n, who: amy }));
    expect((await bodyOf(low2)).minNext).toBe(String(55n * USDC));
  });

  t('already_high_bidder, self_bid, amount_too_large', async (k) => {
    const a = await arena(k);
    const [bob] = a.bidders;
    expect((await send(bidBody({ ...a, amount: 50n * USDC, who: bob }))).status).toBe(200);
    await resetLimits(k.env);
    expect(await code(await send(bidBody({ ...a, amount: 55n * USDC, who: bob })))).toBe('already_high_bidder');
    expect(await code(await send(bidBody({ ...a, amount: 60n * USDC, who: a.seller })))).toBe('self_bid');
    const amy = a.bidders[1];
    k.fake.balances.set(amy.actor.wallet, 10n ** 13n);
    const big = await send(bidBody({ ...a, amount: 10n ** 12n + 1n, who: amy }));
    expect(big.status).toBe(400);
    expect(await code(big)).toBe('amount_too_large');
  });

  t('insufficient_funds: the live balance read decides, not the paddle', async (k) => {
    const a = await arena(k);
    const [bob] = a.bidders;
    k.fake.balances.set(bob.actor.wallet, 49n * USDC);
    const res = await send(bidBody({ ...a, amount: 50n * USDC, who: bob }));
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('insufficient_funds');
    expect((await k.env.pool.query(`select count(*)::int c from bids where lot_id = $1`, [a.lotId])).rows[0].c).toBe(0);
  });

  t('balance_unavailable: an RPC outage fails closed (503), never a bid on a guess', async (k) => {
    const a = await arena(k);
    k.fake.chainDown = true;
    const res = await send(bidBody({ ...a, amount: 50n * USDC, who: a.bidders[0] }));
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('balance_unavailable');
    expect((await k.env.pool.query(`select count(*)::int c from bids where lot_id = $1`, [a.lotId])).rows[0].c).toBe(0);
  });

  t('lot_closed (deadline passed, closed lazily), lot_not_open, show_not_live', async (k) => {
    const late = await arena(k, { closesIn: -5 });
    expect(await code(await send(bidBody({ ...late, amount: 50n * USDC, who: late.bidders[0] })))).toBe('lot_closed');
    expect((await k.env.pool.query(`select state from lots where id = $1`, [late.lotId])).rows[0].state).toBe('passed'); // the read that refused the bid closed it
    const queued = await arena(k, { lot: { state: 'catalogued' } });
    expect(await code(await send(bidBody({ ...queued, amount: 50n * USDC, who: queued.bidders[0] })))).toBe('lot_not_open');
    const scheduled = await arena(k, { show: { status: 'scheduled' }, lot: { state: 'catalogued' } });
    expect(await code(await send(bidBody({ ...scheduled, amount: 50n * USDC, who: scheduled.bidders[0] })))).toBe('show_not_live');
  });

  t('no_paddle: a wallet that never registered, and a wallet with no profile at all', async (k) => {
    const a = await arena(k);
    const stranger: Bidder = { actor: actor(), session: actor(), profileId: '', paddleId: 'a4f1c8e3-5b27-4d09-96ae-8c3d7e1b2f18', number: 0 };
    expect(await code(await send(bidBody({ ...a, amount: 50n * USDC, who: stranger })))).toBe('no_paddle'); // signed correctly, unknown wallet
    const p = await k.env.profile({ wallet: stranger.actor.wallet });
    stranger.profileId = p.id;
    expect(await code(await send(bidBody({ ...a, amount: 50n * USDC, who: stranger })))).toBe('no_paddle'); // profile, no paddle in this show
  });

  t('banned: a banned wallet gets 403 even with a valid signature and paddle', async (k) => {
    const a = await arena(k);
    const [bob] = a.bidders;
    await k.env.pool.query(`update profiles set is_banned = true where id = $1`, [bob.profileId]);
    const res = await send(bidBody({ ...a, amount: 50n * USDC, who: bob }));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('banned');
    expect(k.fake.balanceCalls).toBe(0);
  });

  t('paused: the bidding kill switch answers 503 before any cost', async (k) => {
    const a = await arena(k);
    const { clearFlagMemo } = await import('../flags');
    await k.env.pool.query(`insert into app_flags (key, value) values ('bidding', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`);
    clearFlagMemo();
    const res = await send(bidBody({ ...a, amount: 50n * USDC, who: a.bidders[0] }));
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('paused');
    await k.env.pool.query(`delete from app_flags where key = 'bidding'`);
    clearFlagMemo();
    expect((await send(bidBody({ ...a, amount: 50n * USDC, who: a.bidders[0] }), { ip: freshIp() })).status).toBe(200);
  });

  t('replay: a nonce the bidder already used is refused, even for a new valid amount', async (k) => {
    const a = await arena(k);
    const [bob, amy] = a.bidders;
    const first = bidBody({ ...a, amount: 50n * USDC, who: bob });
    expect((await send(first)).status).toBe(200);
    expect((await send(bidBody({ ...a, amount: 55n * USDC, who: amy }))).status).toBe(200);
    await resetLimits(k.env);
    const nonceUsed = /nonce: ([0-9a-f]{16})/.exec(first.intent.message)![1];
    const reuse = await send(bidBody({ ...a, amount: 60n * USDC, who: bob, text: { nonce: nonceUsed } }));
    expect(reuse.status).toBe(409);
    expect(await code(reuse)).toBe('replay');
    await resetLimits(k.env);
    const stale = await send(first); // the identical captured request: the lot has moved on, so it is simply too low
    expect(stale.status).toBe(409);
    expect((await k.env.pool.query(`select count(*)::int c from bids where lot_id = $1`, [a.lotId])).rows[0].c).toBe(2);
  });
});

describe('a public bid cannot be used to lock its bidder out', () => {
  t('re-sending an accepted (and publicly listed) bid is answered replay and never spends the bidder\'s rate window or an RPC call', async (k) => {
    const a = await arena(k);
    const [bob] = a.bidders;
    const first = bidBody({ ...a, amount: 50n * USDC, who: bob });
    expect((await send(first)).status).toBe(200);
    const windowOf = async () => Number((await k.env.pool.query(`select coalesce(sum(count), 0)::int c from rate_limits where key = $1`, ['w:bid:' + bob.actor.wallet])).rows[0].c);
    const before = await windowOf();
    const calls = k.fake.balanceCalls;
    for (let i = 0; i < 5; i++) {
      const again = await send(first); // the grief: anybody can read this text and signature from /api/lots/:id/bids
      expect(again.status).toBe(409);
      expect(await code(again)).toBe('replay'); // not 429 rate_limited: the limiter is never reached
    }
    expect(await windowOf()).toBe(before);
    expect(k.fake.balanceCalls).toBe(calls);
  });
});

describe('the intent is checked before it can cost anything', () => {
  /** every one of these is a 401 bad_signature and must not touch the RPC or the wallet's rate window */
  const tampers: Array<[string, (a: Awaited<ReturnType<typeof arena>>, who: Bidder) => ReturnType<typeof bidBody>]> = [
    ['an amount in the text that differs from the body', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, text: { amount: String(500n * USDC) } })],
    ['a body amount that differs from the signed text', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, body: { amount: String(60n * USDC) } })],
    ['a lot in the text that is not the lot in the body', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, text: { lot: '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11' } })],
    ['a show in the text that is not the lot\'s show', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, text: { show: '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10' } })],
    ['a cluster that is not this deployment\'s', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, text: { cluster: 'mainnet-beta' } })],
    ['an old intent (issued 10 minutes ago)', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, text: { issued: Date.now() - 600_000 } })],
    ['a signature by somebody else', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, signWith: actor() })],
    ['a session-signed intent signed by the wallet instead', (a, who) => bidBody({ ...a, amount: 50n * USDC, who, signer: 'session', signWith: who.actor })],
    ['text that is not a bid at all', (a, who) => ({ ...bidBody({ ...a, amount: 50n * USDC, who }), intent: { message: 'please let me bid', signature: who.actor.sign('please let me bid'), signer: 'wallet' as const } })],
  ];
  for (const [name, make] of tampers) {
    t(`refuses ${name}`, async (k) => {
      const a = await arena(k);
      const [bob] = a.bidders;
      const res = await send(make(a, bob));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe('bad_signature');
      expect(k.fake.balanceCalls).toBe(0); // no RPC for junk
      expect(await send(bidBody({ ...a, amount: 50n * USDC, who: bob }))).toHaveProperty('status', 200); // and the wallet's rate window is untouched
    });
  }

  t('a bidder claimed in the text who is not the cookie\'s wallet is refused', async (k) => {
    const a = await arena(k);
    const [bob, amy] = a.bidders;
    const { signIn } = await import('./kit');
    const res = await send(bidBody({ ...a, amount: 50n * USDC, who: bob }), { cookie: await signIn(amy.actor) });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('bad_signature');
  });

  t('an unknown lot is 404, a malformed lot id is 400, before any lookup of the bidder', async (k) => {
    const a = await arena(k);
    const body = bidBody({ ...a, amount: 50n * USDC, who: a.bidders[0], text: { lot: '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11' }, body: { lotId: '8a1b7c40-52de-4a6f-b3e1-0c9d2f4a6e11' } });
    const res = await send(body);
    expect(res.status).toBe(404);
    expect(await code(res)).toBe('not_found');
    expect((await send({ ...body, lotId: 'not-a-uuid' })).status).toBe(400);
  });

  t('the paddle session key\'s limits: expired, revoked, above its max (a wallet-signed bid is not bound by the key\'s max)', async (k) => {
    const a = await arena(k, { bidders: 0 });
    const capped = await bidder(k.env, a.showId, { maxBid: 60n * USDC });
    const over = await send(bidBody({ ...a, amount: 70n * USDC, who: capped, signer: 'session' }));
    expect(over.status).toBe(403);
    expect(await code(over.clone())).toBe('no_paddle');
    expect((await over.clone().json()).detail).toBe('paddle_limit'); // K6: the room tells "over your spending limit" from "no bidder number"
    await resetLimits(k.env);
    expect((await send(bidBody({ ...a, amount: 60n * USDC, who: capped, signer: 'session' }))).status).toBe(200); // exactly at the max
    const other = await bidder(k.env, a.showId, { maxBid: 60n * USDC });
    expect((await send(bidBody({ ...a, amount: 70n * USDC, who: other, signer: 'wallet' }))).status).toBe(200); // the wallet itself signed

    const expired = await bidder(k.env, a.showId);
    await k.env.pool.query(`update paddles set valid_until = now() - interval '1 minute' where id = $1`, [expired.paddleId]);
    const e1 = await send(bidBody({ ...a, amount: 100n * USDC, who: expired, signer: 'session' }));
    expect(await code(e1.clone())).toBe('no_paddle');
    expect((await e1.json()).detail).toBeUndefined(); // an expired paddle is not "over the limit"
    expect((await send(bidBody({ ...a, amount: 100n * USDC, who: expired, signer: 'wallet' }))).status).toBe(403); // the engine refuses an expired paddle for every signer
    const revoked = await bidder(k.env, a.showId);
    await k.env.pool.query(`update paddles set revoked_at = now() where id = $1`, [revoked.paddleId]);
    expect(await code(await send(bidBody({ ...a, amount: 100n * USDC, who: revoked, signer: 'session' })))).toBe('no_paddle');
    expect(k.fake.balanceCalls).toBe(3); // only the three requests that passed the paddle checks read a balance
  });
});

describe('the size and JSON guard comes first', () => {
  t('refuses non-JSON, oversized, malformed and unknown-field bodies with 400, and a cross-origin browser write with 403', async (k) => {
    const a = await arena(k);
    const good = bidBody({ ...a, amount: 50n * USDC, who: a.bidders[0] });
    expect((await POST(req('/api/bids', { body: 'amount=1', headers: { 'content-type': 'text/plain' } }))).status).toBe(400);
    expect((await POST(req('/api/bids', { body: '{not json' }))).status).toBe(400);
    expect((await send({ ...good, extra: 1 })).status).toBe(400);
    expect((await send({ ...good, amount: '-5' })).status).toBe(400);
    expect((await send({ lotId: a.lotId, amount: '5' })).status).toBe(400);
    expect((await send({ ...good, intent: { ...good.intent, pad: 'x'.repeat(17_000) } })).status).toBe(400);
    const evil = await send(good, { headers: { origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(await code(evil)).toBe('forbidden');
    expect(k.fake.balanceCalls).toBe(0);
  });
});

describe('fifty bidders at once', () => {
  t('50 wallets bid different amounts through the handler: the lot lock serialises them, nothing is lost or double counted', async (k) => {
    const a = await arena(k, { bidders: 0 });
    const people: Bidder[] = [];
    for (let n = 0; n < 50; n++) people.push(await bidder(k.env, a.showId));
    const results = await Promise.all(people.map((who, n) => send(bidBody({ ...a, amount: (50n + 5n * BigInt(n)) * USDC, who, signer: n % 2 ? 'session' : 'wallet' }))));
    const statuses = results.map((r) => r.status);
    for (const r of results) {
      if (r.status !== 200) expect(['bid_too_low', 'already_high_bidder']).toContain(await code(r.clone()));
    }
    expect(statuses.every((s) => s === 200 || s === 409), statuses.join(',')).toBe(true);
    const ok = statuses.filter((s) => s === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);

    const { rows: accepted } = await k.env.pool.query(`select amount::text a, bidder_id from bids where lot_id = $1 order by placed_at, id`, [a.lotId]);
    expect(accepted).toHaveLength(ok); // every 200 has its row, no row without a 200
    const amounts = accepted.map((r) => BigInt(r.a));
    for (let n = 1; n < amounts.length; n++) expect(amounts[n] > amounts[n - 1]).toBe(true); // strictly increasing in placement order
    const lot = await k.env.lot(a.lotId);
    expect(lot.bid_count).toBe(ok);
    expect(BigInt(lot.high_bid)).toBe(amounts[amounts.length - 1]);
    expect(BigInt(lot.high_bid)).toBe((50n + 5n * 49n) * USDC); // the top bid always lands: nothing can outrank it
    expect(lot.high_bidder_id).toBe(people[49].profileId);
    const { rows: [{ c }] } = await k.env.pool.query(`select count(*)::int c from show_events where show_id = $1 and kind = 'bid.placed'`, [a.showId]);
    expect(c).toBe(ok);
  }, 120_000);
});
