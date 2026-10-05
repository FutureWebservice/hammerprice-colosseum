/**
 * The pure parts of the Telegram package, no database and no network: the configuration gate, the signed callback data, the webhook header check, the
 * Bot API client against a mocked fetch (and that a token never reaches an error), the words in both languages, the contract, the registry and the
 * house style of every file of the package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ROUTES, TelegramLinkRequest, TelegramPrefs, TelegramUpdateRequest, TELEGRAM_TYPES, DEFAULT_TELEGRAM_PREFS } from '@/contracts';
import en from '@/locales/en/telegram.json';
import de from '@/locales/de/telegram.json';
import { createBotApi, TELEGRAM_API } from '../api';
import { botConfig, deepLink } from '../config';
import { signCallback, verifyCallback, secretMatches } from '../callback';
import { accountLink, bidLink, localeFromTelegram, minutesLeft, payLink, receiptLink, roomLink, t, usdc, usdcCeil, when } from '../copy';
import { WATCH_BUTTON_COUNTS, parseWatchArg, parseWatchCallback, watchCallback } from '../watch';
import { hashToken, mergePrefs, parsePrefs } from '../links';

const TOKEN = '123456789:AAE_fake_token_value_0123456789abcdefghij';
const SECRET = 'unit-integration-secret-webhook-0123456789';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_BOT_USERNAME: 'HammerpriceTestBot', TELEGRAM_WEBHOOK_SECRET: SECRET };
const MSG = '8f2c1a52-3b7e-4d0a-9c11-5a6f0e7d1b22';

describe('configuration: all three names, well formed, or the feature is off', () => {
  it('accepts a complete environment and strips the @ of the username', () => {
    expect(botConfig(ENV)).toEqual({ token: TOKEN, username: 'HammerpriceTestBot', webhookSecret: SECRET });
    expect(botConfig({ ...ENV, TELEGRAM_BOT_USERNAME: '@HammerpriceTestBot' })?.username).toBe('HammerpriceTestBot');
  });
  it('is null when any name is missing or malformed (never half on)', () => {
    expect(botConfig({})).toBeNull();
    for (const k of Object.keys(ENV)) expect(botConfig({ ...ENV, [k]: '' }), k).toBeNull();
    expect(botConfig({ ...ENV, TELEGRAM_BOT_TOKEN: 'not-a-token' })).toBeNull();
    expect(botConfig({ ...ENV, TELEGRAM_BOT_TOKEN: `${TOKEN} # comment` })).toBeNull();
    expect(botConfig({ ...ENV, TELEGRAM_WEBHOOK_SECRET: 'short' })).toBeNull();
    expect(botConfig({ ...ENV, TELEGRAM_WEBHOOK_SECRET: `${SECRET} ` })).toBeNull();
    expect(botConfig({ ...ENV, TELEGRAM_BOT_USERNAME: 'bad name' })).toBeNull();
  });
  it('builds the t.me deep link from the username and the token', () => {
    expect(deepLink('HammerpriceTestBot', 'abc_DEF-123')).toBe('https://t.me/HammerpriceTestBot?start=abc_DEF-123');
  });
});

describe('signed callback data', () => {
  it('is at most 64 bytes (Telegram limit), 39 here, and verifies for the chat it was made for', () => {
    const data = signCallback(SECRET, 'approve', MSG, 4242);
    expect(data).toHaveLength(39);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(verifyCallback(SECRET, data, 4242)).toEqual({ action: 'approve', messageId: MSG });
    for (const action of ['approve', 'reject', 'mute'] as const) expect(verifyCallback(SECRET, signCallback(SECRET, action, MSG, 4242), 4242)?.action).toBe(action);
  });
  it('is refused from another chat, for another message or action, with another secret, or tampered with', () => {
    const data = signCallback(SECRET, 'approve', MSG, 4242);
    expect(verifyCallback(SECRET, data, 4243)).toBeNull();
    expect(verifyCallback('another-secret-another-secret-123', data, 4242)).toBeNull();
    expect(verifyCallback(SECRET, `r${data.slice(1)}`, 4242)).toBeNull(); // approve button relabelled reject
    expect(verifyCallback(SECRET, data.slice(0, 22) + (data[22] === 'A' ? 'B' : 'A') + data.slice(23), 4242)).toBeNull();
    expect(verifyCallback(SECRET, `${data.slice(0, 5)}${data[5] === 'A' ? 'B' : 'A'}${data.slice(6)}`, 4242)).toBeNull(); // another message id
    expect(verifyCallback(SECRET, undefined, 4242)).toBeNull();
    expect(verifyCallback(SECRET, '', 4242)).toBeNull();
    expect(verifyCallback(SECRET, 'x'.repeat(39), 4242)).toBeNull();
    expect(verifyCallback(SECRET, `${data}0`, 4242)).toBeNull();
  });
  it('refuses to sign something that is not a message id', () => {
    expect(() => signCallback(SECRET, 'approve', 'nope', 1)).toThrow();
  });
});

describe('the webhook header', () => {
  it('matches only the exact secret, never an empty one', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretMatches(null, SECRET)).toBe(false);
    expect(secretMatches('', SECRET)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches('anything', '')).toBe(false);
  });
});

describe('the Bot API client (mocked fetch)', () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const api = (f: ReturnType<typeof reply>) => createBotApi({ token: TOKEN }, f as unknown as typeof fetch);

  it('posts JSON as plain text (no parse_mode) with no link preview', async () => {
    const f = reply(200, { ok: true, result: { message_id: 7 } });
    const r = await api(f).sendMessage(55, 'hello <b>x</b>', { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] });
    expect(r).toEqual({ ok: true, result: { message_id: 7 } });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${TELEGRAM_API}/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ chat_id: 55, text: 'hello <b>x</b>', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] } });
    expect(body.parse_mode).toBeUndefined();
  });
  it('403 is "blocked" (the caller unlinks), 429 carries retry_after, anything else is a plain failure', async () => {
    expect(await api(reply(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' })).sendMessage(1, 'x')).toMatchObject({ ok: false, blocked: true, status: 403 });
    expect(await api(reply(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } })).sendMessage(1, 'x')).toMatchObject({ ok: false, blocked: false, retryAfterS: 7 });
    expect(await api(reply(500, 'not json')).sendMessage(1, 'x')).toMatchObject({ ok: false, blocked: false, status: 500 });
  });
  it('a network error never carries the URL (and so never the token)', async () => {
    const boom = vi.fn(async () => { throw new TypeError(`fetch failed for ${TELEGRAM_API}/bot${TOKEN}/sendMessage`); });
    const r = await api(boom as never).sendMessage(1, 'x');
    expect(r).toEqual({ ok: false, status: 0, blocked: false, description: 'network error' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
  it('edit and answer calls are shaped for Telegram, and an edit without markup removes the buttons', async () => {
    const f = reply(200, { ok: true, result: true });
    await api(f).editMessageText(9, 3, 'done');
    await api(f).answerCallbackQuery('cbid', 'ok');
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toMatchObject({ chat_id: 9, message_id: 3, text: 'done', reply_markup: { inline_keyboard: [] } });
    expect(JSON.parse(String((f.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ callback_query_id: 'cbid', text: 'ok' });
  });
});

describe('words, in German and English', () => {
  it('picks the language from Telegram, German for de and de-AT, English otherwise', () => {
    expect([localeFromTelegram('de'), localeFromTelegram('de-AT'), localeFromTelegram('en'), localeFromTelegram('fr'), localeFromTelegram(undefined)]).toEqual(['de', 'de', 'en', 'en', 'en']);
  });
  it('fills {placeholders} and leaves an unknown one visible instead of inventing text', () => {
    expect(t('en', 'outbid', { lot: 'Charizard', amount: '60.00', link: 'L' })).toBe('You were outbid on Charizard. The highest bid is now 60.00 USDC.\nBid again: L');
    expect(t('de', 'outbid', { lot: 'Glurak', amount: '60.00', link: 'L' })).toContain('überboten');
    expect(t('en', 'won', { lot: 'x' })).toContain('{amount}');
  });
  it('formats USDC in cents and a deadline in UTC in the reader\'s style', () => {
    expect(usdc(120_000_000n)).toBe('120.00');
    expect(usdc('5500000')).toBe('5.50');
    expect(usdc(0n)).toBe('0.00');
    expect(usdc(1_234_567n)).toBe('1.23');
    const at = new Date('2026-10-05T18:30:00Z');
    expect(when(at, 'en')).toBe('10/05/2026, 18:30 UTC');
    expect(when(at, 'de')).toBe('05.10.2026, 18:30 UTC');
  });
  it('links are absolute and carry the language', () => {
    expect(roomLink('de', 'S1')).toMatch(/^https:\/\/[^/]+\/de\/room\/S1$/);
    expect(payLink('en', 'S1', 'T1', 'L1')).toMatch(/\/en\/room\/S1\?settle=T1$/);
    expect(payLink('en', null, 'T1', 'L1')).toMatch(/\/en\/verify\/L1$/);
    expect(accountLink('en')).toMatch(/\/en\/account\?telegram=open#telegram$/);
    expect(accountLink('de')).toMatch(/\/de\/account\?telegram=open#telegram$/);
  });
  it('the receipt link follows the cluster of the settlement, no hardcoded cluster', async () => {
    const dev = await receiptLink('SIG', 'devnet');
    const main = await receiptLink('SIG', 'mainnet-beta');
    expect(dev).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet');
    expect(main).toBe('https://explorer.solana.com/tx/SIG');
  });
  it('German and English have the same keys and the same placeholders (the bot block and the ui block)', () => {
    const leaves = (o: unknown, p = ''): [string, string][] => (typeof o === 'string' ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k)));
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const d = new Map(leaves(de)), e = new Map(leaves(en));
    expect([...d.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of d) expect(ph(v), k).toBe(ph(e.get(k)!));
    for (const [k, v] of [...d, ...e]) { expect(v, k).not.toMatch(/[\u2014\u2013]/); expect(v.trim().length, k).toBeGreaterThan(0); }
    for (const [k, v] of d) expect(v, k).not.toMatch(/\b(du|dein|deine|deinen|dir|dich)\b/i);
  });
});

describe('contract and registry', () => {
  it('has nine opt-in types and the defaults switch on only the messages about your own money', () => {
    expect([...TELEGRAM_TYPES]).toEqual(['outbid', 'ending_soon', 'won', 'settled', 'show_start', 'deadline', 'moderation', 'pack_delivery', 'lot_watch']);
    expect(TelegramPrefs.parse(DEFAULT_TELEGRAM_PREFS)).toEqual(DEFAULT_TELEGRAM_PREFS);
    expect(DEFAULT_TELEGRAM_PREFS).toMatchObject({ outbid: true, won: true, settled: true, deadline: true, ending_soon: false, show_start: false, moderation: false, pack_delivery: true, lot_watch: false });
  });
  it('parses stored preferences as opt-in: a missing or odd key is off', () => {
    expect(parsePrefs(null)).toEqual(Object.fromEntries(TELEGRAM_TYPES.map((k) => [k, false])));
    expect(parsePrefs({ outbid: 'yes', won: true, bogus: true })).toMatchObject({ outbid: false, won: true });
    expect(mergePrefs(DEFAULT_TELEGRAM_PREFS, { outbid: false, moderation: true })).toMatchObject({ outbid: false, moderation: true, won: true });
  });
  it('requests are strict', () => {
    expect(TelegramLinkRequest.safeParse({}).success).toBe(true);
    expect(TelegramLinkRequest.safeParse({ locale: 'fr' }).success).toBe(false);
    expect(TelegramLinkRequest.safeParse({ prefs: { outbid: true, nope: true } }).success).toBe(false);
    expect(TelegramUpdateRequest.safeParse({}).success).toBe(false);
    expect(TelegramUpdateRequest.safeParse({ prefs: {} }).success).toBe(false);
    expect(TelegramUpdateRequest.safeParse({ prefs: { won: false } }).success).toBe(true);
    expect(TelegramUpdateRequest.safeParse({ locale: 'de' }).success).toBe(true);
  });
  it('registers the routes under TELEGRAM, session for the link, the webhook secret for the webhook', () => {
    const mine = Object.values(ROUTES).filter((r) => r.agent === 'TELEGRAM').map((r) => `${r.method} ${r.path} ${r.auth}`).sort();
    expect(mine).toEqual([
      'DELETE /api/telegram/link session', 'GET /api/telegram/link session', 'PATCH /api/telegram/link session', 'POST /api/telegram/link session', 'POST /api/telegram/webhook webhook',
    ]);
    // the status read answers `enabled: false` while off (a plain 200); every other route answers feature_off
    for (const [k, r] of Object.entries(ROUTES).filter(([, x]) => x.agent === 'TELEGRAM')) { if (k === 'telegramStatus') expect(r.errors).toEqual([]); else expect(r.errors, r.path).toContain('feature_off'); }
  });
  it('hashes a token with sha-256 hex (only the hash is stored)', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('house style and secrecy of the package', () => {
  const root = path.resolve(__dirname, '../../../..');
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '__tests__' ? [] : e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const mine = [...files(path.join(root, 'src/server/telegram')), ...files(path.join(root, 'src/components/telegram')), ...files(path.join(root, 'src/app/api/telegram')), path.join(root, 'scripts/ops/telegram-set-webhook.mjs'), path.join(root, 'docs/features/telegram.md'), path.join(root, 'docs/features/telegram-legal-snippets.md'), path.join(root, 'src/locales/en/telegram.json'), path.join(root, 'src/locales/de/telegram.json'), path.join(root, 'drizzle/0004_telegram.sql'), path.join(root, 'drizzle/0008_telegram_watch.sql')].filter((f) => fs.existsSync(f));
  it('has no em dash anywhere (code, copy, docs)', () => {
    expect(mine.length).toBeGreaterThan(10);
    for (const f of mine) expect(fs.readFileSync(f, 'utf8'), f).not.toContain('\u2014');
  });
  it('never puts the token, the secret or an error object into a log line, and sends plain text only', () => {
    for (const f of mine.filter((x) => x.endsWith('.ts') || x.endsWith('.tsx'))) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/console\.(error|warn|log|info)\(([^)]*)\)/g)) {
        expect(m[2], `${path.relative(root, f)}: ${m[0]}`).not.toMatch(/token|secret|cfg\b|\bapi\b|\be\)\s*$/i);
        expect(m[2], `${path.relative(root, f)}: ${m[0]}`).not.toMatch(/,\s*e\s*$/); // never the error object itself
      }
      expect(src, f).not.toMatch(/parse_mode\s*[:=]/);
    }
  });
  it('spells no cluster, mint, RPC host or explorer host in feature code', () => {
    for (const f of mine.filter((x) => /\.(ts|tsx)$/.test(x))) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/explorer\.solana\.com|api\.(devnet|mainnet-beta)\.solana\.com|EPjFWdd5|4zMMC9sr|cluster=devnet|'devnet'|'mainnet-beta'/);
    }
  });
});

describe('watch a room: the pure rules', () => {
  const SHOW = '8f2c1a52-3b7e-4d0a-9c11-5a6f0e7d1b22';
  it('/watch arguments: nothing asks, 1 to 50 or all starts, everything else is refused', () => {
    expect(parseWatchArg('')).toBeUndefined();
    expect(parseWatchArg('  ')).toBeUndefined();
    expect(parseWatchArg('all')).toBeNull();
    expect(parseWatchArg('ALLE')).toBeNull();
    expect(parseWatchArg('5')).toBe(5);
    expect(parseWatchArg('50')).toBe(50);
    for (const bad of ['0', '51', '-1', '2.5', 'five', '5 6', '1e2', '0x5', '999', '<b>']) expect(parseWatchArg(bad), bad).toBe(false);
  });
  it('the button data round-trips, fits Telegram\'s 64 characters, and anything else is not a watch button', () => {
    for (const step of ['p', 3, 5, 10, null] as const) {
      const data = watchCallback(step, SHOW);
      expect(data.length).toBeLessThanOrEqual(64);
      expect(parseWatchCallback(data)).toEqual(step === 'p' ? { step: 'pick', showId: SHOW } : { step: 'set', count: step, showId: SHOW });
    }
    expect(WATCH_BUTTON_COUNTS).toEqual([3, 5, 10]);
    for (const bad of [undefined, '', 'w|7|' + SHOW, 'w|5|nope', `w|5|${SHOW}x`, `x|5|${SHOW}`, `w|5|${SHOW.toUpperCase()}`, signCallback(SECRET, 'approve', MSG, 1)]) expect(parseWatchCallback(bad), String(bad)).toBeNull();
  });
  it('a bid amount in a link is rounded UP to the cent and never below the minimum', () => {
    expect(usdcCeil(50_000_000n)).toBe('50.00');
    expect(usdcCeil(50_000_001n)).toBe('50.01');
    expect(usdcCeil(50_333_333n)).toBe('50.34');
    expect(usdcCeil(9_999n)).toBe('0.01');
    expect(usdcCeil(0n)).toBe('0.00');
    expect(minutesLeft(1)).toBe(1);
    expect(minutesLeft(61_000)).toBe(2);
  });
  it('the bid link is /<lang>/room/<show>?lot=<n>&bid=<amount>', () => {
    expect(bidLink('de', SHOW, 7, '55.00')).toMatch(new RegExp(`^https://[^/]+/de/room/${SHOW}\\?lot=7&bid=55\\.00$`));
  });
  it('every lot alert text says in both languages that nothing is bid for you, and the help and the picker say it too', () => {
    for (const [l, words] of [['en', /Nothing is bid for you|never bids for you|Nothing is ever bid for you/], ['de', /nie für Sie geboten|bietet nie für Sie/]] as const) {
      for (const k of ['lotNote', 'watchAsk', 'watchOn', 'watchOnAll', 'help'] as const) expect(t(l, k), `${l}.${k}`).toMatch(words);
    }
    expect(t('en', 'lotNote')).toMatch(/confirm and sign in your own wallet/);
    expect(t('de', 'lotNote')).toMatch(/in Ihrer eigenen Wallet/);
  });
  it('the Telegram package never places, signs or registers anything for a person: no import of the auction service or a bid call', () => {
    const dir = path.resolve(__dirname, '..');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/@\/server\/auction|\bplaceBid\b|\bregisterPaddle\b|\bbuyNow\b|signTransaction|signMessage|secretKey|privateKey/);
    }
  });
});
