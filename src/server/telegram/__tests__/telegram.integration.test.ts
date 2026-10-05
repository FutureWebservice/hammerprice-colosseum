/**
 * Telegram against a REAL Postgres 18 (embedded-postgres, every migration including 0004) with the real auction, chat and settlement rows, the real
 * route handlers and real signed session cookies. Only the Telegram Bot API is faked: `fetch` is replaced by a recorder that answers like Telegram
 * does (and can answer 403 or 429). No token is real, nothing leaves the process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TELEGRAM_PREFS, ErrorResponseSchema, TelegramLinkResponse, TelegramStatusResponse } from '@/contracts';
import { startEnv, USDC, type Env } from '@/server/auction/__tests__/harness';
import { signCallback } from '../callback';

const TOKEN = '123456789:AAE_fake_token_value_0123456789abcdefghij';
const SECRET = 'integration-secret-webhook-0123456789';
const HOST = 'localhost:3000';
const ORIGIN = `http://${HOST}`;

let env: Env | undefined;
let skipReason: string | undefined;
let sess: typeof import('@/lib/auth/session');
let flags: typeof import('@/app/api/auctions/_shared/flags');
let link: typeof import('@/app/api/telegram/link/route');
let hook: typeof import('@/app/api/telegram/webhook/route');
let links: typeof import('../links');
let notify: typeof import('../notify');
let hooks: typeof import('../hooks');
let sweep: typeof import('../sweep');
let chat: typeof import('@/server/chat/service');

// ---- the fake Telegram ------------------------------------------------------------------------
interface Call { method: string; body: Record<string, any>; url: string } // eslint-disable-line @typescript-eslint/no-explicit-any
let calls: Call[] = [];
let failFor = new Map<number, { status: number; description: string; retry?: number }>();
let messageId = 100;
const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const u = String(url);
  const m = /\/bot[^/]+\/(\w+)$/.exec(u);
  if (!m) throw new Error(`unexpected fetch ${u}`);
  const body = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ method: m[1], body, url: u });
  const f = failFor.get(body.chat_id);
  if (f) return new Response(JSON.stringify({ ok: false, error_code: f.status, description: f.description, ...(f.retry ? { parameters: { retry_after: f.retry } } : {}) }), { status: f.status });
  return new Response(JSON.stringify({ ok: true, result: m[1] === 'sendMessage' ? { message_id: ++messageId } : true }));
};
const sentTo = (chatId: number) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chatId).map((c) => c.body.text as string);
const edits = () => calls.filter((c) => c.method === 'editMessageText');
const answers = () => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text as string);

beforeAll(async () => {
  const r = await startEnv();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  env = r.env;
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('FEATURE_TELEGRAM', 'true');
  vi.stubEnv('FEATURE_CHAT', 'true');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN);
  vi.stubEnv('TELEGRAM_BOT_USERNAME', 'HammerpriceTestBot');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET);
  vi.stubGlobal('fetch', fakeFetch);
  sess = await import('@/lib/auth/session');
  flags = await import('@/app/api/auctions/_shared/flags');
  link = await import('@/app/api/telegram/link/route');
  hook = await import('@/app/api/telegram/webhook/route');
  links = await import('../links');
  notify = await import('../notify');
  hooks = await import('../hooks');
  sweep = await import('../sweep');
  chat = await import('@/server/chat/service');
}, 180_000);
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await env?.stop(); });
beforeEach(async () => {
  calls = []; failFor = new Map(); flags?.clearFlagMemo();
  if (env) await env.pool.query('delete from rate_limits');
});
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01'); vi.stubEnv('SOLANA_CLUSTER', 'devnet'); vi.stubEnv('FEATURE_TELEGRAM', 'true'); vi.stubEnv('FEATURE_CHAT', 'true'); vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN); vi.stubEnv('TELEGRAM_BOT_USERNAME', 'HammerpriceTestBot'); vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', SECRET); flags?.clearFlagMemo(); });

const it_ = (name: string, fn: (e: Env) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!env) return ctx.skip(skipReason); await fn(env); }, timeout);

// ---- arrangement ------------------------------------------------------------------------------
interface Person { id: string; wallet: string; cookie: string }
const person = async (e: Env): Promise<Person> => {
  const p = await e.profile();
  return { ...p, cookie: `hp_session=${await sess.signSession({ wallet: p.wallet, profileId: p.id })}` };
};
let ip = 0;
const req = (path: string, init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': `10.9.${(ip >> 8) & 255}.${ip++ & 255}`, ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', p: Person, body?: unknown) => link[method](req('/api/telegram/link', { method, cookie: p.cookie, body }));
const webhook = (update: unknown, secret: string | null = SECRET) =>
  hook.POST(req('/api/telegram/webhook', { method: 'POST', body: update, headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret } }));
let chatSeq = 5_000_000;
const newChat = () => ++chatSeq;
const text = (chatId: number, t: string, lang = 'en') => ({ update_id: ++messageId, message: { message_id: ++messageId, text: t, chat: { id: chatId, type: 'private' }, from: { id: chatId, language_code: lang } } });
const press = (chatId: number, data: string, lang = 'en') => ({ update_id: ++messageId, callback_query: { id: `cb${++messageId}`, from: { id: chatId, language_code: lang }, data, message: { message_id: 77, text: 'x', chat: { id: chatId, type: 'private' } } } });

const ALL_OFF = { outbid: false, ending_soon: false, won: false, settled: false, show_start: false, deadline: false, moderation: false, pack_delivery: false, lot_watch: false };
/** A linked chat for a profile, straight in the table (the link flow itself has its own tests). */
async function linked(e: Env, p: { id: string }, over: { prefs?: Partial<typeof ALL_OFF>; locale?: 'en' | 'de'; linkedAt?: Date; chatId?: number } = {}): Promise<number> {
  const chatId = over.chatId ?? newChat();
  const prefs = { ...ALL_OFF, outbid: true, won: true, settled: true, deadline: true, ending_soon: true, show_start: true, moderation: true, ...(over.prefs ?? {}) };
  await e.pool.query(`insert into telegram_links (profile_id, chat_id, locale, prefs, linked_at) values ($1,$2,$3,$4::jsonb,$5)`, [p.id, chatId, over.locale ?? 'en', JSON.stringify(prefs), over.linkedAt ?? new Date(Date.now() - 3_600_000)]);
  return chatId;
}
// Relative to the real clock: the hooks read new Date(), so a fixed calendar date would rot.
const T0 = new Date(Date.now() + 3_600_000);
const at = (ms: number) => new Date(T0.getTime() + ms);

/** A live show with one open lot (closes in 10 s), a seller, and two bidders with paddles. */
async function room(e: Env, over: { lotOpts?: object } = {}) {
  const seller = await e.profile();
  const a = await e.profile(); const b = await e.profile();
  const s = await e.show({ sellerId: seller.id, status: 'live', rules: { lotDurationS: 20, gapS: 6, snipeWindowS: 5, snipeExtendS: 5 }, lots: [{ state: 'open', openedAt: at(0), closesAt: at(20_000), reserve: null, opening: 50n * USDC, increment: 5n * USDC, ...(over.lotOpts ?? {}) }, {}] });
  await e.paddle(s.id, a.id, { hours: 100 }); await e.paddle(s.id, b.id, { hours: 100 });
  return { seller, a, b, show: s, lot: s.lots[0] };
}

// ---- the tests --------------------------------------------------------------------------------

describe('migration 0004', () => {
  it_('creates the three tables, and the schema and the database agree on their columns', async (e) => {
    const cols = async (t: string) => (await e.pool.query(`select column_name from information_schema.columns where table_name=$1 order by column_name`, [t])).rows.map((r) => r.column_name);
    expect(await cols('telegram_links')).toEqual(['chat_id', 'linked_at', 'locale', 'prefs', 'profile_id']);
    expect(await cols('telegram_link_tokens')).toEqual(['created_at', 'expires_at', 'locale', 'prefs', 'profile_id', 'token_hash', 'used_at']);
    expect(await cols('telegram_sent')).toEqual(['kind', 'profile_id', 'ref', 'sent_at']);
    const schema = await import('@/db/schema');
    const { getTableColumns } = await import('drizzle-orm');
    for (const [name, table] of [['telegram_links', schema.telegramLinks], ['telegram_link_tokens', schema.telegramLinkTokens], ['telegram_sent', schema.telegramSent]] as const) {
      expect(Object.values(getTableColumns(table)).map((c) => c.name).sort(), name).toEqual(await cols(name));
    }
  });
  it_('applying 0004 a second time changes nothing and does not fail (idempotent)', async (e) => {
    const { MIGRATIONS_DIR, runSqlFile } = await import('@/db/__tests__/pg-harness');
    await runSqlFile(e.pool, `${MIGRATIONS_DIR}/0004_telegram.sql`);
  });
});

