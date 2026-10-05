/**
 * One header for the whole site. The room used to hide the site header and draw its own smaller bar with fewer
 * links, another wordmark and its own wallet button, so rooms read as a different site. These tests render the real
 * Header, SiteChrome and RoomShell to static markup (no DOM library is installed) with the real DE and EN messages
 * and check that the room gets the SAME header in its compact variant: same wordmark, same links in the same order,
 * Help, language switcher, exactly one wallet entry, the skip link first and pointing at the bidding area, and no
 * footer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

const state = vi.hoisted(() => ({ pathname: '/en', signedIn: false }));

vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children) }));
vi.mock('@/lib/i18n', () => ({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  getUserLocale: () => 'en',
  getLocaleFromPath: (p: string) => (/^\/(en|de)(\/|$)/.exec(p || '')?.[1] ?? null),
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children),
}));
vi.mock('@/components/auth/SessionProvider', () => ({
  useSession: () => (state.signedIn
    ? { status: 'signed-in', me: { wallet: 'So11111111111111111111111111111111111111112' }, connected: true, signIn: async () => {}, signOut: async () => {} }
    : { status: 'anonymous', me: null, connected: false, signIn: async () => {}, signOut: async () => {} }),
}));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ signMessage: undefined, connected: false, connecting: false, publicKey: null }) }));
vi.mock('@/components/room/ConnectWalletButton', () => ({ default: () => React.createElement('button', { 'data-testid': 'connect-wallet' }, 'wallet') }));
vi.mock('@/components/explain/ExplainBubble', () => ({ default: () => React.createElement('div', { 'data-testid': 'explain-bubble' }) }));
vi.mock('@/components/pitch/PitchRibbon', () => ({ default: () => React.createElement('div', { 'data-testid': 'pitch-ribbon' }) }));
vi.mock('@/components/layout/Footer', () => ({ default: () => React.createElement('footer', { 'data-testid': 'site-footer' }) }));
vi.mock('@/components/room/NetworkStrip', () => ({ default: () => null }));
vi.mock('@/components/legal/LegalLinkRow', () => ({ default: () => React.createElement('div', { 'data-testid': 'legal-row' }) }));
vi.mock('@/components/auction/auction.css', () => ({}));
vi.mock('@/components/room/room.css', () => ({}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import enNav from '@/locales/en/nav.json';
import deNav from '@/locales/de/nav.json';
import enAccount from '@/locales/en/account.json';
import deAccount from '@/locales/de/account.json';
import enTour from '@/locales/en/tour.json';
import deTour from '@/locales/de/tour.json';
import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';
import enTimed from '@/locales/en/timed.json';
import deTimed from '@/locales/de/timed.json';
import Header from '../Header';
import SiteChrome from '../SiteChrome';
import RoomShell from '@/components/room/RoomShell';

const MESSAGES = {
  en: { nav: enNav, account: enAccount, tour: enTour, room: enRoom, timed: enTimed },
  de: { nav: deNav, account: deAccount, tour: deTour, room: deRoom, timed: deTimed },
};
const html = (ui: React.ReactElement, locale: 'en' | 'de' = 'en') =>
  renderToStaticMarkup(React.createElement(NextIntlClientProvider as React.ComponentType<Record<string, unknown>>, { locale, messages: MESSAGES[locale], timeZone: 'Europe/Berlin' }, ui));
const text = (m: string) => m.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const count = (m: string, id: string) => m.split(`data-testid="${id}"`).length - 1;
const hrefsOf = (m: string, id: string) => [...m.matchAll(new RegExp(`<a[^>]*href="([^"]+)"[^>]*data-testid="${id}"`, 'g'))].map((x) => x[1]);
/** The opening <header> tag, and the bar row inside it (the stylesheet text in between also mentions the attributes). */
const tag = (m: string) => /<header[^>]*>/.exec(m)?.[0] ?? '';
const bar = (m: string) => /<div class="container[^"]*"/.exec(m)?.[0] ?? '';
const EM_DASH =String.fromCharCode(0x2014);

