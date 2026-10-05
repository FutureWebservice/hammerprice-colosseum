/**
 * The Telegram panel rendered with the real message files in both languages (a missing key throws), its states, and the wrappers of the link routes.
 * There is no DOM library in this repo, so states are rendered to markup and asserted on data-testid attributes, like the other component tests.
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { ROUTES, DEFAULT_TELEGRAM_PREFS, TELEGRAM_TYPES } from '@/contracts';
import de from '@/locales/de/telegram.json';
import en from '@/locales/en/telegram.json';
import { stubFetch, unstub } from '../../sell/__tests__/fetchStub';
import { TELEGRAM_LINK_PATH, getTelegramStatus, startTelegramLink, unlinkTelegram, updateTelegramLink } from '../api';
import { TelegramView, type ViewProps } from '../TelegramPanel';

(globalThis as { React?: unknown }).React = React;
afterEach(unstub);

const MESSAGES = { de, en } as const;
const view = (locale: 'de' | 'en', over: Partial<ViewProps> = {}) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={{ telegram: MESSAGES[locale] }} timeZone="Europe/Berlin" onError={(e) => { throw e; }} getMessageFallback={({ key }) => { throw new Error(`missing message ${key}`); }}>
    <TelegramView
      status={{ enabled: true, linked: false, locale: null, prefs: DEFAULT_TELEGRAM_PREFS, botUsername: 'HammerpriceTestBot' }}
      prefs={DEFAULT_TELEGRAM_PREFS} pending={null} busy={false} note={null} onToggle={() => {}} onConnect={() => {}} onDisconnect={() => {}} {...over}
    />
  </NextIntlClientProvider>,
);
const has = (m: string, id: string) => new RegExp(`data-testid="${id}"`).test(m);

describe('the panel in both languages', () => {
  it.each(['en', 'de'] as const)('%s: not connected shows every opt-in choice, Connect, and the privacy sentence', (l) => {
    const m = view(l);
    for (const k of TELEGRAM_TYPES) expect(has(m, `telegram-type-${k}`), k).toBe(true);
    expect(has(m, 'telegram-connect')).toBe(true);
    expect(has(m, 'telegram-disconnect')).toBe(false);
    expect(has(m, 'telegram-connected')).toBe(false);
    expect(m).toContain(MESSAGES[l].ui.title);
    expect(m).toContain(MESSAGES[l].ui.privacy);
    expect(m).toContain('id="telegram"'); // the #telegram anchor the bot's links point to
    expect(m).toContain('tabindex="-1"'); // focusable by script: the link ?telegram=open moves focus here
  });

  it.each(['en', 'de'] as const)('%s: only the checked switches are checked (opt-in)', (l) => {
    const m = view(l, { prefs: { ...DEFAULT_TELEGRAM_PREFS, won: false, show_start: true } });
    const checked = (k: string) => /checked=""/.test(new RegExp(`<input[^>]*data-testid="telegram-type-${k}"[^>]*>`).exec(m)?.[0] ?? '');
    expect(checked('outbid')).toBe(true);
    expect(checked('won')).toBe(false);
    expect(checked('show_start')).toBe(true);
    expect(checked('moderation')).toBe(false);
  });

  it.each(['en', 'de'] as const)('%s: a pending link shows Open Telegram with the deep link and the waiting text, and locks the choices', (l) => {
    const m = view(l, { pending: { url: 'https://t.me/HammerpriceTestBot?start=abc', expiresAt: Date.now() + 600_000 } });
    expect(m).toMatch(/<a[^>]*href="https:\/\/t\.me\/HammerpriceTestBot\?start=abc"[^>]*data-testid="telegram-open"|<a[^>]*data-testid="telegram-open"[^>]*href="https:\/\/t\.me\/HammerpriceTestBot\?start=abc"/);
    expect(m).toContain('rel="noopener noreferrer"');
    expect(m).toContain(MESSAGES[l].ui.waiting);
    expect(has(m, 'telegram-connect')).toBe(false);
    expect(m).toMatch(/<fieldset[^>]*disabled/);
  });

  it.each(['en', 'de'] as const)('%s: connected shows the bot name, Disconnect and the /stop hint', (l) => {
    const m = view(l, { status: { enabled: true, linked: true, locale: l, prefs: DEFAULT_TELEGRAM_PREFS, botUsername: 'HammerpriceTestBot' } });
    expect(has(m, 'telegram-connected')).toBe(true);
    expect(m).toContain('@HammerpriceTestBot');
    expect(has(m, 'telegram-disconnect')).toBe(true);
    expect(has(m, 'telegram-connect')).toBe(false);
    expect(m).toContain(MESSAGES[l].ui.stopHint);
  });

  it.each(['en', 'de'] as const)('%s: every note renders in the live region', (l) => {
    for (const note of ['saved', 'error', 'rateLimited', 'expired'] as const) {
      const m = view(l, { note });
      expect(m).toContain(MESSAGES[l].ui[note]);
      expect(m).toContain('aria-live="polite"');
    }
  });

  it('busy disables the button', () => {
    expect(view('en', { busy: true })).toMatch(/<button[^>]*data-testid="telegram-connect"[^>]*disabled|<button[^>]*disabled[^>]*data-testid="telegram-connect"/);
  });
});

describe('the link route wrappers', () => {
  it('use the path of the contract and the right methods', async () => {
    for (const k of ['telegramStatus', 'telegramLink', 'telegramUpdate', 'telegramUnlink'] as const) expect(ROUTES[k].path).toBe(TELEGRAM_LINK_PATH);
    expect([ROUTES.telegramStatus.method, ROUTES.telegramLink.method, ROUTES.telegramUpdate.method, ROUTES.telegramUnlink.method]).toEqual(['GET', 'POST', 'PATCH', 'DELETE']);
    const calls = stubFetch({
      [`GET ${TELEGRAM_LINK_PATH}`]: { body: { linked: false } },
      [`POST ${TELEGRAM_LINK_PATH}`]: { body: { url: 'https://t.me/x?start=y', expiresAt: '2026-10-05T18:10:00.000Z' } },
      [`PATCH ${TELEGRAM_LINK_PATH}`]: { body: { linked: true } },
      [`DELETE ${TELEGRAM_LINK_PATH}`]: { status: 204 },
    });
    await getTelegramStatus();
    await startTelegramLink({ locale: 'de', prefs: { won: true } });
    await updateTelegramLink({ prefs: { won: false } });
    expect((await unlinkTelegram()).ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${TELEGRAM_LINK_PATH}`, `POST ${TELEGRAM_LINK_PATH}`, `PATCH ${TELEGRAM_LINK_PATH}`, `DELETE ${TELEGRAM_LINK_PATH}`]);
    expect(calls[1].body).toEqual({ locale: 'de', prefs: { won: true } });
  });

  it('a switched-off feature answers a plain 200 with enabled false (the panel shows nothing, the console stays clean); the other methods answer 404', async () => {
    stubFetch({
      [`GET ${TELEGRAM_LINK_PATH}`]: { body: { enabled: false, linked: false, linkedAt: null, locale: null, prefs: DEFAULT_TELEGRAM_PREFS, botUsername: '' } },
      [`POST ${TELEGRAM_LINK_PATH}`]: { status: 404, body: { ok: false, code: 'feature_off', reason: 'Telegram is not available here.' } },
    });
    expect(await getTelegramStatus()).toMatchObject({ ok: true, data: { enabled: false } });
    expect(await startTelegramLink({})).toMatchObject({ ok: false, status: 404, code: 'feature_off' });
  });
});