describe('the link flow', () => {
  it_('POST makes a one-time deep link; only the hash is stored; it lives 10 minutes and is bound to the session wallet', async (e) => {
    const p = await person(e);
    const res = await call('POST', p, { locale: 'de', prefs: { show_start: true } });
    expect(res.status).toBe(200);
    const body = TelegramLinkResponse.parse(await res.json());
    const m = /^https:\/\/t\.me\/HammerpriceTestBot\?start=([A-Za-z0-9_-]{32})$/.exec(body.url);
    expect(m, body.url).toBeTruthy();
    const token = m![1];
    const { rows } = await e.pool.query(`select * from telegram_link_tokens where profile_id=$1`, [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(links.hashToken(token));
    expect(JSON.stringify(rows[0])).not.toContain(token); // the token itself is nowhere in the row
    expect(rows[0].locale).toBe('de');
    expect(rows[0].prefs).toMatchObject({ outbid: true, won: true, show_start: true, moderation: false, ending_soon: false });
    expect(new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime()).toBe(10 * 60_000);
    expect(Date.parse(body.expiresAt)).toBe(new Date(rows[0].expires_at).getTime());
  });

  it_('/start <token> in the webhook binds the chat to that wallet, answers in the chosen language, and the token works once', async (e) => {
    const p = await person(e);
    const body = TelegramLinkResponse.parse(await (await call('POST', p, { locale: 'de' })).json());
    const token = new URL(body.url).searchParams.get('start')!;
    const chatId = newChat();
    const res = await webhook(text(chatId, `/start ${token}`, 'en'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = (await e.pool.query(`select * from telegram_links where profile_id=$1`, [p.id])).rows[0];
    expect(Number(row.chat_id)).toBe(chatId);
    expect(row.locale).toBe('de');
    expect(sentTo(chatId)[0]).toMatch(/^Verbunden\./);
    expect((await e.pool.query(`select count(*)::int n from telegram_link_tokens where profile_id=$1`, [p.id])).rows[0].n).toBe(0);

    // The same link again (a second tap, a replay) is refused, and nothing changes.
    calls = [];
    await webhook(text(newChat(), `/start ${token}`, 'en'));
    expect(sentTo(chatSeq)[0]).toMatch(/ran out or was already used/);
    expect((await e.pool.query(`select chat_id from telegram_links where profile_id=$1`, [p.id])).rows[0].chat_id).toBe(String(chatId));
  });

  it_('an expired token, an unknown token and a malformed token all get the same answer', async (e) => {
    const p = await person(e);
    const { token } = await links.createLinkToken(p.id, {});
    await e.pool.query(`update telegram_link_tokens set expires_at = now() - interval '1 second' where profile_id=$1`, [p.id]);
    for (const t of [token, 'A'.repeat(32), 'short', '<script>']) {
      calls = [];
      const c = newChat();
      await webhook(text(c, `/start ${t}`));
      expect(sentTo(c)[0], t).toMatch(/ran out or was already used/);
    }
    expect((await e.pool.query(`select count(*)::int n from telegram_links where profile_id=$1`, [p.id])).rows[0].n).toBe(0);
  });

  it_('two taps at once make one link (one winner)', async (e) => {
    const p = await person(e);
    const { token } = await links.createLinkToken(p.id, {});
    const [c1, c2] = [newChat(), newChat()];
    const r = await Promise.all([links.consumeLinkToken(token, c1), links.consumeLinkToken(token, c2)]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect((await e.pool.query(`select count(*)::int n from telegram_links where profile_id=$1`, [p.id])).rows[0].n).toBe(1);
  });

  it_('a chat that was linked to another wallet moves to the new one (one profile per chat)', async (e) => {
    const [p1, p2] = [await person(e), await person(e)];
    const chatId = await linked(e, p1);
    const { token } = await links.createLinkToken(p2.id, {});
    await webhook(text(chatId, `/start ${token}`));
    const rows = (await e.pool.query(`select profile_id from telegram_links where chat_id=$1`, [chatId])).rows;
    expect(rows).toEqual([{ profile_id: p2.id }]);
  });

  it_('status, change of the switches and language, and unlink by the account button', async (e) => {
    const p = await person(e);
    expect(TelegramStatusResponse.parse(await (await call('GET', p)).json())).toMatchObject({ enabled: true, linked: false, botUsername: 'HammerpriceTestBot' });
    await linked(e, p, { prefs: { won: true } });
    const st = TelegramStatusResponse.parse(await (await call('GET', p)).json());
    expect(st).toMatchObject({ linked: true, locale: 'en' });
    const patched = TelegramStatusResponse.parse(await (await call('PATCH', p, { prefs: { won: false, show_start: false }, locale: 'de' })).json());
    expect(patched).toMatchObject({ locale: 'de', prefs: { won: false, show_start: false, outbid: true } });
    expect((await call('PATCH', p, {})).status).toBe(400);
    expect((await call('PATCH', p, { prefs: { nope: true } })).status).toBe(400);
    const gone = await call('DELETE', p);
    expect(gone.status).toBe(204);
    expect(TelegramStatusResponse.parse(await (await call('GET', p)).json()).linked).toBe(false);
    expect((await call('PATCH', p, { locale: 'en' })).status).toBe(404); // not linked
  });

  it_('the link routes need a session (401) and refuse a cross-site write', async (e) => {
    const anon = { id: '', wallet: '', cookie: '' };
    expect((await call('GET', anon)).status).toBe(401);
    expect((await call('POST', anon, {})).status).toBe(401);
    const p = await person(e);
    const cross = await link.DELETE(req('/api/telegram/link', { method: 'DELETE', cookie: p.cookie, headers: { origin: 'https://evil.example' } }));
    expect(cross.status).toBe(403);
    const crossPost = await link.POST(req('/api/telegram/link', { method: 'POST', cookie: p.cookie, body: {}, headers: { origin: 'https://evil.example' } }));
    expect(crossPost.status).toBe(403);
  });

  it_('starting a link is limited to 5 per 10 minutes per wallet', async (e) => {
    const p = await person(e);
    for (let i = 0; i < 5; i++) expect((await call('POST', p, {})).status).toBe(200);
    const res = await call('POST', p, {});
    expect(res.status).toBe(429);
    expect(ErrorResponseSchema.parse(await res.json()).code).toBe('rate_limited');
    // Only one link is open at a time: the earlier tokens were replaced.
    expect((await e.pool.query(`select count(*)::int n from telegram_link_tokens where profile_id=$1`, [p.id])).rows[0].n).toBe(1);
  });

  it_('/stop unlinks and wipes the markers; /start without a token says what to do; /help lists the commands', async (e) => {
    const p = await person(e);
    const chatId = await linked(e, p);
    await e.pool.query(`insert into telegram_sent (profile_id, kind, ref) values ($1,'outbid','x')`, [p.id]);
    await webhook(text(chatId, '/help'));
    expect(sentTo(chatId)[0]).toMatch(/\/status.*\/stop.*\/help/s);
    await webhook(text(chatId, '/start'));
    expect(sentTo(chatId)[1]).toMatch(/You are connected/);
    await webhook(text(chatId, '/stop'));
    expect(sentTo(chatId)[2]).toMatch(/^Disconnected/);
    expect((await e.pool.query(`select count(*)::int n from telegram_links where profile_id=$1`, [p.id])).rows[0].n).toBe(0);
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1`, [p.id])).rows[0].n).toBe(0);
    await webhook(text(chatId, '/stop'));
    expect(sentTo(chatId)[3]).toMatch(/was not connected/);
    await webhook(text(chatId, '/start'));
    expect(sentTo(chatId)[4]).toMatch(/open your account page/);
    await webhook(text(chatId, 'hello there'));
    expect(sentTo(chatId)[5]).toMatch(/I only understand/);
  });

  it_('a command addressed to another bot is ignored, one for this bot works, a group chat is ignored', async (e) => {
    const p = await person(e);
    const chatId = await linked(e, p);
    await webhook(text(chatId, '/help@SomeOtherBot'));
    expect(sentTo(chatId)).toEqual([]);
    await webhook(text(chatId, '/help@hammerpricetestbot'));
    expect(sentTo(chatId)).toHaveLength(1);
    await webhook({ update_id: 1, message: { message_id: 1, text: '/help', chat: { id: -100123, type: 'group' }, from: { id: 5 } } });
    expect(calls.filter((c) => c.body.chat_id === -100123)).toEqual([]);
  });

  it_('German chats get German answers (the language of the link, else of Telegram)', async (e) => {
    const p = await person(e);
    const chatId = await linked(e, p, { locale: 'de' });
    await webhook(text(chatId, '/help', 'en'));
    expect(sentTo(chatId)[0]).toMatch(/^Hammerprice-Bot/);
    const stranger = newChat();
    await webhook(text(stranger, '/start', 'de-AT'));
    expect(sentTo(stranger)[0]).toMatch(/Hammerprice schickt Gebots- und Zahlungsnachrichten/);
  });

  it_('the user blocking the bot (my_chat_member kicked, or a 403 on a send) unlinks the chat at once', async (e) => {
    const p = await person(e);
    const chatId = await linked(e, p);
    await webhook({ update_id: 1, my_chat_member: { chat: { id: chatId, type: 'private' }, new_chat_member: { status: 'kicked' } } });
    expect(await links.getLinkByChat(chatId)).toBeNull();

    const q = await person(e);
    const c2 = await linked(e, q);
    failFor.set(c2, { status: 403, description: 'Forbidden: bot was blocked by the user' });
    const ctx = await notify.context();
    const out = await notify.deliver(ctx!, (await links.getLink(q.id))!, 'outbid', 'blocked-1', () => ({ text: 'x' }));
    expect(out).toBe('blocked');
    expect(await links.getLinkByChat(c2)).toBeNull();
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1`, [q.id])).rows[0].n).toBe(0);
  });
});

describe('the webhook gate', () => {
  it_('a wrong, empty or missing secret is 401 and reads nothing; the right one is 200 even for garbage', async (e) => {
    const p = await person(e);
    const chatId = await linked(e, p);
    for (const s of ['wrong', '', null, `${SECRET}x`]) {
      const res = await webhook(text(chatId, '/help'), s);
      expect(res.status, String(s)).toBe(401);
    }
    expect(calls).toEqual([]);
    expect((await webhook({ nonsense: true })).status).toBe(200);
    expect((await hook.POST(req('/api/telegram/webhook', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': SECRET } }))).status).toBe(400); // empty body is not JSON
    expect((await webhook(text(chatId, '/help'))).status).toBe(200);
    expect(sentTo(chatId)).toHaveLength(1);
  });

  it_('is 404 feature_off while the feature is off, unconfigured, or killed (app_flags)', async (e) => {
    const res = async () => webhook(text(1, '/help'));
    vi.stubEnv('FEATURE_TELEGRAM', 'false');
    flags.clearFlagMemo();
    let r = await res();
    expect(r.status).toBe(404);
    expect(ErrorResponseSchema.parse(await r.json()).code).toBe('feature_off');
    vi.stubEnv('FEATURE_TELEGRAM', 'true');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    flags.clearFlagMemo();
    expect((await res()).status).toBe(404);
    vi.stubEnv('TELEGRAM_BOT_TOKEN', TOKEN);
    await e.pool.query(`insert into app_flags (key, value) values ('telegram', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`);
    flags.clearFlagMemo();
    try {
      expect((await res()).status).toBe(404);
      const p = await person(e);
      // the status read is a plain 200 "not enabled" (the account page shows nothing, no 404 in the console); every write is feature_off
      expect(TelegramStatusResponse.parse(await (await call('GET', p)).json())).toEqual({ enabled: false, linked: false, linkedAt: null, locale: null, prefs: DEFAULT_TELEGRAM_PREFS, botUsername: '' });
      expect((await call('POST', p, {})).status).toBe(404);
      expect((await call('PATCH', p, { locale: 'de' })).status).toBe(404);
      expect((await call('DELETE', p)).status).toBe(404);
      expect(await notify.notifyOutbid({ bidId: randomUUID(), lotId: randomUUID(), lotName: 'x', showId: randomUUID(), amount: 1n, previousBidderId: p.id, bidderId: randomUUID(), closesAt: null })).toBe(0);
    } finally { await e.pool.query(`delete from app_flags where key = 'telegram'`); flags.clearFlagMemo(); }
    r = await res();
    expect(r.status).toBe(200);
  });
});

describe('outbid and ending soon, from a real bid', () => {
  it_('the previous leader is told they were outbid, in their language, with the room link; the bidder is not', async (e) => {
    const { a, b, show, lot } = await room(e);
    const chatA = await linked(e, a, { locale: 'de' });
    const chatB = await linked(e, b);
    expect((await e.bid(lot, a, 50n * USDC, { now: at(1_000) })).ok).toBe(true);
    expect((await e.bid(lot, b, 60n * USDC, { now: at(2_000) })).ok).toBe(true);
    await hooks.settled();
    expect(sentTo(chatA)).toHaveLength(1);
    expect(sentTo(chatA)[0]).toMatch(/^Sie wurden bei Lot 1 überboten\. Das höchste Gebot liegt jetzt bei 60\.00 USDC\.\nErneut bieten: https:\/\/[^/]+\/de\/room\/[0-9a-f-]+$/);
    expect(sentTo(chatA)[0]).toContain(`/de/room/${show.id}`);
    expect(sentTo(chatB)).toEqual([]);
  });

  it_('is opt-in (switch off, no message), sent once per bid, and never to a profile without a link', async (e) => {
    const { a, b, lot } = await room(e);
    const chatA = await linked(e, a, { prefs: { outbid: false } });
    await e.bid(lot, a, 50n * USDC, { now: at(1_000) });
    await e.bid(lot, b, 60n * USDC, { now: at(2_000) });
    await hooks.settled();
    expect(sentTo(chatA)).toEqual([]);

    await e.pool.query(`update telegram_links set prefs = prefs || '{"outbid": true}'::jsonb where profile_id=$1`, [a.id]);
    await e.bid(lot, a, 70n * USDC, { now: at(3_000) });
    await e.bid(lot, b, 80n * USDC, { now: at(4_000) }); // outbids a again
    await hooks.settled();
    expect(sentTo(chatA)).toHaveLength(1);
    // the same event is never sent twice (a retry, the sweep)
    const bidId = (await e.pool.query(`select id from bids where bidder_id=$1 order by placed_at desc limit 1`, [b.id])).rows[0].id;
    expect(await notify.notifyOutbid({ bidId, lotId: lot, lotName: 'Lot 1', showId: randomUUID(), amount: 80n * USDC, previousBidderId: a.id, bidderId: b.id, closesAt: null })).toBe(0);
    expect(sentTo(chatA)).toHaveLength(1);
    expect(b.id).not.toBe(a.id);
  });

  it_('everyone who bid hears that the lot is about to close, once, except the bidder who just bid', async (e) => {
    const { a, b, show, lot } = await room(e);
    const c = await e.profile();
    await e.paddle(show.id, c.id, { hours: 100 });
    const chatA = await linked(e, a); const chatC = await linked(e, c); const chatB = await linked(e, b);
    await e.bid(lot, a, 50n * USDC, { now: at(1_000) });
    await e.bid(lot, c, 55n * USDC, { now: at(2_000) });
    await hooks.settled();
    calls = [];
    // The lot closes 20 s after T0, far inside the 5 minute window. The bid by b is the trigger; b itself is not told.
    const arg = { lotId: lot, lotName: 'Lot 1', showId: show.id, closesAt: at(20_000), highBid: 60n * USDC, exceptProfileId: b.id };
    await notify.notifyEndingSoon(arg, { now: at(3_000) });
    await notify.notifyEndingSoon(arg, { now: at(4_000) });
    expect(sentTo(chatA)).toHaveLength(1);
    expect(sentTo(chatA)[0]).toMatch(/closes in about 1 min\. The highest bid is 60\.00 USDC\.\nOpen the room: https:\/\/[^/]+\/en\/room\//);
    expect(sentTo(chatC)).toHaveLength(1);
    expect(sentTo(chatB)).toEqual([]);
    // a lot that closes in an hour is not "ending soon"
    calls = [];
    expect(await notify.notifyEndingSoon({ lotId: randomUUID(), lotName: 'x', showId: randomUUID(), closesAt: at(3_600_000), highBid: null }, { now: at(0) })).toBe(0);
  });

  it_('a Telegram failure never breaks a bid: the bid is accepted while Telegram answers 500, throws, or 403', async (e) => {
    const { a, b, lot } = await room(e);
    const chatA = await linked(e, a);
    failFor.set(chatA, { status: 500, description: 'Internal Server Error' });
    expect((await e.bid(lot, a, 50n * USDC, { now: at(1_000) })).ok).toBe(true);
    const bid = await e.bid(lot, b, 60n * USDC, { now: at(2_000) });
    expect(bid.ok).toBe(true);
    await hooks.settled();
    expect(calls.length).toBeGreaterThan(0);
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1`, [a.id])).rows[0].n).toBe(0); // the claim was given back, a later pass can retry
    expect(await links.getLinkByChat(chatA)).not.toBeNull(); // 500 is not a block

    vi.stubGlobal('fetch', async () => { throw new TypeError(`network down ${TOKEN}`); });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await e.bid(lot, a, 70n * USDC, { now: at(3_000) })).ok).toBe(true);
      expect((await e.bid(lot, b, 80n * USDC, { now: at(4_000) })).ok).toBe(true);
      await hooks.settled();
      expect(JSON.stringify(errors.mock.calls)).not.toContain(TOKEN);
    } finally { vi.stubGlobal('fetch', fakeFetch); errors.mockRestore(); }
  });

  it_('with FEATURE_TELEGRAM off the hooks do nothing at all (no fetch, no marker)', async (e) => {
    const { a, b, lot } = await room(e);
    await linked(e, a);
    vi.stubEnv('FEATURE_TELEGRAM', 'false');
    await e.bid(lot, a, 50n * USDC, { now: at(1_000) });
    await e.bid(lot, b, 60n * USDC, { now: at(2_000) });
    await hooks.settled();
    expect(calls).toEqual([]);
  });
});

describe('won, payment due, settled, deadline (settlements)', () => {
  /** A show whose single lot was bid by `a` and closed by the engine: a real settlement row awaiting payment. */
  async function sale(e: Env, cluster: 'devnet' | 'mainnet-beta' | null = 'devnet') {
    const seller = await e.profile(); const a = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'live', cluster, rules: { lotDurationS: 20, gapS: 6 }, lots: [{ state: 'open', openedAt: at(0), closesAt: at(20_000), reserve: null }] });
    await e.paddle(s.id, a.id, { hours: 100 });
    expect((await e.bid(s.lots[0], a, 60n * USDC, { now: at(1_000) })).ok).toBe(true);
    return { seller, a, show: s, lot: s.lots[0] };
  }
  const settlementOf = async (e: Env, lotId: string) => (await e.pool.query(`select * from settlements where lot_id=$1`, [lotId])).rows[0];

  it_('the winner gets "you won, pay by ..." with the pay link when the engine closes the lot', async (e) => {
    const { a, show, lot } = await sale(e);
    const chatA = await linked(e, a, { locale: 'en' });
    const r = await e.svc.advanceShow(show.id, at(25_000));
    expect(r.closed).toBe(1);
    await hooks.settled();
    const st = await settlementOf(e, lot);
    expect(sentTo(chatA)).toHaveLength(1);
    expect(sentTo(chatA)[0]).toContain('You won Lot 1 for 60.00 USDC.');
    expect(sentTo(chatA)[0]).toContain(`/en/room/${show.id}?settle=${st.id}`);
    expect(sentTo(chatA)[0]).toMatch(/Pay by \d\d\/\d\d\/\d{4}, \d\d:\d\d UTC/);
    // idempotent: the sweep and a second hook send nothing new
    await sweep.sweepTelegram({ now: new Date(Date.now()) });
    await notify.notifyWon({ settlementId: st.id });
    expect(sentTo(chatA).filter((t) => t.includes('You won'))).toHaveLength(1);
  });

  it_('only events after the link are sent: a win from before the chat was linked is not announced', async (e) => {
    const { a, show, lot } = await sale(e);
    await e.svc.advanceShow(show.id, at(25_000));
    await hooks.settled();
    const chatA = await linked(e, a, { linkedAt: at(86_400_000) }); // linked a day "after" the lot closed
    const st = await settlementOf(e, lot);
    expect(await notify.notifyWon({ settlementId: st.id })).toBe(0);
    expect(sentTo(chatA)).toEqual([]);
  });

  it_('the buyer wanting no "won" message gets none; the seller never gets a "you won"', async (e) => {
    const { a, seller, show } = await sale(e);
    const chatA = await linked(e, a, { prefs: { won: false } });
    const chatS = await linked(e, seller);
    await e.svc.advanceShow(show.id, at(25_000));
    await hooks.settled();
    expect(sentTo(chatA)).toEqual([]);
    expect(sentTo(chatS)).toEqual([]);
  });

  it_('a pass past its time budget sends nothing and claims nothing, so the next pass sends it', async (e) => {
    const { a, show, lot } = await sale(e);
    const chatA = await linked(e, a);
    await e.svc.advanceShow(show.id, at(25_000));
    await hooks.settled();
    await e.pool.query(`delete from telegram_sent where profile_id=$1`, [a.id]);
    calls = [];
    const st = await settlementOf(e, lot);
    expect(await notify.notifyWon({ settlementId: st.id }, { deadline: Date.now() - 1 })).toBe(0);
    expect(sentTo(chatA)).toEqual([]);
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1`, [a.id])).rows[0].n).toBe(0);
    expect(await notify.notifyWon({ settlementId: st.id }, { deadline: Date.now() + 60_000 })).toBe(1);
  });

  it_('settled: buyer and seller get the receipt, and the explorer link follows the cluster of the settlement (devnet and mainnet)', async (e) => {
    for (const cluster of ['devnet', 'mainnet-beta'] as const) {
      const { a, seller, show, lot } = await sale(e, cluster);
      const [chatA, chatS] = [await linked(e, a, { locale: 'de' }), await linked(e, seller, { locale: 'en' })];
      await e.svc.advanceShow(show.id, at(25_000));
      await hooks.settled();
      const st = await settlementOf(e, lot);
      const sig = `${cluster === 'devnet' ? '5' : '4'}${'x'.repeat(86)}`;
      await e.pool.query(`update settlements set status='settled', tx_signature=$2, settled_at=now() where id=$1`, [st.id, sig]);
      calls = [];
      expect(await notify.notifySettled({ settlementId: st.id })).toBe(2);
      const want = cluster === 'devnet' ? `https://explorer.solana.com/tx/${sig}?cluster=devnet` : `https://explorer.solana.com/tx/${sig}`;
      expect(sentTo(chatA)).toEqual([`Erledigt. Lot 1 ist in Ihrer Wallet.\nBeleg im Explorer: ${want}`]);
      expect(sentTo(chatS)).toEqual([`Done. Lot 1 was paid and delivered (60.00 USDC).\nReceipt on the explorer: ${want}`]);
      expect(await notify.notifySettled({ settlementId: st.id })).toBe(0); // once
    }
  });

  it_('a settlement with no cluster of its own follows SOLANA_CLUSTER (the one switch)', async (e) => {
    const { a, show, lot } = await sale(e, null);
    const chatA = await linked(e, a);
    await e.svc.advanceShow(show.id, at(25_000));
    await hooks.settled();
    const st = await settlementOf(e, lot);
    await e.pool.query(`update settlements set status='settled', tx_signature=$2, settled_at=now(), cluster=null where id=$1`, [st.id, '3'.repeat(87)]);
    vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta');
    calls = [];
    await notify.notifySettled({ settlementId: st.id });
    expect(sentTo(chatA)[0]).toContain(`https://explorer.solana.com/tx/${'3'.repeat(87)}`);
    expect(sentTo(chatA)[0]).not.toContain('cluster=');
  });

  it_('the deadline reminder comes from the daily sweep: due within 24 h, not within the first hour of the win, once', async (e) => {
    const near = await sale(e); const fresh = await sale(e); const far = await sale(e);
    const old = { linkedAt: new Date(Date.now() - 3 * 86_400_000), prefs: { show_start: false, ending_soon: false, won: false } };
    const [cNear, cFresh, cFar] = [await linked(e, near.a, old), await linked(e, fresh.a, old), await linked(e, far.a, old)];
    for (const s of [near, fresh, far]) await e.svc.advanceShow(s.show.id, at(25_000));
    await hooks.settled();
    calls = [];
    const now = Date.now();
    const set = async (lot: string, closedAgoMs: number, dueInMs: number) => e.pool.query(`update lots set closed_at=$2 where id=$1`, [lot, new Date(now - closedAgoMs)]).then(() => e.pool.query(`update settlements set due_at=$2 where lot_id=$1`, [lot, new Date(now + dueInMs)]));
    await set(near.lot, 2 * 3_600_000, 3 * 3_600_000);
    await set(fresh.lot, 10 * 60_000, 3 * 3_600_000);
    await set(far.lot, 2 * 3_600_000, 3 * 86_400_000);
    const res = await sweep.sweepTelegram({ now: new Date(now) });
    expect(res.deadline).toBe(1);
    expect(sentTo(cNear)).toHaveLength(1);
    expect(sentTo(cNear)[0]).toMatch(/^Reminder: pay for Lot 1 \(60\.00 USDC\) by /);
    expect(sentTo(cFresh)).toEqual([]);
    expect(sentTo(cFar)).toEqual([]);
    expect((await sweep.sweepTelegram({ now: new Date(now) })).deadline).toBe(0);
    expect(sentTo(cNear)).toHaveLength(1);
  });

  it_('/status lists the open bids (leading or outbid) and the payments to make with their pay links', async (e) => {
    const seller = await e.profile(); const a = await e.profile(); const b = await e.profile();
    const s1 = await e.show({ sellerId: seller.id, status: 'live', rules: { lotDurationS: 600 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 600_000), reserve: null }] });
    const s2 = await e.show({ sellerId: seller.id, status: 'live', rules: { lotDurationS: 600 }, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 600_000), reserve: null }] });
    for (const s of [s1, s2]) { await e.paddle(s.id, a.id); await e.paddle(s.id, b.id); }
    await e.bid(s1.lots[0], a, 50n * USDC); // a leads on lot 1
    await e.bid(s2.lots[0], a, 50n * USDC);
    await e.bid(s2.lots[0], b, 60n * USDC); // a is outbid on lot 2
    const chatA = await linked(e, a);
    // plus a payment to make
    const w = await sale(e);
    await e.svc.advanceShow(w.show.id, at(25_000));
    await e.pool.query(`update settlements set buyer_id=$2 where lot_id=$1`, [w.lot, a.id]);
    calls = [];
    await webhook(text(chatA, '/status'));
    // The "you won" hook of advanceShow runs after the response and may land after `calls = []`: pick the /status reply, not the first message.
    const msg = sentTo(chatA).find((m) => m.includes('Open bids')) ?? '';
    expect(msg).toContain('Open bids');
    expect(msg).toContain('Lot 1: your bid of 50.00 USDC is the highest.');
    expect(msg).toContain('Lot 1: you were outbid, the highest bid is 60.00 USDC.');
    expect(msg).toContain('To pay');
    expect(msg).toMatch(/Lot 1: 60\.00 USDC, pay by .*\nhttps:\/\/[^/]+\/en\/room\/[0-9a-f-]+\?settle=[0-9a-f-]+/);

    const nobody = await person(e);
    const chatN = await linked(e, nobody);
    await webhook(text(chatN, '/status'));
    expect(sentTo(chatN)[0]).toBe('You have no open bids and nothing to pay.');
    const unlinkedChat = newChat();
    await webhook(text(unlinkedChat, '/status'));
    expect(sentTo(unlinkedChat)[0]).toMatch(/open your account page/);
  });
});