const chrome = (locale: 'en' | 'de' = 'en') => html(React.createElement(SiteChrome as React.ComponentType<Record<string, unknown>>, { pitchLabel: 'Read the pitch', skipLabel: locale === 'de' ? 'Zum Inhalt springen' : 'Skip to content' }, React.createElement('main', null, 'page')), locale);

beforeEach(() => { state.pathname = '/en'; state.signedIn = false; });

describe('the header is one component, compact in the room', () => {
  it('compact is sticky and 56 px; the full header is 80 px and not sticky', () => {
    const full = html(React.createElement(Header));
    const compact = html(React.createElement(Header, { compact: true }));
    expect(tag(full)).not.toContain('data-compact');
    expect(tag(full)).not.toContain('sticky');
    expect(bar(full)).toContain('h-20');
    expect(tag(compact)).toContain('data-compact="true"');
    expect(tag(compact)).toContain('sticky top-0');
    expect(bar(compact)).toContain('h-14');
    expect(bar(compact)).not.toContain('h-20');
  });

  for (const locale of ['en', 'de'] as const) {
    it(`same wordmark, links in the same order, Help, language and wallet (${locale})`, () => {
      state.pathname = `/${locale}/room/abc`;
      const full = html(React.createElement(Header), locale);
      const compact = html(React.createElement(Header, { compact: true }), locale);
      const nav = MESSAGES[locale].nav;
      for (const m of [full, compact]) {
        expect(m).toContain('aria-label="Hammerprice"'); // the logo link: the picture is decorative, the link carries the name
        expect(m).toContain('/brand/logo-wordmark.svg');
        if (m === compact) expect(m).toContain('/brand/logo-symbol.svg'); // the room's bar: the symbol alone on a phone
        if (m === full) expect(m).not.toContain('/brand/logo-symbol.svg');
        expect(hrefsOf(m, 'nav-rooms')).toEqual(['/rooms']);
        const labels = [...m.matchAll(/data-testid="nav-[a-zA-Z]+"[^>]*>([^<]+)</g)].map((x) => x[1].replace('&#x27;', "'"));
        expect(labels).toEqual([nav.home, nav.rooms, nav.sell, nav.profile, nav.ai, nav.about].map((x) => x.toUpperCase()));
        expect(count(m, 'help-button')).toBe(1);
        expect(count(m, 'mobile-menu-button')).toBe(1);
        expect(m).toContain(`aria-label="${nav.main}"`); // from the locale messages (nav.main), not hard-coded English
        if (locale === 'de') expect(m).not.toContain('aria-label="Main"');
      }
      // The same items apart from the sizing: the compact bar adds nothing the full bar lacks and drops nothing.
      const ids = (m: string) => [...m.matchAll(/data-testid="([^"]+)"/g)].map((x) => x[1]).filter((x) => x !== 'site-header');
      expect(ids(compact)).toEqual(ids(full));
    });
  }

  it('the room is a place inside Rooms: the Rooms link is current there, and only there', () => {
    state.pathname = '/en/room/abc';
    expect(html(React.createElement(Header, { compact: true }))).toMatch(/aria-current="page"[^>]*data-testid="nav-rooms"/);
    state.pathname = '/en/sell';
    expect(html(React.createElement(Header, { compact: true }))).not.toMatch(/aria-current="page"[^>]*data-testid="nav-rooms"/);
    state.pathname = '/en/rooms';
    expect(html(React.createElement(Header))).toMatch(/aria-current="page"[^>]*data-testid="nav-rooms"/);
  });

  it('Help stays in the bar on a phone in the room (the tour ends there); the full header shows it from 640 px', () => {
    const full = html(React.createElement(Header));
    const compact = html(React.createElement(Header, { compact: true }));
    const helpWrap = (m: string) => /<div class="([^"]*)"><div class="ux-help"/.exec(m)?.[1];
    expect(helpWrap(full)).toBe('hidden sm:block');
    expect(helpWrap(compact)).toBe('block');
  });

  it('the main navigation is Home, Rooms, Sell, Profile, AI agent, About (Packs only where the feature is on), the same on every page, the room and the phone menu, signed in or not', () => {
    const order = ['/', '/rooms', '/sell', '/account', '/ai', '/about'];
    for (const locale of ['en', 'de'] as const) {
      for (const signedIn of [false, true]) {
        for (const p of [`/${locale}`, `/${locale}/rooms`, `/${locale}/room/abc`, `/${locale}/about`, `/${locale}/sell/new`, `/${locale}/account`]) {
          state.signedIn = signedIn;
          state.pathname = p;
          const m = html(React.createElement(Header, { compact: /\/room\//.test(p) }), locale);
          const desktop = [...m.matchAll(/<a[^>]*href="([^"]+)"[^>]*data-testid="nav-[a-zA-Z]+"/g)].map((x) => x[1]);
          const phone = [...m.matchAll(/<a[^>]*href="([^"]+)"[^>]*data-testid="mobile-nav-[a-zA-Z]+"/g)].map((x) => x[1]);
          expect(desktop, p).toEqual(order);
          expect(phone, p).toEqual(order);
        }
      }
    }
  });

  it('How it works, the pitch and the FAQ are not in the bar any more (they are sections of /about, reached from the footer and Help)', () => {
    for (const locale of ['en', 'de'] as const) {
      state.pathname = `/${locale}`;
      const m = html(React.createElement(Header), locale);
      expect(m).not.toMatch(/data-testid="(?:mobile-)?nav-(?:howItWorks|pitch|faq|account)"/);
      expect(m).not.toMatch(/href="\/(?:how-it-works|pitch|faq)/);
      // The phone menu's Help block points into the About page.
      for (const a of ['/about#glossary', '/about#wallet', '/about#faq']) expect(m).toContain(`href="${a}"`);
    }
  });

  it('Profile is labelled Profile / Profil and points at the account page; Home is current on the landing page only', () => {
    expect(MESSAGES.en.nav.profile).toBe('Profile');
    expect(MESSAGES.de.nav.profile).toBe('Profil');
    expect(MESSAGES.en.nav.ai).toBe('AI agent');
    state.pathname = '/en';
    expect(html(React.createElement(Header))).toMatch(/aria-current="page"[^>]*data-testid="nav-home"/);
    state.pathname = '/en/rooms';
    expect(html(React.createElement(Header))).not.toMatch(/aria-current="page"[^>]*data-testid="nav-home"/);
    state.pathname = '/en/account';
    expect(html(React.createElement(Header))).toMatch(/aria-current="page"[^>]*data-testid="nav-profile"/);
  });

  it('a signed-in visitor keeps the session control (account link, sign out) in the room header', () => {
    state.signedIn = true;
    state.pathname = '/en/room/abc';
    const compact = html(React.createElement(Header, { compact: true }));
    expect(compact).toContain('data-testid="session-control"');
  });
});

describe('SiteChrome in a room', () => {
  for (const locale of ['en', 'de'] as const) {
    it(`skip link first and aimed at the bidding area, then the compact header, no footer (${locale})`, () => {
      state.pathname = `/${locale}/room/abc`;
      const m = chrome(locale);
      expect(m.indexOf('data-testid="skip-link"')).toBeGreaterThanOrEqual(0);
      expect(m.indexOf('data-testid="skip-link"')).toBeLessThan(m.indexOf('data-testid="site-header"'));
      expect(m.indexOf('data-testid="site-header"')).toBeLessThan(m.indexOf('<main'));
      expect(m).toMatch(/<a href="#ar-bidding"[^>]*data-testid="skip-link">/);
      expect(text(m)).toContain(MESSAGES[locale].room.a11y.skip);
      expect(tag(m)).toContain('data-compact="true"');
      expect(count(m, 'site-footer')).toBe(0);
      expect(count(m, 'pitch-ribbon')).toBe(0);
      expect(count(m, 'explain-bubble')).toBe(1);
    });
  }

  it('exactly the header wallet entry: the same number as on any other page, none of the room\'s own', () => {
    state.pathname = '/en/room/abc';
    const room = chrome();
    state.pathname = '/en/rooms';
    const index = chrome();
    // The header renders its wallet control once for the bar and once for the phone menu (CSS shows one of them).
    expect(count(room, 'connect-wallet')).toBe(count(index, 'connect-wallet'));
    expect(count(room, 'connect-wallet')).toBe(2);
    expect(count(room, 'wallet-button')).toBe(0);
  });

  it('every other page keeps the full chrome and a skip link to the main content', () => {
    for (const p of ['/en', '/en/rooms', '/en/sell', '/en/about', '/de/about', '/en/account', '/en/verify/x']) {
      state.pathname = p;
      const m = chrome();
      expect(m, p).toMatch(/<a href="#main-content"[^>]*data-testid="skip-link">/);
      expect(tag(m), p).not.toContain('data-compact');
      expect(count(m, 'site-footer'), p).toBe(1);
      expect(count(m, 'pitch-ribbon'), p).toBe(1);
    }
  });
});

describe('RoomShell carries only the room\'s own status line', () => {
  const shell = (props: Record<string, unknown> = {}, locale: 'en' | 'de' = 'en') =>
    html(React.createElement(RoomShell as React.ComponentType<Record<string, unknown>>, { locale, title: 'Show', status: 'live', ...props }, React.createElement('div', { id: 'ar-bidding' })), locale);

  it('the one h1, the live state, the label; no second nav, wallet button, Help or skip link', () => {
    const m = shell({ pill: React.createElement('span', { 'data-testid': 'practice-pill' }, 'Practice') });
    expect(m.match(/<h1/g)).toHaveLength(1);
    expect(m).toContain('ar-live-dot');
    expect(count(m, 'practice-pill')).toBe(1);
    for (const gone of ['<nav', 'wallet-button', 'ar-skip', 'help-button', 'data-tour="help"', 'ar-topbar']) expect(m, gone).not.toContain(gone);
  });

  it('timed badge, scheduled and ended pills, in both languages', () => {
    expect(text(shell({ kind: 'timed' }))).toContain('Timed auction');
    expect(text(shell({ kind: 'timed' }, 'de'))).toContain(deTimed.badge);
    expect(text(shell({ status: 'scheduled' }))).toContain(enRoom.status.scheduled);
    expect(text(shell({ status: 'ended' }, 'de'))).toContain(deRoom.status.showEnded);
    expect(shell({ status: null })).not.toContain('ar-status-pill');
  });

  it('names the seller by the display name they chose, never on the house room or without a name, in both languages', () => {
    const named = shell({ seller: 'Anna Cards' });
    expect(named).toMatch(/data-testid="room-seller"[^>]*>Offered by Anna Cards</);
    expect(shell({ seller: 'Anna Cards' }, 'de')).toMatch(/data-testid="room-seller"[^>]*>Angeboten von Anna Cards</);
    expect(shell({ seller: null })).not.toContain('room-seller');
    expect(shell({})).not.toContain('room-seller');
    expect(shell({ seller: 'Anna Cards', demo: true })).not.toContain('room-seller');
    expect(named.match(/<h1/g)).toHaveLength(1);
  });
});

describe('copy', () => {
  it('the strings the room bar needs exist in German and English and carry no em dash', () => {
    for (const l of ['en', 'de'] as const) {
      const m = MESSAGES[l];
      for (const v of [m.room.a11y.skip, m.tour.help.label, m.account.session.menu, m.nav.home, m.nav.rooms, m.nav.sell, m.nav.profile, m.nav.ai, m.nav.connectWallet]) {
        expect(v, l).toBeTruthy();
        expect(v).not.toContain(EM_DASH);
      }
    }
  });
});
