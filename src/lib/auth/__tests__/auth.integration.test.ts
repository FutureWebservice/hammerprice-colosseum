/**
 * Sign-in, sessions and the AUTH routes against a REAL Postgres 18 (embedded-postgres, the real migrations)
 * and real ed25519 signatures. The auction engine and the chain reads are not ours: they are the small fakes
 * below, passed through `setServices` exactly as the integration wiring will.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApiError, MeResponse, AuthVerifyResponse, ErrorResponseSchema, PaddleResponse } from '@/contracts';
import openSnapshot from '@/contracts/fixtures/live-snapshot.open.json';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { buildLoginMessage, LOGIN_TTL_MS } from '../login';
import { buildPaddleAuth } from '../intent';
import { actor, paddleFields, type Actor } from './testkit';

const HOST = 'localhost:3000';
const ORIGIN = `http://${HOST}`;
let t: TestPg | undefined;
let skipReason: string | undefined;

// Filled in by beforeAll, after DATABASE_URL points at the embedded server (src/db throws on import without it).
let routes: {
  challenge: (r: Request) => Promise<Response>;
  verify: (r: Request) => Promise<Response>;
  logout: (r: Request) => Promise<Response>;
  me: (r: Request) => Promise<Response>;
  paddlePost: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
  paddleDelete: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
};
let login: typeof import('../login');
let session: typeof import('../session');
let store: typeof import('../store');
let deps: typeof import('../deps');

beforeAll(async () => {
  const r = await startTestPg();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  routes = {
    challenge: (await import('@/app/api/auth/challenge/route')).POST,
    verify: (await import('@/app/api/auth/verify/route')).POST,
    logout: (await import('@/app/api/auth/logout/route')).POST,
    me: (await import('@/app/api/me/route')).GET,
    paddlePost: (await import('@/app/api/shows/[id]/paddle/route')).POST,
    paddleDelete: (await import('@/app/api/shows/[id]/paddle/route')).DELETE,
  };
  login = await import('../login');
  session = await import('../session');
  store = await import('../store');
  deps = await import('../deps');
}, 120_000);
afterAll(async () => {
  // the app's own pool (src/db) must close before the server goes away, or its connections die noisily
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300)); // let the sockets close before the server goes: a FATAL on a closing socket is an uncaught error under load
  await t?.stop();
});

const it_ = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

let ipCounter = 0;
/** A fresh client address per call so the per-IP limits of one test never bleed into another. */
const freshIp = () => `10.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}.7`;

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-forwarded-for': freshIp(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

async function challengeFor(a: Actor, ip = freshIp()) {
  const res = await routes.challenge(post('/api/auth/challenge', { wallet: a.wallet }, { 'x-forwarded-for': ip }));
  expect(res.status).toBe(200);
  return (await json(res)) as { nonce: string; message: string; expiresAt: string };
}

/** Full sign-in through the two routes. Returns the cookie header value to send back. */
async function signIn(a: Actor): Promise<string> {
  const c = await challengeFor(a);
  const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: a.sign(c.message) }));
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0];
}

const authed = (path: string, cookie: string, init: RequestInit = {}) =>
  new Request(`${ORIGIN}${path}`, { ...init, headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...(init.headers as object) } });