describe('show start', () => {
  it_('people with a bidder number hear that the show started (not the seller), once', async (e) => {
    const seller = await e.profile(); const a = await e.profile(); const b = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'scheduled', lots: [{}] });
    await e.paddle(s.id, a.id);
    const [cA, cS, cB] = [await linked(e, a, { locale: 'de' }), await linked(e, seller), await linked(e, b)];
    await e.pool.query(`update shows set status='live', started_at=now() where id=$1`, [s.id]);
    expect(await notify.notifyShowStarted(s.id)).toBe(1);
    expect(sentTo(cA)[0]).toMatch(/^Test show hat begonnen\.\nRaum öffnen: https:\/\/[^/]+\/de\/room\//);
    expect(sentTo(cS)).toEqual([]);
    expect(sentTo(cB)).toEqual([]);
    expect(await notify.notifyShowStarted(s.id)).toBe(0);
  });

  it_('startShow (go live now) announces it through the hook, a scheduled show is not announced', async (e) => {
    const seller = await e.profile(); const a = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'scheduled', lots: [{ consign: 'ready' }] });
    await e.paddle(s.id, a.id);
    const cA = await linked(e, a, { linkedAt: new Date(Date.now() - 60_000) });
    expect(await notify.notifyShowStarted(s.id)).toBe(0); // still scheduled
    await e.svc.startShow(s.id, { profileId: seller.id, wallet: seller.wallet });
    await hooks.settled();
    expect(sentTo(cA)).toHaveLength(1);
  });
});

