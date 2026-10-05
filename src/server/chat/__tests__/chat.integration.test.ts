/**
 * The pre-moderated room chat against a REAL Postgres 18 (embedded-postgres, the real migrations) through the real route handlers and
 * real signed session cookies. Nothing is mocked except the clock where a test passes one.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ChatListResponse, ChatMineResponse, ChatModerateResponse, ChatQueueResponse, ErrorResponseSchema } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';

const HOST = 'localhost:3000';
const ORIGIN = `http://${HOST}`;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const wallet = () => Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');

let t: TestPg | undefined;
let skipReason: string | undefined;
type Ctx = { params: Promise<{ id: string }> };
let r: {
  list: (q: Request, c: Ctx) => Promise<Response>;
  post: (q: Request, c: Ctx) => Promise<Response>;
  mine: (q: Request, c: Ctx) => Promise<Response>;
  queue: (q: Request, c: Ctx) => Promise<Response>;
  moderate: (q: Request, c: Ctx) => Promise<Response>;
  report: (q: Request, c: Ctx) => Promise<Response>;
};
let svc: typeof import('../service');
let purge: typeof import('../purge');
let sess: typeof import('@/lib/auth/session');
let flags: typeof import('@/app/api/auctions/_shared/flags');

beforeAll(async () => {
  const s = await startTestPg();
  if ('skip' in s) { skipReason = s.skip; console.warn(s.skip); return; }
  t = s.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('FEATURE_CHAT', 'true');
  vi.stubEnv('CHAT_LIST_MEMO_MS', '0');
  r = {
    list: (await import('@/app/api/shows/[id]/chat/route')).GET,
    post: (await import('@/app/api/shows/[id]/chat/route')).POST,
    mine: (await import('@/app/api/shows/[id]/chat/mine/route')).GET,
    queue: (await import('@/app/api/shows/[id]/chat/queue/route')).GET,
    moderate: (await import('@/app/api/shows/[id]/chat/moderate/route')).POST,
    report: (await import('@/app/api/chat/[id]/report/route')).POST,
  };
  svc = await import('../service');
  purge = await import('../purge');
  sess = await import('@/lib/auth/session');
  flags = await import('@/app/api/auctions/_shared/flags');
}, 120_000);
afterAll(async () => {
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((res) => setTimeout(res, 300));
  await t?.stop();
});

const it_ = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
  it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

// ---- arrangement -----------------------------------------------------------------------------

interface Person { id: string; wallet: string; cookie: string }
let ip = 0;
const freshIp = () => `10.${(ip >> 8) & 255}.${ip++ & 255}.9`;
const q = (sql: string, args: unknown[] = []) => t!.pool.query(sql, args);

async function person(over: { bot?: boolean; banned?: boolean; wallet?: string } = {}): Promise<Person> {
  const w = over.wallet ?? wallet();
  const { rows } = await q(`insert into profiles (wallet_address, is_bot, is_banned) values ($1,$2,$3) returning id`, [w, over.bot ?? false, over.banned ?? false]);
  const token = await sess.signSession({ wallet: w, profileId: rows[0].id });
  return { id: rows[0].id, wallet: w, cookie: `hp_session=${token}` };
}
async function show(seller: Person, over: { status?: string; isHouse?: boolean; endedAt?: Date | null; cancelledAt?: Date | null; lots?: number } = {}): Promise<string> {
  const { rows } = await q(
    `insert into shows (seller_id, title, status, is_house, ended_at, cancelled_at, cluster, settlement_mode) values ($1,'Chat show',$2,$3,$4,$5,'devnet','onchain') returning id`,
    [seller.id, over.status ?? 'live', over.isHouse ?? false, over.endedAt ?? null, over.cancelledAt ?? null],
  );
  for (let n = 1; n <= (over.lots ?? 2); n++) {
    await q(`insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price, state, consign_status) values ($1,$2,$3,$4,'core',$5,5000000,50000000,'catalogued','ready')`, [rows[0].id, seller.id, n, wallet(), `Lot ${n}`]);
  }
  return rows[0].id;
}
let paddleNo = 0;
async function paddle(showId: string, p: Person, over: { revoked?: boolean; hours?: number } = {}): Promise<number> {
  const number = ++paddleNo;
  await q(`insert into paddles (show_id, profile_id, number, valid_until, auth_message, auth_signature, revoked_at) values ($1,$2,$3, now() + ($4 || ' hours')::interval, 'm', 's', $5)`, [showId, p.id, number, String(over.hours ?? 5), over.revoked ? new Date() : null]);
  return number;
}
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });
const req = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': freshIp(), ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const say = (showId: string, p: Person, body: string, extra: Record<string, unknown> = {}) =>
  r.post(req(`/api/shows/${showId}/chat`, { method: 'POST', cookie: p.cookie, body: { body, clientNonce: randomUUID(), ...extra } }), ctx(showId));
const publicList = async (showId: string) => ChatListResponse.parse(await (await r.list(req(`/api/shows/${showId}/chat`), ctx(showId))).json());
const mineOf = async (showId: string, p: Person) => ChatMineResponse.parse(await (await r.mine(req(`/api/shows/${showId}/chat/mine`, { cookie: p.cookie }), ctx(showId))).json());
const queueOf = async (showId: string, p: Person, filter = 'pending') => ChatQueueResponse.parse(await (await r.queue(req(`/api/shows/${showId}/chat/queue?filter=${filter}`, { cookie: p.cookie }), ctx(showId))).json());
const act = (showId: string, p: Person, body: unknown) => r.moderate(req(`/api/shows/${showId}/chat/moderate`, { method: 'POST', cookie: p.cookie, body }), ctx(showId));
const errOf = async (res: Response) => ErrorResponseSchema.parse(await res.json());
/** The wallet limiter allows one message per 3 s: tests that write several in a row go around it by changing the window key. */
const resetLimits = () => q(`delete from rate_limits`);

