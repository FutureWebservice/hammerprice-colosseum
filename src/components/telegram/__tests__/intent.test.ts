/**
 * The Telegram step link: ?telegram=open (and the old #telegram), what the panel does with it (scroll, focus, highlight, reduced motion) and that every
 * text the bot sends with the account link carries the parameter. No DOM library here, so the element is a small fake that records the calls.
 */
import { describe, expect, it } from 'vitest';
import { accountLink, t, type BotKey } from '@/server/telegram/copy';
import { FLASH_CLASS, FLASH_MS, applyTelegramIntent, wantsTelegram, withoutIntent, type IntentEl } from '../intent';

function fakeRoot(present: string[]) {
  const calls: string[] = [];
  const classes = new Set<string>();
  const mk = (name: string): IntentEl => ({
    scrollIntoView: (o) => calls.push(`scroll:${name}:${o.behavior}:${o.block}`),
    focus: (o) => calls.push(`focus:${name}:${o.preventScroll}`),
    querySelector: () => null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
  });
  const root = mk('root');
  root.querySelector = (sel) => {
    const id = /data-testid="([^"]+)"/.exec(sel)?.[1] ?? '';
    return present.includes(id) ? mk(id) : null;
  };
  return { root, calls, classes };
}
const run = (el: ReturnType<typeof fakeRoot>, o: { linked: boolean; reduceMotion: boolean }) => {
  const timers: [() => void, number][] = [];
  const off = applyTelegramIntent(el.root, { ...o, setTimer: (f, ms) => timers.push([f, ms]) });
  return { off, timers };
};

describe('the intent in the url', () => {
  it('?telegram=open and the legacy #telegram both ask for the step; nothing else does', () => {
    expect(wantsTelegram('?telegram=open', '')).toBe(true);
    expect(wantsTelegram('?a=1&telegram=open', '#funds')).toBe(true);
    expect(wantsTelegram('', '#telegram')).toBe(true);
    expect(wantsTelegram('', '')).toBe(false);
    expect(wantsTelegram('?telegram=closed', '#funds')).toBe(false);
  });
  it('the parameter is dropped after use, the rest of the url stays', () => {
    expect(withoutIntent('/de/account', '?telegram=open', '#telegram')).toBe('/de/account#telegram');
    expect(withoutIntent('/de/account', '?x=1&telegram=open', '')).toBe('/de/account?x=1');
  });
});

describe('what the panel does with it', () => {
  it('not connected: scrolls to the section, focuses Connect without a second scroll, highlights, and removes the highlight after the timer', () => {
    const el = fakeRoot(['telegram-connect']);
    const { timers } = run(el, { linked: false, reduceMotion: false });
    expect(el.calls).toEqual(['scroll:root:smooth:start', 'focus:telegram-connect:true']);
    expect(el.classes.has(FLASH_CLASS)).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0][1]).toBe(FLASH_MS);
    timers[0][0]();
    expect(el.classes.has(FLASH_CLASS)).toBe(false);
  });
  it('a link that is already open: focus goes to Open Telegram', () => {
    const el = fakeRoot(['telegram-open', 'telegram-connect']);
    run(el, { linked: false, reduceMotion: false });
    expect(el.calls[1]).toBe('focus:telegram-open:true');
  });
  it('connected: the section itself takes focus (its switches and Disconnect are right below)', () => {
    const el = fakeRoot(['telegram-disconnect']);
    run(el, { linked: true, reduceMotion: false });
    expect(el.calls[1]).toBe('focus:root:true');
  });
  it('reduced motion: no smooth scrolling', () => {
    const el = fakeRoot(['telegram-connect']);
    run(el, { linked: false, reduceMotion: true });
    expect(el.calls[0]).toBe('scroll:root:auto:start');
  });
});

describe('every bot text that points at the account page carries the intent', () => {
  const KEYS: BotKey[] = ['welcome', 'linkInvalid', 'notLinked', 'stopped', 'help'];
  it.each(['en', 'de'] as const)('%s: the link has ?telegram=open and no placeholder is left', (l) => {
    expect(accountLink(l)).toMatch(new RegExp(`/${l}/account\\?telegram=open#telegram$`));
    for (const k of KEYS) {
      const text = t(l, k, { account: accountLink(l) });
      expect(text, k).toContain(`/${l}/account?telegram=open#telegram`);
      expect(text, k).not.toMatch(/\{\w+\}/);
    }
  });
  it('the texts that ask for an action name the button', () => {
    for (const k of ['linkInvalid', 'notLinked', 'stopped'] as const) {
      expect(t('en', k, { account: 'X' })).toContain('Connect Telegram');
      expect(t('de', k, { account: 'X' })).toContain('Telegram verbinden');
    }
  });
});