describe('rate limit per chat', () => {
  it_('sends at most 20 a minute to one chat, does not claim the rest, and a later pass sends them', async (e) => {
    const p = await person(e);
    const chatId = await linked(e, p);
    const l = (await links.getLink(p.id))!;
    const ctx = (await notify.context())!;
    const outcomes: string[] = [];
    for (let i = 0; i < 23; i++) outcomes.push(await notify.deliver(ctx, l, 'outbid', `r${i}`, () => ({ text: `m${i}` })));
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(20);
    expect(outcomes.filter((o) => o === 'limited')).toHaveLength(3);
    expect(sentTo(chatId)).toHaveLength(20);
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1`, [p.id])).rows[0].n).toBe(20);
    await e.pool.query('delete from rate_limits'); // the next minute
    expect(await notify.deliver(ctx, l, 'outbid', 'r22', () => ({ text: 'm22' }))).toBe('sent');
  });
});

describe('moderation from Telegram', () => {
  async function pendingMessage(e: Env, over: { house?: boolean } = {}) {
    const op = await e.profile(); const bidder = await e.profile();
    const s = await e.show({ sellerId: op.id, status: 'live', isHouse: over.house ?? false, lots: [{}] });
    const paddle = await e.paddle(s.id, bidder.id);
    const msg = await chat.postMessage({ showId: s.id, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'Is the card in good shape?', clientNonce: randomUUID(), lotNumber: 1 });
    await hooks.settled();
    const status = async () => (await e.pool.query(`select status, hidden_reason from chat_messages where id=$1`, [msg.id])).rows[0];
    return { op, bidder, show: s, paddle, msg, status };
  }
  const buttons = (chatId: number) => calls.find((c) => c.method === 'sendMessage' && c.body.chat_id === chatId)?.body.reply_markup?.inline_keyboard?.[0] as { text: string; callback_data: string }[] | undefined;

  it_('a pending message goes to the linked operator with Approve, Reject and Mute; the bidder and others get nothing; no wallet in the text', async (e) => {
    const op = await e.profile(); const bidder = await e.profile(); const other = await e.profile();
    const s = await e.show({ sellerId: op.id, status: 'live', lots: [{}] });
    const paddle = await e.paddle(s.id, bidder.id);
    const [cOp, cBidder, cOther] = [await linked(e, op, { locale: 'de' }), await linked(e, bidder), await linked(e, other)];
    const msg = await chat.postMessage({ showId: s.id, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'Ist die Karte gut erhalten?', clientNonce: randomUUID(), lotNumber: 1 });
    await hooks.settled();
    expect(sentTo(cBidder)).toEqual([]);
    expect(sentTo(cOther)).toEqual([]);
    expect(sentTo(cOp)).toEqual([`Chat-Nachricht wartet in Test show\nBieter ${paddle.number}, Los 1:\n\nIst die Karte gut erhalten?`]);
    expect(sentTo(cOp)[0]).not.toContain(bidder.wallet);
    const b = buttons(cOp)!;
    expect(b.map((x) => x.text)).toEqual(['Freigeben', 'Ablehnen', '60 Min stumm']);
    for (const x of b) expect(Buffer.byteLength(x.callback_data)).toBeLessThanOrEqual(64);
    expect(msg.status).toBe('pending');
  });

  it_('an operator who did not switch moderation on gets nothing; the operator\'s own posts are never forwarded', async (e) => {
    const op = await e.profile(); const bidder = await e.profile();
    const s = await e.show({ sellerId: op.id, status: 'live', lots: [{}] });
    await e.paddle(s.id, bidder.id);
    const cOp = await linked(e, op, { prefs: { moderation: false } });
    await chat.postMessage({ showId: s.id, actor: { profileId: bidder.id, wallet: bidder.wallet }, body: 'hello', clientNonce: randomUUID() });
    await hooks.settled();
    expect(sentTo(cOp)).toEqual([]);
    await e.pool.query(`update telegram_links set prefs = prefs || '{"moderation": true}'::jsonb where profile_id=$1`, [op.id]);
    await chat.postMessage({ showId: s.id, actor: { profileId: op.id, wallet: op.wallet }, body: 'welcome all', clientNonce: randomUUID() });
    await hooks.settled();
    expect(sentTo(cOp)).toEqual([]);
  });

  it_('Approve publishes the message through the chat service, edits the Telegram message and removes the buttons', async (e) => {
    const { op, msg, status } = await pendingMessage(e);
    const cOp = await linked(e, op);
    await notify.notifyModeration(msg.id);
    const approve = buttons(cOp)![0].callback_data;
    calls = [];
    await webhook(press(cOp, approve));
    expect(await status()).toMatchObject({ status: 'approved' });
    expect(answers()).toEqual(['Approved.']);
    expect(edits()).toHaveLength(1);
    expect(edits()[0].body).toMatchObject({ chat_id: cOp, message_id: 77, reply_markup: { inline_keyboard: [] } });
    expect(edits()[0].body.text).toBe('Approved: Is the card in good shape?');
    // pressing it again says it was handled and changes nothing
    calls = [];
    await webhook(press(cOp, approve));
    expect(answers()).toEqual(['This message was already handled.']);
    expect(edits()).toEqual([]);
    expect((await e.pool.query(`select count(*)::int n from audit_logs where action='chat.approve'`)).rows[0].n).toBeGreaterThan(0);
  });

  it_('Reject keeps it out of the public list with a reason; Mute silences the bidder for 60 minutes and rejects the message', async (e) => {
    const r1 = await pendingMessage(e);
    const c1 = await linked(e, r1.op);
    await notify.notifyModeration(r1.msg.id);
    await webhook(press(c1, buttons(c1)![1].callback_data));
    expect(await r1.status()).toMatchObject({ status: 'rejected', hidden_reason: 'Rejected by the room operator' });
    expect(answers()).toEqual(['Rejected.']);

    calls = [];
    const r2 = await pendingMessage(e);
    const c2 = await linked(e, r2.op);
    await notify.notifyModeration(r2.msg.id);
    await webhook(press(c2, buttons(c2)![2].callback_data));
    expect(await r2.status()).toMatchObject({ status: 'rejected' });
    const mute = (await e.pool.query(`select kind, until, reason from chat_mutes where show_id=$1 and profile_id=$2`, [r2.show.id, r2.bidder.id])).rows[0];
    expect(mute.kind).toBe('mute');
    expect(new Date(mute.until).getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    expect(new Date(mute.until).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
    expect(answers()).toContain('Bidder muted for 60 min, message rejected.');
    // the muted bidder cannot post
    await expect(chat.postMessage({ showId: r2.show.id, actor: { profileId: r2.bidder.id, wallet: r2.bidder.wallet }, body: 'more', clientNonce: randomUUID() })).rejects.toMatchObject({ code: 'muted' });
  });

  it_('is checked against the operator: a linked chat that is NOT this room\'s operator cannot decide, even with a genuine signature', async (e) => {
    const { msg, status } = await pendingMessage(e);
    const stranger = await e.profile();
    const cS = await linked(e, stranger);
    const data = signCallback(SECRET, 'approve', msg.id, cS); // a signature made for the stranger's own chat
    calls = [];
    await webhook(press(cS, data));
    expect(await status()).toMatchObject({ status: 'pending' });
    expect(answers()).toEqual(['You are not the operator of this room.']);
    expect(edits()).toEqual([]);
  });

  it_('refuses a button from another chat, a tampered or foreign signature, an unlinked chat, and a chat switched off', async (e) => {
    const { op, msg, status } = await pendingMessage(e);
    const cOp = await linked(e, op);
    const good = signCallback(SECRET, 'approve', msg.id, cOp);
    const otherChat = await linked(e, await e.profile());
    for (const [chatId, data, expected] of [
      [otherChat, good, 'This button is no longer valid.'], // a button forwarded to another chat
      [cOp, `r${good.slice(1)}`, 'This button is no longer valid.'], // relabelled
      [cOp, signCallback('another-secret-another-secret-12345', 'approve', msg.id, cOp), 'This button is no longer valid.'],
      [cOp, 'nonsense', 'This button is no longer valid.'],
      [newChat(), good, 'Connect this chat on your account page first.'],
    ] as const) {
      calls = [];
      await webhook(press(chatId, data));
      expect(answers(), data).toEqual([expected]);
    }
    expect(await status()).toMatchObject({ status: 'pending' });
    vi.stubEnv('FEATURE_CHAT', 'false');
    flags.clearFlagMemo();
    calls = [];
    await webhook(press(cOp, good));
    expect(answers()).toEqual(['The chat is switched off.']);
    expect(await status()).toMatchObject({ status: 'pending' });
  });

  it_('a callback for a message of a group chat (not a private chat) is refused', async (e) => {
    const { op, msg } = await pendingMessage(e);
    const cOp = await linked(e, op);
    const data = signCallback(SECRET, 'approve', msg.id, cOp);
    calls = [];
    const u = press(cOp, data);
    (u.callback_query.message as { chat: { type: string } }).chat.type = 'supergroup';
    await webhook(u);
    expect(answers()).toEqual(['This button is no longer valid.']);
  });

  it_('the house show goes to the OPERATOR_WALLETS list, and only they may decide', async (e) => {
    const { op, bidder, msg, status } = await pendingMessage(e, { house: true });
    const houseOp = await e.profile();
    vi.stubEnv('OPERATOR_WALLETS', houseOp.wallet);
    const cHouse = await linked(e, houseOp);
    const cSeller = await linked(e, op);
    await notify.notifyModeration(msg.id);
    expect(sentTo(cHouse)).toHaveLength(1); // the platform operator
    expect(sentTo(cSeller)).toHaveLength(1); // the show's own profile (the platform's house seller in production)
    calls = [];
    await webhook(press(cHouse, signCallback(SECRET, 'approve', msg.id, cHouse)));
    expect(await status()).toMatchObject({ status: 'approved' });
    void bidder;
  });
});

describe('the sweep', () => {
  it_('does nothing while the feature is off, and purges old tokens and markers when it runs', async (e) => {
    const p = await person(e);
    await e.pool.query(`insert into telegram_link_tokens (token_hash, profile_id, locale, prefs, expires_at) values ('h1',$1,'en','{}'::jsonb, now() - interval '3 days')`, [p.id]);
    await e.pool.query(`insert into telegram_link_tokens (token_hash, profile_id, locale, prefs, expires_at) values ('h2',$1,'en','{}'::jsonb, now() + interval '5 minutes')`, [p.id]);
    await e.pool.query(`insert into telegram_sent (profile_id, kind, ref, sent_at) values ($1,'won','old', now() - interval '60 days'), ($1,'won','new', now())`, [p.id]);
    vi.stubEnv('FEATURE_TELEGRAM', 'false');
    flags.clearFlagMemo();
    expect(await sweep.sweepTelegram()).toEqual({ won: 0, settled: 0, showStart: 0, endingSoon: 0, deadline: 0, lotWatch: 0, purged: 0 });
    expect((await e.pool.query(`select count(*)::int n from telegram_link_tokens where profile_id=$1`, [p.id])).rows[0].n).toBe(2);
    vi.stubEnv('FEATURE_TELEGRAM', 'true');
    flags.clearFlagMemo();
    const res = await sweep.sweepTelegram();
    expect(res.purged).toBe(2);
    expect((await e.pool.query(`select token_hash from telegram_link_tokens where profile_id=$1`, [p.id])).rows).toEqual([{ token_hash: 'h2' }]);
    expect((await e.pool.query(`select ref from telegram_sent where profile_id=$1`, [p.id])).rows).toEqual([{ ref: 'new' }]);
  });

  it_('sends what a hook missed: a sale nobody was told about, and the show that started while nothing listened', async (e) => {
    const seller = await e.profile(); const a = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'live', rules: { lotDurationS: 20 }, lots: [{ state: 'open', openedAt: at(0), closesAt: at(20_000), reserve: null }] });
    await e.paddle(s.id, a.id, { hours: 100 });
    await e.bid(s.lots[0], a, 60n * USDC, { now: at(1_000) });
    await hooks.settled(); // the bid's own hook must be finished before the switch moves (it reads the flag memo)
    vi.stubEnv('FEATURE_TELEGRAM', 'false'); // the hooks are silent while it is off
    await e.svc.advanceShow(s.id, at(25_000));
    await hooks.settled();
    vi.stubEnv('FEATURE_TELEGRAM', 'true');
    flags.clearFlagMemo();
    const cA = await linked(e, a, { linkedAt: new Date(Date.now() - 86_400_000), prefs: { show_start: false } });
    await e.pool.query(`update lots set closed_at = now() - interval '5 minutes' where id=$1`, [s.lots[0]]);
    await e.pool.query(`update settlements set due_at = now() + interval '10 minutes' where lot_id=$1`, [s.lots[0]]);
    const res = await sweep.sweepTelegram();
    expect(res.won).toBeGreaterThanOrEqual(1); // other tests of this file leave sales behind too
    expect(sentTo(cA).filter((t) => t.includes('You won Lot 1 for 60.00 USDC.'))).toHaveLength(1);
  });
});

describe('pack delivery (A14): the pack operator hears that a sale was paid to them and must be delivered', () => {
  async function drawnSale(e: Env, o: { isHouse?: boolean; status?: string } = {}) {
    const op = await e.profile(), buyer = await e.profile();
    const pack = (await e.pool.query(`insert into pack_definitions (operator_profile_id, operator_wallet, is_house, name, mode, cluster, price, odds, status) values ($1,$2,$3,'{"de":"Mein Pack","en":"My pack"}','chance','devnet',10000000,'[]','live') returning id`, [op.id, op.wallet, o.isHouse ?? false])).rows[0].id as string;
    const drawId = (await e.pool.query(`insert into pack_draws (pack_id, buyer_profile_id, buyer_wallet, cluster, age_confirmed_at, client_seed, price, status, flow, deliver_by) values ($1,$2,$3,'devnet',now(),$4,10000000,$5,'pay_first',$6) returning id`, [pack, buyer.id, buyer.wallet, `seed-${Math.random()}`, o.status ?? 'drawn', new Date(Date.now() + 86_400_000)])).rows[0].id as string;
    return { op, drawId };
  }
  it_('sends the operator one message in their language, once, with the manage link; a reminder is a second message, once', async (e) => {
    const { op, drawId } = await drawnSale(e);
    const chat = await linked(e, op, { locale: 'de', prefs: { pack_delivery: true } });
    calls = [];
    expect(await notify.notifyPackDelivery(drawId)).toBe(1);
    expect(sentTo(chat)).toHaveLength(1);
    expect(sentTo(chat)[0]).toContain('Mein Pack');
    expect(sentTo(chat)[0]).toContain('10.00 USDC');
    expect(sentTo(chat)[0]).toContain('/de/packs/manage');
    expect(await notify.notifyPackDelivery(drawId)).toBe(0);
    expect(await notify.notifyPackDelivery(drawId, { reminder: true })).toBe(1);
    expect(await notify.notifyPackDelivery(drawId, { reminder: true })).toBe(0);
    expect(sentTo(chat)).toHaveLength(2);
    expect(sentTo(chat)[1]).toContain('Verwarnung');
  });
  it_('is opt-in, never sent for the house demo, and not sent once the sale is no longer waiting for the operator', async (e) => {
    const off = await drawnSale(e);
    const chatOff = await linked(e, off.op, { prefs: { pack_delivery: false } });
    calls = [];
    expect(await notify.notifyPackDelivery(off.drawId)).toBe(0);
    expect(sentTo(chatOff)).toEqual([]);
    const house = await drawnSale(e, { isHouse: true });
    await linked(e, house.op, { prefs: { pack_delivery: true } });
    expect(await notify.notifyPackDelivery(house.drawId)).toBe(0);
    const done = await drawnSale(e, { status: 'settled' });
    await linked(e, done.op, { prefs: { pack_delivery: true } });
    expect(await notify.notifyPackDelivery(done.drawId)).toBe(0);
  });
});

describe('migration 0008', () => {
  it_('creates telegram_watches, the schema and the database agree, and applying it twice changes nothing', async (e) => {
    const cols = (await e.pool.query(`select column_name from information_schema.columns where table_name='telegram_watches' order by column_name`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(['created_at', 'profile_id', 'remaining', 'show_id']);
    const schema = await import('@/db/schema');
    const { getTableColumns } = await import('drizzle-orm');
    expect(Object.values(getTableColumns(schema.telegramWatches)).map((c) => c.name).sort()).toEqual(cols);
    const { MIGRATIONS_DIR, runSqlFile } = await import('@/db/__tests__/pg-harness');
    await runSqlFile(e.pool, `${MIGRATIONS_DIR}/0008_telegram_watch.sql`);
  });
});

describe('watch a room: lot alerts with pre-filled bid buttons', () => {
  const lotsOf = async (e: Env, showId: string) => (await e.pool.query(`select id from lots where show_id=$1 order by lot_number`, [showId])).rows.map((r) => r.id as string);
  /** A live show whose lots are all still catalogued; the first one has a grade. */
  async function liveShow(e: Env, n = 4) {
    const seller = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'live', rules: { lotDurationS: 60 }, lots: Array.from({ length: n }, () => ({})) });
    const ids = await lotsOf(e, s.id);
    await e.pool.query(`update lots set name='Charizard 1st Edition', grading_company='PSA', grade='10' where id=$1`, [ids[0]]);
    return { seller, show: s, ids };
  }
  const openLot = (e: Env, id: string, secs = 60) => e.pool.query(`update lots set state='open', opened_at=now(), closes_at=now() + make_interval(secs => $2) where id=$1`, [id, secs]);
  const closeLot = (e: Env, id: string) => e.pool.query(`update lots set state='sold', closed_at=now() where id=$1`, [id]);
  /** A watch that started a minute ago, so lots opened now count as "after the watch". */
  const watch = (e: Env, p: { id: string }, showId: string, remaining: number | null) =>
    e.pool.query(`insert into telegram_watches (profile_id, show_id, remaining, created_at) values ($1,$2,$3, now() - interval '1 minute')`, [p.id, showId, remaining]);
  const remainingOf = async (e: Env, p: { id: string }, showId: string) => (await e.pool.query(`select remaining from telegram_watches where profile_id=$1 and show_id=$2`, [p.id, showId])).rows[0] as { remaining: number | null } | undefined;
  const bodiesTo = (chatId: number) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chatId).map((c) => c.body);
  const ON = { lot_watch: true };

  it_('/watch asks how many (3, 5, 10, all), says nothing is bid for you, and a press starts the watch and switches lot alerts on', async (e) => {
    const { show, ids } = await liveShow(e);
    const a = await e.profile();
    await e.paddle(show.id, a.id);
    const chatId = await linked(e, a, { prefs: { lot_watch: false } });
    await webhook(text(chatId, '/watch'));
    const asked = bodiesTo(chatId)[0];
    expect(asked.text).toContain('Test show');
    expect(asked.text).toMatch(/Nothing is bid for you/);
    const buttons = asked.reply_markup.inline_keyboard[0] as { text: string; callback_data: string }[];
    expect(buttons.map((b) => b.text)).toEqual(['Next 3', 'Next 5', 'Next 10', 'All lots']);
    expect(buttons.map((b) => b.callback_data)).toEqual([`w|3|${show.id}`, `w|5|${show.id}`, `w|10|${show.id}`, `w|a|${show.id}`]);
    for (const b of buttons) expect(b.callback_data.length).toBeLessThanOrEqual(64);

    calls = [];
    await webhook(press(chatId, `w|5|${show.id}`));
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 5 });
    expect((await e.pool.query(`select prefs from telegram_links where profile_id=$1`, [a.id])).rows[0].prefs.lot_watch).toBe(true);
    expect(edits()[0].body.text).toMatch(/next 5 lots of Test show/);
    expect(edits()[0].body.text).toMatch(/Nothing is ever bid for you/);
    expect(answers()).toEqual(['Done.']);
    // pressing "All lots" later restarts the same watch with no limit
    await webhook(press(chatId, `w|a|${show.id}`));
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: null });
    expect(ids).toHaveLength(4);
  });

  it_('/watch 3 and /watch all start at once, anything else is refused, an unlinked chat is sent to connect', async (e) => {
    const { show } = await liveShow(e);
    const a = await e.profile();
    await e.paddle(show.id, a.id);
    const chatId = await linked(e, a);
    await webhook(text(chatId, '/watch 3'));
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 3 });
    await webhook(text(chatId, '/watch all'));
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: null });
    calls = [];
    for (const bad of ['/watch 0', '/watch 99', '/watch banana', '/watch -1']) await webhook(text(chatId, bad));
    expect(sentTo(chatId)).toHaveLength(4);
    for (const m of sentTo(chatId)) expect(m).toMatch(/\/watch 5 or \/watch all/);
    calls = [];
    const stranger = newChat();
    await webhook(text(stranger, '/watch'));
    expect(sentTo(stranger)[0]).toMatch(/open your account page/);
  });

  it_('a lot that opens gets ONE message with card, grade, opening price, time left and link, and two URL buttons that only pre-fill the room', async (e) => {
    const { show, ids } = await liveShow(e);
    const a = await e.profile();
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, show.id, 4);
    const bidsBefore = (await e.pool.query(`select count(*)::int n from bids`)).rows[0].n;
    await openLot(e, ids[0]);
    calls = [];
    expect(await notify.notifyLotsOpened(show.id)).toBe(1);
    const msg = bodiesTo(chatId);
    expect(msg).toHaveLength(1);
    expect(msg[0].text).toMatch(/^Lot 1 is open in Test show: Charizard 1st Edition \(PSA 10\)\.\nOpening price 50\.00 USDC, about 1 min left\.\nOpen the room: https:\/\/[^/]+\/en\/room\//);
    expect(msg[0].text).toContain(`/en/room/${show.id}`);
    expect(msg[0].text).toMatch(/Nothing is bid for you/);
    expect(msg[0].text).toMatch(/3 more alerts for this room\. \/unwatch stops them\./);
    const row = msg[0].reply_markup.inline_keyboard[0] as Record<string, string>[];
    expect(row.map((b) => b.text)).toEqual(['Bid 50.00 USDC', 'Bid 55.00 USDC (+10 %)']);
    for (const b of row) { expect(Object.keys(b).sort()).toEqual(['text', 'url']); } // URL buttons only: no callback, so pressing one tells the bot nothing
    const urls = row.map((b) => new URL(b.url));
    expect(urls.map((u) => u.pathname)).toEqual([`/en/room/${show.id}`, `/en/room/${show.id}`]);
    expect(urls.map((u) => [u.searchParams.get('lot'), u.searchParams.get('bid')])).toEqual([['1', '50.00'], ['1', '55.00']]);
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 3 });
    // the hook, the sweep and a retry send nothing twice
    expect(await notify.notifyLotsOpened(show.id)).toBe(0);
    expect(bodiesTo(chatId)).toHaveLength(1);
    // never a bid from here, never anything but messages
    expect((await e.pool.query(`select count(*)::int n from bids`)).rows[0].n).toBe(bidsBefore);
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['sendMessage']));
  });

  it_('the next valid bid follows the bids (the buttons name the minimum and +10 percent, rounded up to the cent)', async (e) => {
    const { show, ids } = await liveShow(e, 2);
    const a = await e.profile(); const b = await e.profile();
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, show.id, 2);
    await e.pool.query(`update lots set increment=$2 where id=$1`, [ids[0], (333_333n).toString()]); // 0.333333 USDC
    await openLot(e, ids[0]);
    await e.pool.query(`update lots set high_bid=$2, high_bidder_id=$3, bid_count=1 where id=$1`, [ids[0], (50n * USDC).toString(), b.id]);
    calls = [];
    await notify.notifyLotsOpened(show.id);
    const row = bodiesTo(chatId)[0].reply_markup.inline_keyboard[0] as Record<string, string>[];
    // minimum 50.333333 -> 50.34 (never below the minimum), +10 % = 55.3666663 -> 55.37
    expect(row.map((x) => new URL(x.url).searchParams.get('bid'))).toEqual(['50.34', '55.37']);
  });

  it_('German chat: German text and button labels, same links', async (e) => {
    const { show, ids } = await liveShow(e, 2);
    const a = await e.profile();
    const chatId = await linked(e, a, { prefs: ON, locale: 'de' });
    await watch(e, a, show.id, null);
    await openLot(e, ids[0]);
    calls = [];
    await notify.notifyLotsOpened(show.id);
    const m = bodiesTo(chatId)[0];
    expect(m.text).toMatch(/^Los 1 ist offen in Test show: Charizard 1st Edition \(PSA 10\)\.\nStartpreis 50\.00 USDC, noch etwa 1 Min\./);
    expect(m.text).toMatch(/Es wird nie für Sie geboten/);
    expect(m.text).toMatch(/\/unwatch beendet diese Hinweise\./);
    expect((m.reply_markup.inline_keyboard[0] as { text: string; url: string }[]).map((b) => b.text)).toEqual(['50.00 USDC bieten', '55.00 USDC bieten (+10 %)']);
    expect(m.reply_markup.inline_keyboard[0][0].url).toContain(`/de/room/${show.id}?lot=1&bid=50.00`);
  });

  it_('counts down per lot, and the watch is gone after its last alert', async (e) => {
    const { show, ids } = await liveShow(e);
    const a = await e.profile();
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, show.id, 2);
    await openLot(e, ids[0]);
    expect(await notify.notifyLotsOpened(show.id)).toBe(1);
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 1 });
    await closeLot(e, ids[0]); await openLot(e, ids[1]);
    expect(await notify.notifyLotsOpened(show.id)).toBe(1);
    expect(await remainingOf(e, a, show.id)).toBeUndefined();
    await closeLot(e, ids[1]); await openLot(e, ids[2]);
    expect(await notify.notifyLotsOpened(show.id)).toBe(0);
    expect(sentTo(chatId)).toHaveLength(2);
    expect(sentTo(chatId)[0]).toMatch(/1 more alerts/);
    expect(sentTo(chatId)[1]).toMatch(/Lot 2 is open/);
  });

  it_('only lots that open after the watch started, only for people who switched lot alerts on', async (e) => {
    const { show, ids } = await liveShow(e);
    const a = await e.profile(); const off = await e.profile();
    const chatA = await linked(e, a, { prefs: ON });
    const chatOff = await linked(e, off, { prefs: { lot_watch: false } });
    const tick = () => new Promise((r) => setTimeout(r, 25)); // timestamps are compared to the millisecond
    await openLot(e, ids[0]); // open before anyone watched
    await tick();
    await e.pool.query(`insert into telegram_watches (profile_id, show_id, remaining) values ($1,$3,5), ($2,$3,5)`, [a.id, off.id, show.id]);
    await tick();
    expect(await notify.notifyLotsOpened(show.id)).toBe(0); // lot 1 was already open: not "upcoming"
    await closeLot(e, ids[0]); await openLot(e, ids[1]);
    expect(await notify.notifyLotsOpened(show.id)).toBe(1);
    expect(sentTo(chatA)).toHaveLength(1);
    expect(sentTo(chatOff)).toEqual([]);
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1`, [off.id])).rows[0].n).toBe(0); // nothing claimed for the person who has it off
    expect(await remainingOf(e, off, show.id)).toEqual({ remaining: 5 });
  });

  it_('a burst (a late pass after several lots opened) is collapsed into ONE message, with the buttons of the lot that is still open', async (e) => {
    const { show, ids } = await liveShow(e, 5);
    const a = await e.profile();
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, show.id, 10);
    for (const id of ids.slice(0, 3)) { await openLot(e, id); await closeLot(e, id); }
    await openLot(e, ids[3]);
    calls = [];
    expect(await notify.notifyLotsOpened(show.id)).toBe(1);
    const msgs = bodiesTo(chatId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/^4 lots opened in Test show:/);
    expect(msgs[0].text).toMatch(/Lot 1: Charizard 1st Edition, from 50\.00 USDC\nLot 2: Lot 2, from 50\.00 USDC\nLot 3: Lot 3, from 50\.00 USDC\nLot 4: Lot 4, from 50\.00 USDC/);
    expect((msgs[0].reply_markup.inline_keyboard[0] as { url: string }[]).map((b) => new URL(b.url).searchParams.get('lot'))).toEqual(['4', '4']);
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 6 }); // four lots used up four alerts
    expect(await notify.notifyLotsOpened(show.id)).toBe(0);
  });

  it_('over the per-chat limit nothing is claimed and the count does not move; a later pass sends it', async (e) => {
    const { show, ids } = await liveShow(e, 2);
    const a = await e.profile();
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, show.id, 3);
    const l = (await links.getLink(a.id))!;
    const ctx = (await notify.context())!;
    for (let i = 0; i < notify.CHAT_LIMIT_PER_MIN; i++) await notify.deliver(ctx, l, 'outbid', `x${i}`, () => ({ text: `m${i}` }));
    await openLot(e, ids[0]);
    calls = [];
    expect(await notify.notifyLotsOpened(show.id)).toBe(0);
    expect(sentTo(chatId)).toEqual([]);
    expect((await e.pool.query(`select count(*)::int n from telegram_sent where profile_id=$1 and kind='lot_watch'`, [a.id])).rows[0].n).toBe(0);
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 3 });
    await e.pool.query('delete from rate_limits');
    expect(await notify.notifyLotsOpened(show.id)).toBe(1);
    expect(await remainingOf(e, a, show.id)).toEqual({ remaining: 2 });
  });

  it_('advanceShow opens the lot and the hook alerts the watcher; a failing Telegram never breaks the show', async (e) => {
    const seller = await e.profile();
    const a = await e.profile();
    const s = await e.show({ sellerId: seller.id, status: 'scheduled', rules: { lotDurationS: 60 }, lots: [{}, {}] });
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, s.id, 2);
    await e.svc.startShow(s.id, { profileId: seller.id, wallet: seller.wallet });
    await hooks.settled();
    expect((await e.lot((await lotsOf(e, s.id))[0])).state).toBe('open');
    expect(sentTo(chatId).filter((m) => /^Lot 1 is open/.test(m))).toHaveLength(1);
    // Telegram answers 500: the lot still opens next, nothing is claimed
    failFor.set(chatId, { status: 500, description: 'boom' });
    const later = new Date(Date.now() + 10 * 60_000); // the first lot is over and the gap has passed
    await e.svc.advanceShow(s.id, later);
    await e.svc.advanceShow(s.id, later);
    await hooks.settled();
    expect((await e.lot((await lotsOf(e, s.id))[1])).state).toBe('open');
    expect(await remainingOf(e, a, s.id)).toEqual({ remaining: 1 });
  });

  it_('the show-start message carries a "Watch this room" button, and pressing it asks how many', async (e) => {
    const { show } = await liveShow(e, 2);
    const a = await e.profile();
    await e.paddle(show.id, a.id);
    const chatId = await linked(e, a);
    await e.pool.query(`update shows set started_at = now() where id=$1`, [show.id]);
    calls = [];
    expect(await notify.notifyShowStarted(show.id)).toBe(1);
    const m = bodiesTo(chatId)[0];
    expect(m.text).toMatch(/tap Watch this room\./);
    expect(m.reply_markup.inline_keyboard).toEqual([[{ text: 'Watch this room', callback_data: `w|p|${show.id}` }]]);
    calls = [];
    await webhook(press(chatId, `w|p|${show.id}`));
    expect(bodiesTo(chatId)[0].text).toMatch(/How many of the next lots/);
  });

  it_('a button for a room that is over or does not exist, from an unlinked chat, or with tampered data does nothing', async (e) => {
    const { show } = await liveShow(e, 1);
    const a = await e.profile();
    const chatId = await linked(e, a);
    calls = [];
    await webhook(press(chatId, `w|5|${randomUUID()}`));
    expect(answers()).toEqual(['This room is over or not available. Send /watch to pick another.']);
    const stranger = newChat();
    await webhook(press(stranger, `w|5|${show.id}`));
    expect(answers()[1]).toMatch(/Connect this chat/);
    await webhook(press(chatId, `w|7|${show.id}`)); // not an offered count: not a watch button at all
    await webhook(press(chatId, `w|5|${show.id}x`));
    expect((await e.pool.query(`select count(*)::int n from telegram_watches where show_id=$1`, [show.id])).rows[0].n).toBe(0);
    // another person's chat id in the button cannot start a watch for them: the press carries its own chat
    const other = await e.profile(); const otherChat = await linked(e, other);
    await webhook({ update_id: 1, callback_query: { id: 'x', from: { id: chatId, language_code: 'en' }, data: `w|5|${show.id}`, message: { message_id: 1, chat: { id: otherChat, type: 'private' } } } });
    expect((await e.pool.query(`select count(*)::int n from telegram_watches where show_id=$1`, [show.id])).rows[0].n).toBe(0);
  });

  it_('when the show ends the watchers hear it once and the watches go; /unwatch and the switch end them too', async (e) => {
    const { show, seller } = await liveShow(e, 2);
    const a = await e.profile(); const b = await e.profile(); const c = await person(e);
    const chatA = await linked(e, a, { prefs: ON }); const chatB = await linked(e, b, { prefs: ON }); await linked(e, c, { prefs: ON });
    for (const p of [a, b, c]) await watch(e, p, show.id, null);
    // /unwatch
    await webhook(text(chatB, '/unwatch'));
    expect(sentTo(chatB)[0]).toBe('Stopped. You get no more lot alerts.');
    await webhook(text(chatB, '/unwatch'));
    expect(sentTo(chatB)[1]).toBe('You were not watching a room.');
    // the switch on the account page
    expect((await call('PATCH', c, { prefs: { lot_watch: false } })).status).toBe(200);
    expect(await remainingOf(e, c, show.id)).toBeUndefined();
    // the show ends (the seller ends it through the service, which calls the hook)
    calls = [];
    await e.svc.endShow(show.id, { profileId: seller.id, wallet: seller.wallet });
    await hooks.settled();
    expect(sentTo(chatA)).toEqual(['Test show has ended. The lot alerts for it stopped.']);
    expect(await remainingOf(e, a, show.id)).toBeUndefined();
    expect(await notify.notifyWatchEnded(show.id)).toBe(0);
    expect(sentTo(chatA)).toHaveLength(1);
  });

  it_('/status lists the watched rooms; unlinking, /stop and a blocked bot remove the watches', async (e) => {
    const { show } = await liveShow(e, 2);
    const a = await e.profile(); const b = await e.profile();
    const chatA = await linked(e, a, { prefs: ON }); const chatB = await linked(e, b, { prefs: ON });
    await watch(e, a, show.id, 4); await watch(e, b, show.id, null);
    await webhook(text(chatA, '/status'));
    expect(sentTo(chatA)[0]).toBe('Watching\nTest show: 4 alerts left');
    await webhook(text(chatA, '/stop'));
    expect(await remainingOf(e, a, show.id)).toBeUndefined();
    failFor.set(chatB, { status: 403, description: 'Forbidden: bot was blocked by the user' });
    const lot = (await lotsOf(e, show.id))[0];
    await openLot(e, lot);
    await notify.notifyLotsOpened(show.id);
    expect(await remainingOf(e, b, show.id)).toBeUndefined();
  });

  it_('the daily sweep sends what the hook missed and ends the watches of finished shows', async (e) => {
    const { show, ids } = await liveShow(e, 2);
    const a = await e.profile();
    const chatId = await linked(e, a, { prefs: ON });
    await watch(e, a, show.id, 3);
    await openLot(e, ids[0]);
    calls = [];
    const r = await sweep.sweepTelegram();
    expect(r.lotWatch).toBeGreaterThanOrEqual(1);
    expect(sentTo(chatId)).toHaveLength(1);
    await e.pool.query(`update shows set status='ended', ended_at=now() where id=$1`, [show.id]);
    await sweep.sweepTelegram();
    expect(sentTo(chatId)[1]).toBe('Test show has ended. The lot alerts for it stopped.');
    expect(await remainingOf(e, a, show.id)).toBeUndefined();
  });

  it_('with no live and no scheduled room /watch says so (runs last: it ends every show)', async (e) => {
    const a = await e.profile();
    const chatId = await linked(e, a);
    await e.pool.query(`update shows set status='ended' where status <> 'ended'`);
    calls = [];
    await webhook(text(chatId, '/watch'));
    expect(sentTo(chatId)).toEqual(['There is no live room and no scheduled room to watch right now. Send /watch again when a show starts.']);
  });
});