/** One room with an operator (the seller), a bidder with a paddle and a fresh show. */
async function room(over: Parameters<typeof show>[1] = {}) {
  const op = await person();
  const bidder = await person();
  const showId = await show(op, over);
  const number = await paddle(showId, bidder);
  return { op, bidder, showId, number };
}

// ---- the tests -------------------------------------------------------------------------------

describe('switches', () => {
  it_('off by environment: the public list says disabled, every other route is feature_off', async () => {
    const { bidder, showId } = await room();
    vi.stubEnv('FEATURE_CHAT', 'false');
    flags.clearFlagMemo();
    try {
      expect(await publicList(showId)).toEqual({ enabled: false, messages: [], lastSeq: 0 });
      const res = await say(showId, bidder, 'hello');
      expect(res.status).toBe(404);
      expect((await errOf(res)).code).toBe('feature_off');
      expect((await r.mine(req(`/api/shows/${showId}/chat/mine`, { cookie: bidder.cookie }), ctx(showId))).status).toBe(404);
    } finally { vi.stubEnv('FEATURE_CHAT', 'true'); flags.clearFlagMemo(); }
  });

  it_('the kill switch (app_flags.chat = false) turns it off without a redeploy', async () => {
    const { showId } = await room();
    await q(`insert into app_flags (key, value) values ('chat', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`);
    flags.clearFlagMemo();
    try { expect((await publicList(showId)).enabled).toBe(false); }
    finally { await q(`delete from app_flags where key = 'chat'`); flags.clearFlagMemo(); }
    expect((await publicList(showId)).enabled).toBe(true);
  });

  it_('an unknown show is a 404, a malformed id too', async () => {
    expect((await r.list(req('/api/shows/not-a-uuid/chat'), ctx('not-a-uuid'))).status).toBe(404);
    const id = randomUUID();
    expect((await r.list(req(`/api/shows/${id}/chat`), ctx(id))).status).toBe(404);
  });
});