describe('sign-in over the routes', () => {
  it_('challenge then verify sets a session cookie and returns the profile', async () => {
    const a = actor();
    const c = await challengeFor(a);
    expect(c.message).toContain(`${HOST} wants you to sign in with your Solana account:\n${a.wallet}\n`);
    expect(c.message).toContain('Chain ID: devnet');
    expect(new Date(c.expiresAt).getTime() - Date.now()).toBeGreaterThan(LOGIN_TTL_MS - 5000);

    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: a.sign(c.message) }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = AuthVerifyResponse.parse(await res.json());
    expect(body.wallet).toBe(a.wallet);
    expect(body.profile).toMatchObject({ isSeller: false, strikes: 0 });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^hp_session=[\w-]+\.[\w-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/); // localhost: no Secure
    const { rows } = await t!.pool.query(`select action, actor_wallet from audit_logs where action='login' and actor_wallet=$1`, [a.wallet]);
    expect(rows).toHaveLength(1);
  });

  it_('logging in again keeps the same profile', async () => {
    const a = actor();
    const c1 = await challengeFor(a);
    const r1 = AuthVerifyResponse.parse(await (await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c1.message, signature: a.sign(c1.message) }))).json());
    const c2 = await challengeFor(a);
    const r2 = AuthVerifyResponse.parse(await (await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c2.message, signature: a.sign(c2.message) }))).json());
    expect(r2.profile.id).toBe(r1.profile.id);
  });

  it_('REPLAY: the same signed login cannot be used twice', async () => {
    const a = actor();
    const c = await challengeFor(a);
    const body = { wallet: a.wallet, message: c.message, signature: a.sign(c.message) };
    expect((await routes.verify(post('/api/auth/verify', body))).status).toBe(200);
    const again = await routes.verify(post('/api/auth/verify', body));
    expect(again.status).toBe(401);
    expect(ErrorResponseSchema.parse(await again.json()).code).toBe('nonce_used');
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it_('REPLAY under concurrency: five simultaneous verifies of one signature, exactly one wins', async () => {
    const a = actor();
    const c = await challengeFor(a);
    const body = { wallet: a.wallet, message: c.message, signature: a.sign(c.message) };
    const results = await Promise.all(Array.from({ length: 5 }, () => routes.verify(post('/api/auth/verify', body))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401, 401, 401]);
  });

  it_('a challenge issued to one wallet cannot be used by another', async () => {
    const victim = actor();
    const attacker = actor();
    const c = await challengeFor(victim);
    // the attacker rewrites the message for their own wallet around the victim's nonce and signs it
    const forged = c.message.replace(victim.wallet, attacker.wallet);
    const res = await routes.verify(post('/api/auth/verify', { wallet: attacker.wallet, message: forged, signature: attacker.sign(forged) }));
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('nonce_used');
    // and the victim's challenge is still good
    expect((await routes.verify(post('/api/auth/verify', { wallet: victim.wallet, message: c.message, signature: victim.sign(c.message) }))).status).toBe(200);
  });

  it_('a wrong signature is refused and does not burn the nonce', async () => {
    const a = actor();
    const c = await challengeFor(a);
    const bad = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: actor().sign(c.message) }));
    expect(bad.status).toBe(401);
    expect(ErrorResponseSchema.parse(await bad.json()).code).toBe('bad_signature');
    expect((await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: a.sign(c.message) }))).status).toBe(200);
  });

  it_('refuses a signature over a message with any byte changed', async () => {
    const a = actor();
    const c = await challengeFor(a);
    const sig = a.sign(c.message);
    const tampered = c.message.replace('Sign in to Hammerprice', 'Sign in to Hammerprize');
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: tampered, signature: sig }));
    expect(res.status).toBe(400); // no longer the one fixed text
  });

  it_('a message for another domain is refused (phishing site relaying a challenge)', async () => {
    const a = actor();
    const c = await challengeFor(a);
    const evil = c.message.replace(`http://${HOST}`, 'https://evil.example').replaceAll(HOST, 'evil.example');
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: evil, signature: a.sign(evil) }));
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('wrong_domain');
  });

  it_('a message for another cluster is refused', async () => {
    const a = actor();
    const c = await challengeFor(a);
    const main = c.message.replace('Chain ID: devnet', 'Chain ID: mainnet-beta');
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: main, signature: a.sign(main) }));
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(await res.json()).reason).toContain('cluster');
  });

  it_('a message for a different wallet than the body names is refused', async () => {
    const a = actor();
    const b = actor();
    const c = await challengeFor(a);
    const res = await routes.verify(post('/api/auth/verify', { wallet: b.wallet, message: c.message, signature: a.sign(c.message) }));
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('bad_signature');
  });

  it_('EXPIRY: an expired message is refused, and so is a nonce whose row has expired', async () => {
    const a = actor();
    const old = await login.issueChallenge({ wallet: a.wallet, host: HOST, nowMs: Date.now() - LOGIN_TTL_MS - 1000 });
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: old.message, signature: a.sign(old.message) }));
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('expired');

    // message still inside its window but the stored row already past expires_at
    const fresh = await challengeFor(a);
    await t!.pool.query(`update auth_nonces set expires_at = now() - interval '1 second' where nonce = $1`, [fresh.nonce]);
    const res2 = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: fresh.message, signature: a.sign(fresh.message) }));
    expect(res2.status).toBe(401);
    expect(ErrorResponseSchema.parse(await res2.json()).code).toBe('nonce_used');
  });

  it_('an unknown nonce (a message the server never issued) is refused', async () => {
    const a = actor();
    const now = Date.now();
    const message = buildLoginMessage({ host: HOST, wallet: a.wallet, chain: 'devnet', nonce: '5Hq8mC2vYtN3xZ9bKdLw4r', issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + LOGIN_TTL_MS).toISOString() });
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message, signature: a.sign(message) }));
    expect(res.status).toBe(401);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('nonce_used');
  });

  it_('challenge sweeps long-expired nonces', async () => {
    await t!.pool.query(`insert into auth_nonces (nonce, wallet_address, expires_at) values ('stale-nonce-0000000000', 'w', now() - interval '2 hours')`);
    await challengeFor(actor());
    const { rows } = await t!.pool.query(`select 1 from auth_nonces where nonce = 'stale-nonce-0000000000'`);
    expect(rows).toHaveLength(0);
  });

  it_('a banned wallet cannot sign in (403 banned, no cookie)', async () => {
    const a = actor();
    await signIn(a);
    await t!.pool.query(`update profiles set is_banned = true, strikes = 20 where wallet_address = $1`, [a.wallet]);
    const c = await challengeFor(a);
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: a.sign(c.message) }));
    expect(res.status).toBe(403);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('banned');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it_('a suspension set under the old limit of 3 strikes lifts itself at the next sign-in', async () => {
    const a = actor();
    await signIn(a);
    await t!.pool.query(`update profiles set is_banned = true, strikes = 3, banned_reason = '3 settlements not completed' where wallet_address = $1`, [a.wallet]);
    const c = await challengeFor(a);
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: a.sign(c.message) }));
    expect(res.status).toBe(200);
    const row = (await t!.pool.query(`select is_banned, banned_reason, strikes from profiles where wallet_address = $1`, [a.wallet])).rows[0];
    expect(row).toMatchObject({ is_banned: false, banned_reason: null, strikes: 3 });
  });

  it_('any other suspension stays: a manual ban with few strikes is not lifted by signing in', async () => {
    const a = actor();
    await signIn(a);
    await t!.pool.query(`update profiles set is_banned = true, strikes = 0, banned_reason = 'abuse' where wallet_address = $1`, [a.wallet]);
    const c = await challengeFor(a);
    const res = await routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: c.message, signature: a.sign(c.message) }));
    expect(res.status).toBe(403);
    expect((await t!.pool.query(`select is_banned from profiles where wallet_address = $1`, [a.wallet])).rows[0].is_banned).toBe(true);
  });
});