describe('writing: pre-moderation', () => {
  it_('a bidder message is stored pending, visible to its author only, not in the public list', async () => {
    const { op, bidder, showId, number } = await room();
    const other = await person();
    await paddle(showId, other);
    const res = await say(showId, bidder, 'Is the card really PSA 10?', { lotNumber: 1 });
    expect(res.status).toBe(201);
    const { message } = await res.json() as { message: { id: string; status: string; body: string; lotNumber: number } };
    expect(message).toMatchObject({ status: 'pending', body: 'Is the card really PSA 10?', lotNumber: 1 });

    expect((await publicList(showId)).messages).toEqual([]);
    expect((await mineOf(showId, bidder)).messages.map((m) => [m.id, m.status])).toEqual([[message.id, 'pending']]);
    expect((await mineOf(showId, other)).messages).toEqual([]);
    expect((await mineOf(showId, bidder)).operator).toBe(false);

    const queue = await queueOf(showId, op);
    expect(queue.counts).toMatchObject({ pending: 1, approved: 0 });
    expect(queue.messages[0]).toMatchObject({ id: message.id, status: 'pending', paddle: number, wallet: bidder.wallet, role: 'bidder' });
  });

  it_('approve publishes it: the public list shows the bidder number and no wallet, the author sees it leave "mine"', async () => {
    const { op, bidder, showId, number } = await room();
    const { message } = await (await say(showId, bidder, 'Great pull, congrats!')).json() as { message: { id: string } };
    const res = await act(showId, op, { action: 'approve', messageIds: [message.id] });
    expect(ChatModerateResponse.parse(await res.json())).toEqual({ ok: true, affected: 1 });
    const list = await publicList(showId);
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]).toMatchObject({ id: message.id, paddle: number, role: 'bidder', source: 'user', body: 'Great pull, congrats!' });
    expect(list.lastSeq).toBe(list.messages[0].seq);
    expect((await mineOf(showId, bidder)).messages).toEqual([]);
    // approving twice changes nothing
    expect(ChatModerateResponse.parse(await (await act(showId, op, { action: 'approve', messageIds: [message.id] })).json()).affected).toBe(0);
  });

  it_('several at once, in the order they were published (a late approval lands at the bottom)', async () => {
    const { op, bidder, showId } = await room();
    const ids: string[] = [];
    for (const text of ['first', 'second', 'third']) {
      await resetLimits();
      ids.push(((await (await say(showId, bidder, text)).json()) as { message: { id: string } }).message.id);
    }
    await act(showId, op, { action: 'approve', messageIds: [ids[1]] });
    await new Promise((res) => setTimeout(res, 15));
    await act(showId, op, { action: 'approve', messageIds: [ids[0], ids[2]] });
    expect((await publicList(showId)).messages.map((m) => m.body)).toEqual(['second', 'first', 'third']);
    expect((await queueOf(showId, op, 'approved')).counts).toMatchObject({ pending: 0, approved: 3 });
  });

  it_('reject keeps it public-less and tells the author why', async () => {
    const { op, bidder, showId } = await room();
    const { message } = await (await say(showId, bidder, 'Buy my cards cheap')).json() as { message: { id: string } };
    expect((await act(showId, op, { action: 'reject', messageIds: [message.id], reason: 'Advertising is not allowed here.' })).status).toBe(200);
    expect((await publicList(showId)).messages).toEqual([]);
    expect((await mineOf(showId, bidder)).messages).toEqual([expect.objectContaining({ id: message.id, status: 'rejected', reason: 'Advertising is not allowed here.' })]);
    expect((await queueOf(showId, op, 'rejected')).messages[0]).toMatchObject({ status: 'rejected', reason: 'Advertising is not allowed here.' });
    // a rejected message can be published after all, and a public one withdrawn
    await act(showId, op, { action: 'approve', messageIds: [message.id] });
    expect((await publicList(showId)).messages).toHaveLength(1);
    await act(showId, op, { action: 'reject', messageIds: [message.id], reason: 'Changed my mind.' });
    expect((await publicList(showId)).messages).toEqual([]);
  });

  it_('the operator sees everything, including a message of another show nowhere', async () => {
    const a = await room();
    const b = await room();
    await say(a.showId, a.bidder, 'in room a');
    expect((await queueOf(b.showId, b.op, 'all')).messages).toEqual([]);
    expect((await queueOf(a.showId, a.op, 'all')).messages.map((m) => m.body)).toEqual(['in room a']);
    // moderating a message id of another show changes nothing
    const id = (await queueOf(a.showId, a.op)).messages[0].id;
    expect(ChatModerateResponse.parse(await (await act(b.showId, b.op, { action: 'approve', messageIds: [id] })).json()).affected).toBe(0);
  });

  it_('the operator posts as the operator: approved at once, role seller, no paddle needed', async () => {
    const { op, showId } = await room();
    const res = await say(showId, op, 'Welcome to lot 1.');
    expect(res.status).toBe(201);
    expect((await publicList(showId)).messages[0]).toMatchObject({ role: 'seller', paddle: null, body: 'Welcome to lot 1.', source: 'user' });
  });

  it_('retrying with the same clientNonce stores one message', async () => {
    const { bidder, showId } = await room();
    const body = { body: 'once only', clientNonce: randomUUID() };
    const a = await (await r.post(req(`/api/shows/${showId}/chat`, { method: 'POST', cookie: bidder.cookie, body }), ctx(showId))).json() as { message: { id: string } };
    await resetLimits();
    const b = await (await r.post(req(`/api/shows/${showId}/chat`, { method: 'POST', cookie: bidder.cookie, body }), ctx(showId))).json() as { message: { id: string } };
    expect(b.message.id).toBe(a.message.id);
    expect((await q(`select count(*)::int n from chat_messages where show_id=$1`, [showId])).rows[0].n).toBe(1);
  });

  it_('twenty parallel posts with one nonce: still one row', async () => {
    const { bidder, showId } = await room();
    const body = { body: 'racing', clientNonce: randomUUID() };
    const out = await Promise.all(Array.from({ length: 20 }, () => svc.postMessage({ showId, actor: { profileId: bidder.id, wallet: bidder.wallet }, ...body })));
    expect(new Set(out.map((m) => m.id)).size).toBe(1);
    expect((await q(`select count(*)::int n from chat_messages where show_id=$1`, [showId])).rows[0].n).toBe(1);
  });
});

describe('writing: who may and what may not', () => {
  it_('signed out is 401, no paddle is no_paddle, a revoked or expired paddle too', async () => {
    const { op, showId } = await room();
    expect((await r.post(req(`/api/shows/${showId}/chat`, { method: 'POST', body: { body: 'hi', clientNonce: randomUUID() } }), ctx(showId))).status).toBe(401);
    const nobody = await person();
    const res = await say(showId, nobody, 'hello there');
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe('no_paddle');
    const revoked = await person();
    await paddle(showId, revoked, { revoked: true });
    expect((await errOf(await say(showId, revoked, 'hello there'))).code).toBe('no_paddle');
    const expired = await person();
    await paddle(showId, expired, { hours: -1 });
    expect((await errOf(await say(showId, expired, 'hello there'))).code).toBe('no_paddle');
    void op;
  });

  it_('a bot or a banned profile cannot write', async () => {
    const { op, showId } = await room();
    const bot = await person({ bot: true });
    await paddle(showId, bot);
    const res = await say(showId, bot, 'beep boop');
    expect(res.status).toBe(403);
    expect((await errOf(res)).code).toBe('forbidden');
    const banned = await person({ banned: true });
    await paddle(showId, banned);
    expect((await errOf(await say(showId, banned, 'hello'))).code).toBe('banned');
    void op;
  });

  it_('links, contact data, wallet addresses, shouting and over-long text are refused with the reason', async () => {
    const { bidder, showId } = await room();
    const cases: [string, string][] = [
      ['see https://evil.example', 'link'],
      ['write me a@b.example', 'contact_data'],
      [`send to ${wallet()}`, 'contact_data'],
      ['AMAZING DEAL FOR YOU', 'shouting'],
    ];
    for (const [text, reason] of cases) {
      await resetLimits();
      const res = await say(showId, bidder, text);
      expect(res.status).toBe(400);
      const body = await errOf(res);
      expect(body.code).toBe('validation');
      expect(body.reason).toBe(reason); // the key the client translates (extra.reason replaces the text in the body)
      expect((await q(`select count(*)::int n from chat_messages where show_id=$1`, [showId])).rows[0].n).toBe(0);
    }
    await resetLimits();
    expect((await say(showId, bidder, 'x'.repeat(201))).status).toBe(400); // the contract refuses it before the rules do
  });

  it_('the service refusal carries the English text and extra.reason for the caller', async () => {
    const { bidder, showId } = await room();
    const direct = svc.postMessage({ showId, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'go to scam.com', clientNonce: randomUUID() });
    await expect(direct).rejects.toMatchObject({ code: 'validation', message: 'Links are not allowed in the chat', extra: { reason: 'link' } });
  });

  it_('the same text twice inside 30 s is a duplicate; a different one is fine', async () => {
    const { bidder, showId } = await room();
    const actor = { profileId: bidder.id, wallet: bidder.wallet };
    await svc.postMessage({ showId, actor, body: 'Nice card!', clientNonce: randomUUID() });
    await expect(svc.postMessage({ showId, actor, body: 'nice  card', clientNonce: randomUUID() })).rejects.toMatchObject({ code: 'validation', extra: { reason: 'duplicate' } });
    await expect(svc.postMessage({ showId, actor, body: 'Nice card, again', clientNonce: randomUUID() })).resolves.toMatchObject({ status: 'pending' });
    // a minute later the same text is allowed again
    await expect(svc.postMessage({ showId, actor, body: 'Nice card!', clientNonce: randomUUID() }, new Date(Date.now() + 60_000))).resolves.toMatchObject({ status: 'pending' });
  });

  it_('rate limits: one per 3 s per wallet over the route, five waiting at most per author', async () => {
    const { bidder, showId } = await room();
    expect((await say(showId, bidder, 'first one')).status).toBe(201);
    const fast = await say(showId, bidder, 'second one');
    expect(fast.status).toBe(429);
    expect(Number(fast.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const actor = { profileId: bidder.id, wallet: bidder.wallet };
    for (let i = 2; i <= svc.MAX_PENDING_PER_AUTHOR; i++) await svc.postMessage({ showId, actor, body: `waiting ${i}`, clientNonce: randomUUID() });
    await expect(svc.postMessage({ showId, actor, body: 'one too many', clientNonce: randomUUID() })).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it_('twelve a minute per wallet', async () => {
    const { bidder, showId } = await room();
    await q(`insert into rate_limits (key, window_start, count) values ($1, to_timestamp(floor(extract(epoch from now()) / 60) * 60), 12)`, [`w:chat-min:${bidder.wallet}`]);
    expect((await say(showId, bidder, 'too many this minute')).status).toBe(429);
  });

  it_('forty a minute per address', async () => {
    const { bidder, showId } = await room();
    const ipAddr = '10.99.99.99';
    await q(`insert into rate_limits (key, window_start, count) values ($1, to_timestamp(floor(extract(epoch from now()) / 60) * 60), 40)`, [`ip:chat:${ipAddr}`]);
    const res = await r.post(req(`/api/shows/${showId}/chat`, { method: 'POST', cookie: bidder.cookie, body: { body: 'from a busy address', clientNonce: randomUUID() } }), ctx(showId));
    void res; // the helper picks its own address; send with the busy one instead
    const busy = new Request(`${ORIGIN}/api/shows/${showId}/chat`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: bidder.cookie, 'x-forwarded-for': ipAddr }, body: JSON.stringify({ body: 'second from a busy address', clientNonce: randomUUID() }) });
    expect((await r.post(busy, ctx(showId))).status).toBe(429);
  });

  it_('the show must still be open: ended more than 10 minutes ago and cancelled shows refuse', async () => {
    const { op, bidder } = await room();
    const ended = await show(op, { status: 'ended', endedAt: new Date(Date.now() - 11 * 60_000) });
    await paddle(ended, bidder);
    const res = await say(ended, bidder, 'anyone here?');
    expect(res.status).toBe(409);
    expect((await errOf(res)).code).toBe('show_ended');
    const recent = await show(op, { status: 'ended', endedAt: new Date(Date.now() - 2 * 60_000) });
    await paddle(recent, bidder);
    await resetLimits();
    expect((await say(recent, bidder, 'thanks all')).status).toBe(201);
    const cancelled = await show(op, { status: 'scheduled', cancelledAt: new Date() });
    await paddle(cancelled, bidder);
    await resetLimits();
    expect((await errOf(await say(cancelled, bidder, 'hello'))).code).toBe('show_ended');
  });

  it_('a lot number that does not exist is refused', async () => {
    const { bidder, showId } = await room();
    expect((await say(showId, bidder, 'about lot nine', { lotNumber: 9 })).status).toBe(400);
  });
});

describe('moderation: mute, block, operator only', () => {
  it_('mute stops posting until it ends; unsilence lifts it; the queue lists who is silenced', async () => {
    const { op, bidder, showId, number } = await room();
    const res = await act(showId, op, { action: 'mute', paddle: number, minutes: 30, reason: 'Repeated spam in the chat.' });
    expect(res.status).toBe(200);
    const denied = await say(showId, bidder, 'let me in');
    expect(denied.status).toBe(403);
    const body = await errOf(denied);
    expect(body.code).toBe('muted');
    expect(typeof (body as Record<string, unknown>).until).toBe('string');
    const queue = await queueOf(showId, op);
    expect(queue.silenced).toEqual([expect.objectContaining({ paddle: number, wallet: bidder.wallet, kind: 'mute', reason: 'Repeated spam in the chat.' })]);
    // the mute ends by itself
    await expect(svc.postMessage({ showId, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'back again', clientNonce: randomUUID() }, new Date(Date.now() + 31 * 60_000))).resolves.toBeTruthy();
    await resetLimits();
    await act(showId, op, { action: 'unsilence', paddle: number });
    expect((await say(showId, bidder, 'I am back')).status).toBe(201);
    expect((await queueOf(showId, op)).silenced).toEqual([]);
  });

  it_('block is for the whole show, and it rejects what the wallet still had waiting', async () => {
    const { op, bidder, showId, number } = await room();
    const actor = { profileId: bidder.id, wallet: bidder.wallet };
    await svc.postMessage({ showId, actor, body: 'waiting one', clientNonce: randomUUID() });
    await svc.postMessage({ showId, actor, body: 'waiting two', clientNonce: randomUUID() });
    await act(showId, op, { action: 'block', paddle: number, reason: 'Harassing other bidders.' });
    expect((await mineOf(showId, bidder)).messages.map((m) => [m.status, m.reason])).toEqual([['rejected', 'Harassing other bidders.'], ['rejected', 'Harassing other bidders.']]);
    await expect(svc.postMessage({ showId, actor, body: 'still here', clientNonce: randomUUID() }, new Date(Date.now() + 3 * 3_600_000))).rejects.toMatchObject({ code: 'muted' });
    expect((await queueOf(showId, op)).silenced[0]).toMatchObject({ kind: 'block', until: null });
  });

  it_('only the operator moderates: a bidder and a stranger get not_seller on every operator route', async () => {
    const { bidder, showId, number } = await room();
    const stranger = await person();
    for (const p of [bidder, stranger]) {
      const q1 = await r.queue(req(`/api/shows/${showId}/chat/queue`, { cookie: p.cookie }), ctx(showId));
      expect(q1.status).toBe(403);
      expect((await errOf(q1)).code).toBe('not_seller');
      for (const body of [
        { action: 'approve', messageIds: [randomUUID()] },
        { action: 'mute', paddle: number, minutes: 5, reason: 'because' },
        { action: 'publish', body: 'I am the operator', clientNonce: randomUUID() },
      ]) {
        const res = await act(showId, p, body);
        expect(res.status).toBe(403);
        expect((await errOf(res)).code).toBe('not_seller');
      }
    }
    expect((await q(`select count(*)::int n from chat_messages where show_id=$1`, [showId])).rows[0].n).toBe(0);
  });

  it_('the operator cannot silence the operator, and an unknown bidder number is not_found', async () => {
    const { op, showId } = await room();
    await paddle(showId, op);
    const opNumber = (await q(`select number from paddles where show_id=$1 and profile_id=$2`, [showId, op.id])).rows[0].number;
    expect((await act(showId, op, { action: 'mute', paddle: opNumber, minutes: 5, reason: 'oops' })).status).toBe(400);
    expect((await act(showId, op, { action: 'mute', paddle: 9999, minutes: 5, reason: 'nobody' })).status).toBe(404);
  });

  it_('every operator action is in audit_logs', async () => {
    const { op, bidder, showId, number } = await room();
    const { message } = await (await say(showId, bidder, 'audit me please')).json() as { message: { id: string } };
    await act(showId, op, { action: 'approve', messageIds: [message.id] });
    await act(showId, op, { action: 'mute', paddle: number, minutes: 5, reason: 'for the log' });
    await act(showId, op, { action: 'unsilence', paddle: number });
    const { rows } = await q(`select action from audit_logs where target=$1 and actor_wallet=$2 `, [showId, op.wallet]);
    expect(rows.map((x) => x.action).sort()).toEqual(['chat.approve', 'chat.mute', 'chat.unsilence']);
  });

  it_('the house show: the operator list moderates, its posts carry the role house', async () => {
    const houseSeller = await person();
    const opWallet = wallet();
    vi.stubEnv('OPERATOR_WALLETS', opWallet);
    try {
      const operator = await person({ wallet: opWallet });
      const bidder = await person();
      const showId = await show(houseSeller, { isHouse: true });
      await paddle(showId, bidder);
      const { message } = await (await say(showId, bidder, 'hello house')).json() as { message: { id: string } };
      expect((await queueOf(showId, operator)).messages).toHaveLength(1);
      expect((await act(showId, operator, { action: 'approve', messageIds: [message.id] })).status).toBe(200);
      expect((await say(showId, operator, 'Welcome to the house room.')).status).toBe(201);
      expect((await publicList(showId)).messages.map((m) => m.role)).toEqual(['bidder', 'house']);
      expect((await mineOf(showId, operator)).operator).toBe(true);
      // a wallet that is not on the list is no operator, even with a profile
      const nobody = await person();
      expect((await r.queue(req(`/api/shows/${showId}/chat/queue`, { cookie: nobody.cookie }), ctx(showId))).status).toBe(403);
    } finally { vi.stubEnv('OPERATOR_WALLETS', ''); }
  });
});

describe('reporting', () => {
  it_('a public message can be reported once per reporter; the operator sees the count; nothing is removed by itself', async () => {
    const { op, bidder, showId } = await room();
    const viewer = await person();
    const { message } = await (await say(showId, bidder, 'a message')).json() as { message: { id: string } };
    const report = (p: Person, id: string, body: unknown = { reason: 'spam', detail: 'again and again' }) =>
      r.report(req(`/api/chat/${id}/report`, { method: 'POST', cookie: p.cookie, body }), ctx(id));
    // a pending message is not public: it cannot be reported
    expect((await report(viewer, message.id)).status).toBe(404);
    await act(showId, op, { action: 'approve', messageIds: [message.id] });
    expect((await report(viewer, message.id)).status).toBe(201);
    expect((await report(viewer, message.id)).status).toBe(201); // idempotent
    const other = await person();
    expect((await report(other, message.id, { reason: 'scam' })).status).toBe(201);
    expect((await q(`select count(*)::int n from chat_reports where message_id=$1`, [message.id])).rows[0].n).toBe(2);
    expect((await publicList(showId)).messages).toHaveLength(1);
    const reported = await queueOf(showId, op, 'reported');
    expect(reported.counts.reported).toBe(1);
    expect(reported.messages[0]).toMatchObject({ id: message.id, reports: 2 });
    expect(reported.messages[0].reportDetails).toEqual(expect.arrayContaining([{ reason: 'spam', detail: 'again and again' }, { reason: 'scam', detail: null }]));
    // rejecting it settles the reports
    await act(showId, op, { action: 'reject', messageIds: [message.id], reason: 'Reported and confirmed.' });
    expect((await q(`select status from chat_reports where message_id=$1`, [message.id])).rows.map((x) => x.status)).toEqual(['actioned', 'actioned']);
    expect((await queueOf(showId, op, 'reported')).messages).toEqual([]);
    expect((await report(viewer, randomUUID())).status).toBe(404);
    expect((await r.report(req(`/api/chat/${message.id}/report`, { method: 'POST', body: { reason: 'spam' } }), ctx(message.id))).status).toBe(401);
    expect((await report(viewer, message.id, { reason: 'because' })).status).toBe(400);
  });

  it_('five reports an hour per wallet', async () => {
    const { op, bidder, showId } = await room();
    const viewer = await person();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const m = await svc.postMessage({ showId, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: `message number ${String.fromCharCode(97 + i)}`, clientNonce: randomUUID() });
      ids.push(m.id);
      if (i % 4 === 3) await act(showId, op, { action: 'approve', messageIds: ids });
    }
    await act(showId, op, { action: 'approve', messageIds: ids });
    const statuses: number[] = [];
    for (const id of ids) statuses.push((await r.report(req(`/api/chat/${id}/report`, { method: 'POST', cookie: viewer.cookie, body: { reason: 'spam' } }), ctx(id))).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe('the assistant interface (publishAssistantAnswer)', () => {
  it_('the operator publishes an assistant answer: approved at once, source assistant, through the same rules', async () => {
    const { op, bidder, showId } = await room();
    const actor = { profileId: op.id, wallet: op.wallet };
    const m = await svc.publishAssistantAnswer({ showId, actor, body: 'The card ships with the transfer.', lotNumber: 1 });
    expect(m).toMatchObject({ status: 'approved', lotNumber: 1 });
    expect((await publicList(showId)).messages[0]).toMatchObject({ source: 'assistant', role: 'seller', paddle: null, lotNumber: 1, body: 'The card ships with the transfer.' });
    await expect(svc.publishAssistantAnswer({ showId, actor, body: 'read https://example.com/faq' })).rejects.toMatchObject({ code: 'validation', extra: { reason: 'link' } });
    await expect(svc.publishAssistantAnswer({ showId, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'Fake answer.' })).rejects.toMatchObject({ code: 'not_seller' });
    const nonce = randomUUID();
    const a = await svc.publishAssistantAnswer({ showId, actor, body: 'Once.', clientNonce: nonce });
    const b = await svc.publishAssistantAnswer({ showId, actor, body: 'Once.', clientNonce: nonce });
    expect(b.id).toBe(a.id);
  });

  it_('over HTTP the operator can publish with source assistant, a bidder cannot even try the source', async () => {
    const { op, bidder, showId } = await room();
    const res = await act(showId, op, { action: 'publish', body: 'Answer from the assistant.', source: 'assistant', clientNonce: randomUUID() });
    expect(res.status).toBe(200);
    expect((await publicList(showId)).messages[0]).toMatchObject({ source: 'assistant' });
    // a bidder's ordinary POST has no source field at all (the contract is strict), so it can never claim to be the assistant
    const forged = await r.post(req(`/api/shows/${showId}/chat`, { method: 'POST', cookie: bidder.cookie, body: { body: 'hi', clientNonce: randomUUID(), source: 'assistant' } }), ctx(showId));
    expect(forged.status).toBe(400);
    await expect(svc.postMessage({ showId, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'hi', clientNonce: randomUUID(), source: 'assistant' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it_('publishAssistantAnswer is feature_off when the chat is off', async () => {
    const { op, showId } = await room();
    vi.stubEnv('FEATURE_CHAT', 'false');
    flags.clearFlagMemo();
    try { await expect(svc.publishAssistantAnswer({ showId, actor: { profileId: op.id, wallet: op.wallet }, body: 'Hello' })).rejects.toMatchObject({ code: 'feature_off' }); }
    finally { vi.stubEnv('FEATURE_CHAT', 'true'); flags.clearFlagMemo(); }
  });
});

describe('privacy of the public answer', () => {
  it_('no wallet, no author id, no 32 to 44 character base58 string appears in the public list, for any mix of messages', async () => {
    const { op, bidder, showId } = await room();
    const other = await person();
    await paddle(showId, other);
    const actors = [bidder, other];
    const texts = ['hello', 'nice', 'lot 3?', 'wow', 'danke', 'ok'];
    const ids: string[] = [];
    for (const [i, text] of texts.entries()) {
      const p = actors[i % 2];
      ids.push((await svc.postMessage({ showId, actor: { profileId: p.id, wallet: p.wallet }, body: text, clientNonce: randomUUID() })).id);
    }
    await svc.publishAssistantAnswer({ showId, actor: { profileId: op.id, wallet: op.wallet }, body: 'Fixed answer.' });
    await act(showId, op, { action: 'approve', messageIds: ids });
    const res = await r.list(req(`/api/shows/${showId}/chat`), ctx(showId));
    const text = await res.text();
    expect(JSON.parse(text).messages).toHaveLength(texts.length + 1);
    for (const p of [bidder, other, op]) {
      expect(text).not.toContain(p.wallet);
      expect(text).not.toContain(p.id);
    }
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
    expect(text).not.toMatch(/author/i);
    expect(res.headers.get('vercel-cdn-cache-control')).toBe('max-age=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it_('only the last 50 approved messages are listed', async () => {
    const { op, bidder, showId } = await room();
    const actor = { profileId: bidder.id, wallet: bidder.wallet };
    const ids: string[] = [];
    for (let i = 0; i < 53; i++) {
      ids.push((await svc.postMessage({ showId, actor, body: `message ${i} ${'ab'.repeat(2)}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, clientNonce: randomUUID() })).id);
      if (ids.length % 5 === 0 || i === 52) await q(`update chat_messages set status='approved', moderated_at=now() where id = any($1::uuid[])`, [ids.splice(0)]);
    }
    const list = await publicList(showId);
    expect(list.messages).toHaveLength(50);
    expect(list.messages[0].body.startsWith('message 3 ')).toBe(true);
    void op;
  });
});

describe('load: one query per interval however many viewers', () => {
  it_('ten parallel viewers share one load', async () => {
    const { showId } = await room();
    const memo = await import('../memo');
    memo.chatListMemo.setTtlMs(1000);
    const pool = (globalThis as { __pool?: { query: (...a: unknown[]) => unknown } }).__pool!;
    const original = pool.query.bind(pool);
    let listQueries = 0;
    pool.query = (...a: unknown[]) => {
      const first = a[0] as string | { text?: string };
      if ((typeof first === 'string' ? first : first?.text ?? '').includes('from "chat_messages"')) listQueries++;
      return original(...a);
    };
    try {
      await q(`delete from rate_limits`);
      const out = await Promise.all(Array.from({ length: 10 }, () => r.list(req(`/api/shows/${showId}/chat`), ctx(showId))));
      expect(out.map((x) => x.status)).toEqual(Array(10).fill(200));
    } finally { pool.query = original; memo.chatListMemo.setTtlMs(0); }
    expect(listQueries).toBe(1); // ten viewers, one read of the messages
  });
});

describe('retention', () => {
  it_('messages go 30 days after the show ended (reports with them), a stale open show after 90 days, old reports after 6 months', async () => {
    const op = await person();
    const bidder = await person();
    const day = 86_400_000;
    const mk = async (s: { status: string; endedAt?: Date | null; cancelledAt?: Date | null }, createdAt: Date) => {
      const showId = await show(op, { status: s.status, endedAt: s.endedAt ?? null, cancelledAt: s.cancelledAt ?? null, lots: 1 });
      const { rows } = await q(`insert into chat_messages (show_id, author_id, body, status, created_at) values ($1,$2,'x y z','approved',$3) returning id`, [showId, bidder.id, createdAt]);
      return { showId, id: rows[0].id as string };
    };
    const now = new Date();
    const oldEnded = await mk({ status: 'ended', endedAt: new Date(now.getTime() - 31 * day) }, new Date(now.getTime() - 32 * day));
    const freshEnded = await mk({ status: 'ended', endedAt: new Date(now.getTime() - 5 * day) }, new Date(now.getTime() - 6 * day));
    const oldCancelled = await mk({ status: 'scheduled', cancelledAt: new Date(now.getTime() - 40 * day) }, new Date(now.getTime() - 41 * day));
    const live = await mk({ status: 'live' }, new Date(now.getTime() - 2 * day));
    const staleLive = await mk({ status: 'live' }, new Date(now.getTime() - 91 * day));
    await q(`insert into chat_reports (message_id, reporter_id, reason) values ($1,$2,'spam')`, [oldEnded.id, bidder.id]);
    await q(`insert into chat_reports (message_id, reporter_id, reason, created_at) values ($1,$2,'spam',$3)`, [live.id, bidder.id, new Date(now.getTime() - 200 * day)]);
    await q(`insert into chat_reports (message_id, reporter_id, reason, created_at) values ($1,$2,'spam',$3)`, [freshEnded.id, bidder.id, new Date(now.getTime() - 2 * day)]);

    await q(`insert into chat_mutes (show_id, profile_id, kind, reason, by) values ($1,$2,'block','x',$3)`, [oldEnded.showId, bidder.id, op.id]); // goes with its old show
    await q(`insert into chat_mutes (show_id, profile_id, kind, until, reason, by) values ($1,$2,'mute',$3,'x',$4)`, [live.showId, bidder.id, new Date(now.getTime() - day), op.id]); // expired
    await q(`insert into chat_mutes (show_id, profile_id, kind, reason, by) values ($1,$2,'block','x',$3)`, [freshEnded.showId, bidder.id, op.id]); // kept

    const removed = await purge.purgeChat(now);
    const alive = (await q(`select id from chat_messages where id = any($1::uuid[])`, [[oldEnded.id, freshEnded.id, oldCancelled.id, live.id, staleLive.id]])).rows.map((x) => x.id);
    expect(alive.sort()).toEqual([freshEnded.id, live.id].sort());
    expect((await q(`select count(*)::int n from chat_reports where message_id = any($1::uuid[])`, [[oldEnded.id, live.id, freshEnded.id]])).rows[0].n).toBe(1); // only the fresh one is left
    expect((await q(`select show_id from chat_mutes where profile_id=$1`, [bidder.id])).rows.map((x) => x.show_id)).toEqual([freshEnded.showId]);
    expect(removed).toBe(3 + 1 + 2); // three messages (old ended, old cancelled, stale open), one old report, two mutes
    expect(await purge.purgeChat(now)).toBe(0); // nothing more to do
  });
});

describe('the operator queue', () => {
  it_('filters, counts and the afterSeq cursor', async () => {
    const { op, bidder, showId } = await room();
    const actor = { profileId: bidder.id, wallet: bidder.wallet };
    const a = await svc.postMessage({ showId, actor, body: 'first one', clientNonce: randomUUID() });
    const b = await svc.postMessage({ showId, actor, body: 'second one', clientNonce: randomUUID() });
    await act(showId, op, { action: 'approve', messageIds: [a.id] });
    const pending = await queueOf(showId, op, 'pending');
    expect(pending.messages.map((m) => m.id)).toEqual([b.id]);
    expect(pending.counts).toEqual({ pending: 1, approved: 1, rejected: 0, reported: 0 });
    expect((await queueOf(showId, op, 'all')).messages.map((m) => m.body)).toEqual(['first one', 'second one']);
    const after = ChatQueueResponse.parse(await (await r.queue(req(`/api/shows/${showId}/chat/queue?filter=all&afterSeq=${a.seq}`, { cookie: op.cookie }), ctx(showId))).json());
    expect(after.messages.map((m) => m.id)).toEqual([b.id]);
    expect(after.lastSeq).toBe(b.seq);
    // an unknown filter or key is refused
    expect((await r.queue(req(`/api/shows/${showId}/chat/queue?filter=everything`, { cookie: op.cookie }), ctx(showId))).status).toBe(400);
  });
});

describe('display names in the chat', () => {
  it_('a message carries the author\'s display name when they set one, and null when they did not; the operator sees the same name', async () => {
    const { op, bidder, showId, number } = await room();
    const quiet = await person();
    const quietNumber = await paddle(showId, quiet);
    await q(`update profiles set display_name='Anna' where id=$1`, [bidder.id]);
    const a = ((await (await say(showId, bidder, 'Hello from Anna')).json()) as { message: { id: string } }).message.id;
    await resetLimits();
    const b = ((await (await say(showId, quiet, 'Hello from nobody')).json()) as { message: { id: string } }).message.id;
    await act(showId, op, { action: 'approve', messageIds: [a, b] });
    const list = await publicList(showId);
    expect(list.messages.find((m) => m.id === a)).toMatchObject({ name: 'Anna', paddle: number });
    expect(list.messages.find((m) => m.id === b)).toMatchObject({ name: null, paddle: quietNumber });
    expect(JSON.stringify(list)).not.toContain(bidder.wallet);
    const queue = await queueOf(showId, op, 'approved');
    expect(queue.messages.find((m) => m.id === a)).toMatchObject({ name: 'Anna', wallet: bidder.wallet });
    expect(queue.messages.find((m) => m.id === b)).toMatchObject({ name: null });
  });

  it_('a changed or cleared name shows on the next read (the name is read live, it is never copied into the message)', async () => {
    const { op, bidder, showId } = await room();
    await q(`update profiles set display_name='Old Name' where id=$1`, [bidder.id]);
    const id = ((await (await say(showId, bidder, 'A message')).json()) as { message: { id: string } }).message.id;
    await act(showId, op, { action: 'approve', messageIds: [id] });
    expect((await publicList(showId)).messages[0].name).toBe('Old Name');
    await q(`update profiles set display_name='New Name' where id=$1`, [bidder.id]);
    expect((await publicList(showId)).messages[0].name).toBe('New Name');
    await q(`update profiles set display_name=null where id=$1`, [bidder.id]);
    expect((await publicList(showId)).messages[0].name).toBeNull();
  });

  it_('the house speaks as the house, never under a personal name', async () => {
    const { op, showId } = await room({ isHouse: true });
    await q(`update profiles set display_name='Some Operator' where id=$1`, [op.id]);
    await q(`insert into chat_messages (show_id, author_id, role, source, body, status, moderated_at) values ($1,$2,'house','user','Welcome to the house room','approved', now())`, [showId, op.id]);
    expect((await publicList(showId)).messages[0]).toMatchObject({ role: 'house', name: null });
  });
});