describe('sessions', () => {
  it_('S10: requireSession refuses a banned profile holding a still-valid cookie, and me says banned', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const ok = await routes.me(authed('/api/me', cookie));
    expect(ok.status).toBe(200);
    await t!.pool.query(`update profiles set is_banned = true, banned_at = now() where wallet_address = $1`, [a.wallet]);
    await expect(session.requireSession(authed('/api/me', cookie))).rejects.toMatchObject({ code: 'banned', status: 403 });
    const res = await routes.me(authed('/api/me', cookie));
    expect(res.status).toBe(403);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('banned');
  });

  it_('requireSession: no cookie, a forged cookie and an unknown profile are all refused (GET /api/me: 204)', async () => {
    await expect(session.requireSession(new Request(`${ORIGIN}/api/me`))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(session.requireSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: 'hp_session=abc.def' } }))).rejects.toMatchObject({ code: 'unauthenticated' });
    const ghost = await session.signSession({ wallet: actor().wallet, profileId: randomUUID() });
    await expect(session.requireSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `hp_session=${ghost}` } }))).rejects.toBeInstanceOf(ApiError);
    // GET /api/me is session_optional: no session is a 204, never a 401 (an anonymous console stays clean)
    expect((await routes.me(new Request(`${ORIGIN}/api/me`))).status).toBe(204);
    expect((await routes.me(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `hp_session=${ghost}` } }))).status).toBe(204);
  });

  it_('requireSession: a cookie whose wallet no longer matches its profile is refused', async () => {
    const a = actor();
    await signIn(a);
    const { rows } = await t!.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet]);
    const swapped = await session.signSession({ wallet: actor().wallet, profileId: rows[0].id });
    await expect(session.requireSession(new Request(`${ORIGIN}/api/me`, { headers: { cookie: `hp_session=${swapped}` } }))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it_('logout clears the cookie and needs no session', async () => {
    const res = await routes.logout(post('/api/auth/logout', ''));
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it_('the AuthApi object is complete and wired', async () => {
    const { auth } = await import('../index');
    expect(Object.keys(auth).sort()).toEqual(['getSession', 'parseBidIntent', 'rateLimit', 'requireSession', 'verifyBidIntent', 'verifyPaddleAuth']);
    expect(await auth.rateLimit(`test:api:${randomUUID()}`, 1, 60)).toEqual({ ok: true, retryAfterS: 0 });
  });
});

describe('request hygiene on the routes', () => {
  it_('refuses a cross-origin browser POST on every write route (CSRF)', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const evil = { origin: 'https://evil.example' };
    const show = randomUUID();
    const cases: Array<[string, Promise<Response>]> = [
      ['challenge', routes.challenge(post('/api/auth/challenge', { wallet: a.wallet }, evil))],
      ['verify', routes.verify(post('/api/auth/verify', { wallet: a.wallet, message: 'x', signature: 'y' }, evil))],
      ['logout', routes.logout(post('/api/auth/logout', '', evil))],
      ['paddle post', routes.paddlePost(authed(`/api/shows/${show}/paddle`, cookie, { method: 'POST', body: '{}', headers: evil }), { params: Promise.resolve({ id: show }) })],
      ['paddle delete', routes.paddleDelete(authed(`/api/shows/${show}/paddle`, cookie, { method: 'DELETE', headers: evil }), { params: Promise.resolve({ id: show }) })],
    ];
    for (const [name, p] of cases) {
      const res = await p;
      expect(res.status, name).toBe(403);
      expect(ErrorResponseSchema.parse(await res.json()).code, name).toBe('forbidden');
    }
  });

  it_('refuses Sec-Fetch-Site cross-site, and accepts same-origin and header-less (curl) callers', async () => {
    const a = actor();
    const headers = (extra: Record<string, string>) => ({ 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...extra });
    const send = (extra: Record<string, string>) => routes.challenge(new Request(`${ORIGIN}/api/auth/challenge`, { method: 'POST', headers: headers(extra), body: JSON.stringify({ wallet: a.wallet }) }));
    expect((await send({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await send({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect((await send({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await send({ origin: 'null' })).status).toBe(403);
    const curl = new Request(`${ORIGIN}/api/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.4.0', 'x-forwarded-for': freshIp() }, body: JSON.stringify({ wallet: a.wallet }) });
    expect((await routes.challenge(curl)).status).toBe(200);
  });

  it_('rejects non-JSON, oversized, malformed and unknown-field bodies with 400', async () => {
    const a = actor();
    const textPlain = await routes.challenge(post('/api/auth/challenge', 'wallet=x', { 'content-type': 'text/plain' }));
    expect(textPlain.status).toBe(400);
    const big = await routes.challenge(post('/api/auth/challenge', JSON.stringify({ wallet: a.wallet, pad: 'x'.repeat(17_000) })));
    expect(big.status).toBe(400);
    expect((await routes.challenge(post('/api/auth/challenge', '{not json'))).status).toBe(400);
    expect((await routes.challenge(post('/api/auth/challenge', { wallet: a.wallet, extra: 1 }))).status).toBe(400);
    expect((await routes.challenge(post('/api/auth/challenge', { wallet: 'short' }))).status).toBe(400);
    // 32 valid base58 characters that are not a 32-byte key
    expect((await routes.challenge(post('/api/auth/challenge', { wallet: '1'.repeat(40) }))).status).toBe(400);
  });

  it_('rate limits the challenge route per IP: 10 per minute, then 429 with Retry-After', async () => {
    const a = actor();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await routes.challenge(post('/api/auth/challenge', { wallet: a.wallet }, { 'x-forwarded-for': ip }))).status).toBe(200);
    const res = await routes.challenge(post('/api/auth/challenge', { wallet: a.wallet }, { 'x-forwarded-for': ip }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    const body = ErrorResponseSchema.parse(await res.json());
    expect(body.code).toBe('rate_limited');
    expect(body.retryAfterS).toBeGreaterThanOrEqual(1);
    // another address is unaffected
    expect((await routes.challenge(post('/api/auth/challenge', { wallet: a.wallet }))).status).toBe(200);
  });
});

describe('GET /api/me', () => {
  const SHOW = openSnapshot.show.id;
  const LOT = openSnapshot.current.lotId;
  const snapshot = (paddleNumber: number | null) => ({ ...openSnapshot, lots: openSnapshot.lots.map((l) => (l.id === LOT ? { ...l, highBidder: paddleNumber === null ? null : { paddle: paddleNumber } } : l)) });

  async function seed(a: Actor) {
    const cookie = await signIn(a);
    const { rows } = await t!.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet]);
    const profileId = rows[0].id as string;
    await t!.pool.query(`insert into profiles (id, wallet_address) values ($1, $2) on conflict do nothing`, [randomUUID(), `seller-${randomUUID()}`]);
    return { cookie, profileId };
  }

  it_('with the services down it still answers: funds null, no paddle, empty pending', async () => {
    deps.setServices({ chain: { getUsdcBalance: async () => { throw new ApiError('balance_unavailable'); } } });
    const a = actor();
    const { cookie } = await seed(a);
    const res = await routes.me(authed('/api/me', cookie));
    expect(res.status).toBe(200);
    const me = MeResponse.parse(await res.json());
    expect(me.wallet).toBe(a.wallet);
    expect(me.funds.usdc).toBeNull();
    expect(me.pending).toEqual([]);
    expect(me.paddle).toBeUndefined();
  });

  it_('reports spendable funds (balance minus commitments) and the paddle, leading and outbid standing, pending settlements', async () => {
    const a = actor();
    const { cookie, profileId } = await seed(a);
    const sellerId = randomUUID();
    await t!.pool.query(`insert into profiles (id, wallet_address) values ($1, $2)`, [sellerId, `seller-${sellerId}`]);
    await t!.pool.query(`insert into shows (id, seller_id, title, status) values ($1, $2, 'Test show', 'live')`, [SHOW, sellerId]);
    await t!.pool.query(`insert into lots (id, show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price, state) values ($1, $2, $3, 1, $4, 'core', 'Lot', 5000000, 10000000, 'open')`, [LOT, SHOW, sellerId, `mint-${LOT}`]);
    await t!.pool.query(`insert into paddles (show_id, profile_id, number, session_pubkey, valid_until, auth_message, auth_signature) values ($1, $2, 7, 'k', now() + interval '1 hour', 'm', 's')`, [SHOW, profileId]);
    await t!.pool.query(`insert into bids (lot_id, bidder_id, amount, signature, message, nonce) values ($1, $2, 75000000, 's', 'm', 'n1')`, [LOT, profileId]);
    const settlementId = randomUUID();
    await t!.pool.query(`insert into settlements (id, lot_id, buyer_id, seller_id, gross_amount, platform_fee, seller_amount, status, due_at) values ($1, $2, $3, $4, 120000000, 3000000, 117000000, 'awaiting_payment', now() + interval '10 minutes')`, [settlementId, LOT, profileId, sellerId]);
    const snap = vi.fn(async () => snapshot(7) as never);
    deps.setServices({
      chain: { getUsdcBalance: async () => 500_000_000n },
      auction: { commitmentsFor: async () => 120_000_000n, getLiveSnapshot: snap, registerPaddle: vi.fn() },
    });

    let me = MeResponse.parse(await (await routes.me(authed(`/api/me?show=${SHOW}`, cookie))).json());
    expect(me.funds.usdc).toBe('380000000');
    expect(me.paddle).toMatchObject({ number: 7, funded: true });
    expect(me.standing).toEqual({ lotId: LOT, status: 'leading' });
    expect(me.pending).toEqual([expect.objectContaining({ settlementId, lotId: LOT, role: 'buyer', status: 'awaiting_payment', gross: '120000000' })]);

    snap.mockResolvedValue(snapshot(9) as never); // someone else leads now, this profile has a bid on the lot
    me = MeResponse.parse(await (await routes.me(authed(`/api/me?show=${SHOW}`, cookie))).json());
    expect(me.standing).toEqual({ lotId: LOT, status: 'outbid' });

    // no bid on the lot and not leading: no standing
    await t!.pool.query(`delete from bids where bidder_id = $1`, [profileId]);
    me = MeResponse.parse(await (await routes.me(authed(`/api/me?show=${SHOW}`, cookie))).json());
    expect(me.standing).toBeUndefined();

    // the RPC is down: funds null, the route still answers and funded is false
    deps.setServices({ chain: { getUsdcBalance: async () => { throw new ApiError('balance_unavailable'); } } });
    me = MeResponse.parse(await (await routes.me(authed(`/api/me?show=${SHOW}`, cookie))).json());
    expect(me.funds.usdc).toBeNull();
    expect(me.paddle?.funded).toBe(false);

    // the same call without ?show= carries no paddle or standing
    me = MeResponse.parse(await (await routes.me(authed('/api/me', cookie))).json());
    expect(me.paddle).toBeUndefined();
    expect(me.standing).toBeUndefined();

    // a settled settlement is no longer pending
    await t!.pool.query(`update settlements set status = 'settled', tx_signature = 'sig' where id = $1`, [settlementId]);
    me = MeResponse.parse(await (await routes.me(authed('/api/me', cookie))).json());
    expect(me.pending).toEqual([]);

    // a revoked paddle disappears
    await t!.pool.query(`update paddles set revoked_at = now() where profile_id = $1`, [profileId]);
    me = MeResponse.parse(await (await routes.me(authed(`/api/me?show=${SHOW}`, cookie))).json());
    expect(me.paddle).toBeUndefined();
  });

  it_('rejects a show id that is not a uuid', async () => {
    const { cookie } = await seed(actor());
    expect((await routes.me(authed('/api/me?show=nope', cookie))).status).toBe(400);
  });
});

describe('paddle routes', () => {
  const showId = randomUUID();
  const validUntil = () => Date.now() + 2 * 3_600_000;
  const ctx = { params: Promise.resolve({ id: showId }) };

  function setup(over: { balance?: bigint | Error; status?: 'live' | 'ended'; snapshot?: null } = {}) {
    const registerPaddle = vi.fn(async (i: { validUntil: Date }) => ({ id: randomUUID(), number: 3, validUntil: i.validUntil.toISOString(), revokedAt: null }));
    deps.setServices({
      chain: { getUsdcBalance: async () => { if (over.balance instanceof Error) throw over.balance; return over.balance ?? 50_000_000n; } },
      auction: {
        registerPaddle,
        commitmentsFor: async () => 0n,
        getLiveSnapshot: async () => (over.snapshot === null ? null : ({ ...openSnapshot, show: { ...openSnapshot.show, id: showId, status: over.status ?? 'live' } } as never)),
      },
    });
    return registerPaddle;
  }

  async function registration(a: Actor, over: Partial<ReturnType<typeof paddleFields>> = {}) {
    const session = actor();
    const message = buildPaddleAuth({ ...paddleFields(a.wallet, session.wallet), show: showId, valid: validUntil(), ...over });
    return { session, message, signature: a.sign(message) };
  }

  it_('registers a paddle from the signed authorisation and answers 201 with the contract shape', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const registerPaddle = setup();
    const reg = await registration(a);
    const res = await routes.paddlePost(authed(`/api/shows/${showId}/paddle`, cookie, { method: 'POST', body: JSON.stringify({ message: reg.message, signature: reg.signature, sessionPubkey: reg.session.wallet, maxBid: '500000000' }) }), ctx);
    expect(res.status).toBe(201);
    const body = PaddleResponse.parse(await res.json());
    expect(body.number).toBe(3);
    const call = registerPaddle.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ showId, sessionPubkey: reg.session.wallet, maxBid: 500_000_000n, authMessage: reg.message, authSignature: reg.signature });
    expect(call.validUntil).toBeInstanceOf(Date);
  });

  it_('needs a session', async () => {
    setup();
    const reg = await registration(actor());
    const res = await routes.paddlePost(post(`/api/shows/${showId}/paddle`, { message: reg.message, signature: reg.signature }), ctx);
    expect(res.status).toBe(401);
  });

  it_('refuses a signature by another wallet, another show, an expired or too long authorisation', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const registerPaddle = setup();
    const send = async (reg: { message: string; signature: string }) =>
      routes.paddlePost(authed(`/api/shows/${showId}/paddle`, cookie, { method: 'POST', body: JSON.stringify({ message: reg.message, signature: reg.signature }) }), ctx);
    const other = actor();
    const forged = await registration(a);
    expect((await send({ message: forged.message, signature: other.sign(forged.message) })).status).toBe(401);
    expect((await send(await registration(a, { show: randomUUID() }))).status).toBe(401);
    expect((await send(await registration(a, { valid: Date.now() - 1000 }))).status).toBe(401);
    expect((await send(await registration(a, { valid: Date.now() + 7 * 3_600_000 }))).status).toBe(401);
    expect((await send(await registration(a, { wallet: other.wallet }))).status).toBe(401);
    expect(registerPaddle).not.toHaveBeenCalled();
  });

  it_('refuses a body that disagrees with the signed key or ceiling', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const registerPaddle = setup();
    const reg = await registration(a);
    const bad = (extra: object) => routes.paddlePost(authed(`/api/shows/${showId}/paddle`, cookie, { method: 'POST', body: JSON.stringify({ message: reg.message, signature: reg.signature, ...extra }) }), ctx);
    expect((await bad({ sessionPubkey: actor().wallet })).status).toBe(400);
    expect((await bad({ maxBid: '500000001' })).status).toBe(400);
    expect(registerPaddle).not.toHaveBeenCalled();
  });

  it_('an unfunded wallet gets insufficient_funds, an unreadable balance gets 503 and nothing is registered', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const reg = await registration(a);
    const go = () => routes.paddlePost(authed(`/api/shows/${showId}/paddle`, cookie, { method: 'POST', body: JSON.stringify({ message: reg.message, signature: reg.signature }) }), ctx);

    const registerPaddle = setup({ balance: 999_999n });
    let res = await go();
    expect(res.status).toBe(409);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('insufficient_funds');

    setup({ balance: new Error('rpc down') });
    res = await go();
    expect(res.status).toBe(503);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('balance_unavailable');
    expect(registerPaddle).not.toHaveBeenCalled();
  });

  it_('an ended or unknown show is refused', async () => {
    const a = actor();
    const cookie = await signIn(a);
    const reg = await registration(a);
    const go = () => routes.paddlePost(authed(`/api/shows/${showId}/paddle`, cookie, { method: 'POST', body: JSON.stringify({ message: reg.message, signature: reg.signature }) }), ctx);
    setup({ status: 'ended' });
    let res = await go();
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('show_ended');
    setup({ snapshot: null });
    res = await go();
    expect(res.status).toBe(404);
  });

  it_('a malformed show id is 404', async () => {
    const cookie = await signIn(actor());
    const res = await routes.paddlePost(authed('/api/shows/nope/paddle', cookie, { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'nope' }) });
    expect(res.status).toBe(404);
  });

  it_('DELETE revokes the paddle (idempotent) and only this wallet\'s', async () => {
    const a = actor();
    const b = actor();
    const cookieA = await signIn(a);
    const cookieB = await signIn(b);
    const sellerId = randomUUID();
    const showRow = randomUUID();
    await t!.pool.query(`insert into profiles (id, wallet_address) values ($1, $2)`, [sellerId, `seller-${sellerId}`]);
    await t!.pool.query(`insert into shows (id, seller_id, title) values ($1, $2, 'Revoke show')`, [showRow, sellerId]);
    const ids: Record<string, string> = {};
    for (const [name, w] of [['a', a], ['b', b]] as const) {
      const { rows } = await t!.pool.query(`select id from profiles where wallet_address = $1`, [w.wallet]);
      ids[name] = rows[0].id;
    }
    await t!.pool.query(`insert into paddles (show_id, profile_id, number, session_pubkey, valid_until, auth_message, auth_signature) values ($1, $2, 1, 'k', now() + interval '1 hour', 'm', 's'), ($1, $3, 2, 'k', now() + interval '1 hour', 'm', 's')`, [showRow, ids.a, ids.b]);

    const del = (cookie: string) => routes.paddleDelete(authed(`/api/shows/${showRow}/paddle`, cookie, { method: 'DELETE' }), { params: Promise.resolve({ id: showRow }) });
    expect((await del(cookieA)).status).toBe(204);
    expect((await del(cookieA)).status).toBe(204);
    const { rows } = await t!.pool.query(`select profile_id, revoked_at is not null as revoked from paddles where show_id = $1 order by number`, [showRow]);
    expect(rows).toEqual([{ profile_id: ids.a, revoked: true }, { profile_id: ids.b, revoked: false }]);
    expect((await del(cookieB)).status).toBe(204);
    expect((await routes.paddleDelete(new Request(`${ORIGIN}/api/shows/${showRow}/paddle`, { method: 'DELETE', headers: { origin: ORIGIN } }), { params: Promise.resolve({ id: showRow }) })).status).toBe(401);
  });
});

describe('store', () => {
  it_('consumeNonce is atomic: of many concurrent consumers exactly one wins', async () => {
    const wallet = actor().wallet;
    const nonce = `race-${randomUUID()}`;
    await store.insertNonce(nonce, wallet, new Date(Date.now() + 60_000), new Date(0));
    const wins = await Promise.all(Array.from({ length: 20 }, () => store.consumeNonce(nonce, wallet, new Date())));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
