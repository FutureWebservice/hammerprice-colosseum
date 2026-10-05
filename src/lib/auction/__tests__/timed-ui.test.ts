/**
 * The timed auction's screens, rendered to static markup with the real DE and EN messages (no DOM library is installed): the phase strip, the lower
 * third, the room header, the duration picker in the sell wizard and the rooms list. The live look is asserted unchanged next to each timed one.
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children) }));
vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children), useRouter: () => ({ push: () => {} }) }));
vi.mock('@/components/room/room.css', () => ({}));
vi.mock('@/components/room/NetworkStrip', () => ({ default: () => null }));
vi.mock('@/components/legal/LegalLinkRow', () => ({ default: () => null }));
vi.mock('@/components/auction/auction.css', () => ({}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import enTimed from '@/locales/en/timed.json';
import deTimed from '@/locales/de/timed.json';
import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';
import enRooms from '@/locales/en/rooms.json';
import deRooms from '@/locales/de/rooms.json';
import enNav from '@/locales/en/nav.json';
import deNav from '@/locales/de/nav.json';
import type { ShowSummary } from '@/contracts/api';
import PhaseBanner from '@/components/room/PhaseBanner';
import RoomShell from '@/components/room/RoomShell';
import LowerThird from '@/components/auction/LowerThird';
import { DurationPickerView, DEFAULT_TIMED_DURATION_S, DURATION_PRESETS_S, chooseDuration, chooseLive, chooseTimed } from '@/components/sell/slots/DurationPicker';
import DurationPicker from '@/components/sell/slots/DurationPicker';
import { ScheduleView } from '@/components/sell/ScheduleView';
import { filterByTab, hasTimed, msToDeadline } from '@/components/sell/slots/TimedSchedule';
import { canPublish, buildCreateRequest, applyAssets, initialState, togglePick } from '@/components/sell/wizardState';
import type { RoomLot } from '@/components/auction/types';

const MESSAGES = {
  en: { timed: enTimed, room: enRoom, rooms: enRooms, nav: enNav },
  de: { timed: deTimed, room: deRoom, rooms: deRooms, nav: deNav },
};
const html = (ui: React.ReactElement, locale: 'en' | 'de' = 'en') =>
  renderToStaticMarkup(React.createElement(NextIntlClientProvider as React.ComponentType<Record<string, unknown>>, { locale, messages: MESSAGES[locale], timeZone: 'Europe/Berlin' }, ui));
const text = (m: string) => m.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const has = (m: string, id: string) => m.includes(`data-testid="${id}"`);

const S = 1000; const MIN = 60 * S; const H = 3600 * S; const D = 24 * H;
const SHOW = '3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10';
const ENDS = '2026-10-09T19:15:00.000Z';

const banner = (over: Partial<React.ComponentProps<typeof PhaseBanner>> = {}, locale: 'en' | 'de' = 'en') =>
  html(React.createElement(PhaseBanner, { phase: 'open', msLeft: 2 * D + 3 * H + 12 * MIN + 44 * S, peakMs: 3 * D, extendedBy: 0, msToNext: null, showStatus: 'live', kind: 'timed', closesAt: ENDS, title: 'Charizard', showId: SHOW, ...over }), locale);

describe('PhaseBanner on a timed show', () => {
  it('draws days, the moment it ends, the anti-snipe rule in minutes and the USDC hint', () => {
    const m = banner();
    expect(text(m)).toContain('2 d 03:12:44');
    expect(text(m)).toContain('Bidding open');
    expect(has(m, 'timed-ends-at')).toBe(true);
    expect(text(m)).toMatch(/Ends .*Fri.*9 Oct.*21:15/); // 19:15 UTC in the viewer's zone (Europe/Berlin)
    expect(text(m)).toContain('A bid in the last 5 minutes moves the end to 5 minutes after that bid. The end can move by at most 24 hours in total.');
    expect(text(m)).toContain('Keep enough USDC in your wallet until the end.');
    expect(m).toContain('data-kind="timed"');
    expect(text(m)).not.toContain(enRoom.countdown.antiSnipe); // the live sentence in seconds is replaced
  });

  it('German, with the formal address', () => {
    const m = banner({}, 'de');
    expect(text(m)).toContain('2 T 03:12:44');
    expect(text(m)).toContain('Ein Gebot in den letzten 5 Minuten schiebt das Ende auf 5 Minuten nach diesem Gebot. Das Ende verschiebt sich insgesamt höchstens um 24 Stunden.');
    expect(text(m)).toContain('Halten Sie bis zum Ende genug USDC in Ihrer Wallet bereit.');
    expect(text(m)).toMatch(/Endet .*Fr.*9\. Okt.*21:15/);
  });

  it('hours: "3 h 12 min"', () => expect(text(banner({ msLeft: 3 * H + 12 * MIN + 44 * S }))).toContain('3 h 12 min'));

  it('says "ends soon" instead of chanting until the last 10 seconds, then the call comes', () => {
    const soon = banner({ phase: 'going-once', msLeft: 200 * S });
    expect(text(soon)).toContain('Ends soon');
    expect(text(soon)).not.toContain('Going once');
    expect(soon).toContain('data-phase="open"');
    expect(soon).not.toContain('is-going-once');
    expect(text(banner({ phase: 'going-twice', msLeft: 50 * S }, 'de'))).toContain('Endet bald');
    const call = banner({ phase: 'going-twice', msLeft: 8 * S });
    expect(text(call)).toContain('Going twice');
    expect(call).toContain('is-going-twice');
    expect(call).toContain('is-final');
  });

  it('shows an extension in minutes and offers the calendar entry (an .ics that ends when the lot ends)', () => {
    const m = banner({ extendedBy: 300 });
    expect(text(m)).toContain('Extended by 5 min');
    expect(has(m, 'extension-chip')).toBe(true);
    const href = /data-testid="timed-calendar"/.test(m) ? /href="(data:text\/calendar[^"]+)"/.exec(m)?.[1] : null;
    expect(href).toBeTruthy();
    const ics = decodeURIComponent(href!.replace(/&amp;/g, '&').split(',').slice(1).join(','));
    expect(ics).toContain('SUMMARY:Ends: Charizard');
    expect(ics).toContain('DTSTART:20261009T181500Z'); // one hour before the end
    expect(ics).toContain('DTEND:20261009T191500Z');
    expect(text(m)).toContain('Add the current end to my calendar');
  });

  it('a scheduled or ended timed show draws no countdown, no rule and no calendar entry', () => {
    for (const showStatus of ['scheduled', 'ended'] as const) {
      const m = banner({ showStatus, phase: 'open', msLeft: null });
      expect(has(m, 'timed-rule')).toBe(false);
      expect(has(m, 'timed-calendar')).toBe(false);
    }
    expect(text(banner({ showStatus: 'ended', phase: 'hammered', msLeft: null }))).toContain('Show ended');
  });
});

describe('PhaseBanner on a live show is unchanged', () => {
  const live = (over: Partial<React.ComponentProps<typeof PhaseBanner>> = {}) => banner({ kind: 'live', closesAt: null, title: null, showId: null, msLeft: 7 * S, peakMs: 45 * S, ...over });
  it('the seconds countdown, the going once call straight away and the live anti-snipe sentence', () => {
    const m = live({ phase: 'going-once' });
    expect(text(m)).toContain('0:07');
    expect(text(m)).toContain('Going once');
    expect(m).toContain('is-going-once');
    expect(text(m)).toContain(enRoom.countdown.antiSnipe);
    expect(has(m, 'timed-rule')).toBe(false);
    expect(has(m, 'timed-ends-at')).toBe(false);
    expect(m).not.toContain('is-timed');
  });
  it('a one hour live lot still counts as before (minutes and seconds, the way formatCountdown printed it)', () => expect(text(live({ msLeft: 59 * MIN + 59 * S }))).toContain('59:59'));
  it('the extension chip keeps its seconds wording', () => expect(text(live({ extendedBy: 15 }))).toContain(enRoom.countdown.extended.replace('{seconds}', '15')));
  it('without a kind prop it is a live strip', () => {
    const m = html(React.createElement(PhaseBanner, { phase: 'going-twice', msLeft: 3 * S, peakMs: 45 * S, extendedBy: 0, msToNext: null, showStatus: 'live' }));
    expect(m).toContain('is-going-twice');
    expect(text(m)).toContain('0:03');
  });
});

const LOT: RoomLot = { id: 'l1', lotNumber: 1, name: 'Charizard', increment: '5000000', openingPrice: '50000000', highBid: '55000000', state: 'open', reserve: '50000000' };
const third = (props: Partial<React.ComponentProps<typeof LowerThird>>) => html(React.createElement(LowerThird, { lot: LOT, phase: 'open', msToNext: null, jitterToken: 0, ...props }));

describe('LowerThird', () => {
  it('a timed lot keeps showing the bid until the last 10 seconds, then takes the call', () => {
    expect(third({ phase: 'going-once', timed: true, msLeft: 200 * S })).not.toContain('is-call');
    expect(third({ phase: 'going-once', timed: true, msLeft: 200 * S })).toContain('ar-lt-bid');
    expect(third({ phase: 'going-twice', timed: true, msLeft: 9 * S })).toContain('is-call');
    expect(text(third({ phase: 'going-twice', timed: true, msLeft: 9 * S }))).toContain('Going twice');
  });
  it('a live lot always takes the call', () => {
    expect(third({ phase: 'going-once' })).toContain('is-call');
    expect(third({ phase: 'going-once', timed: false, msLeft: 200 * S })).toContain('is-call');
  });
});

describe('RoomShell header', () => {
  const shell = (kind?: 'live' | 'timed') => html(React.createElement(RoomShell as React.ComponentType<Record<string, unknown>>, { locale: 'en', title: 'Show', status: 'live', ...(kind ? { kind } : {}) }, null));
  it('a timed show says so instead of showing the live dot', () => {
    const m = shell('timed');
    expect(text(m)).toContain('Timed auction');
    expect(m).not.toContain('ar-live-dot');
    expect(has(m, 'timed-badge')).toBe(true);
  });
  it('a live show keeps the dot, with or without the prop', () => {
    for (const m of [shell('live'), shell()]) { expect(m).toContain('ar-live-dot'); expect(has(m, 'timed-badge')).toBe(false); }
  });
});

describe('DurationPicker', () => {
  const view = (over: Partial<React.ComponentProps<typeof DurationPickerView>> = {}, locale: 'en' | 'de' = 'en') =>
    html(React.createElement(DurationPickerView, { kind: 'live', durationS: null, lotCount: 1, onChange: () => {}, ...over }), locale);

  it('live: a collapsed block with the two choices and nothing about a duration', () => {
    const m = view();
    expect(m).toContain('data-testid="advanced-timed"');
    expect(m).not.toMatch(/<details[^>]*\sopen/);
    expect(/data-testid="kind-live"[^>]*checked/.test(m) || /checked[^>]*data-testid="kind-live"/.test(m)).toBe(true);
    expect(has(m, 'timed-options')).toBe(false);
    expect(text(m)).toContain('Auction type (advanced)');
  });

  it('timed: open, presets 1 h, 6 h, 24 h, 3 d, 7 d with the default marked, rules, settlement time and the honest limit', () => {
    const m = view({ kind: 'timed', durationS: null });
    expect(m).toMatch(/<details[^>]*\sopen/);
    for (const s of DURATION_PRESETS_S) expect(has(m, `duration-${s}`)).toBe(true);
    expect(text(m)).toMatch(/1 h.*6 h.*24 h.*3 d.*7 d/);
    expect(/aria-pressed="true"[^>]*data-testid="duration-86400"/.test(m)).toBe(true);
    expect(text(m)).toContain('A bid in the last 5 minutes moves the end to 5 minutes after that bid, by at most 24 hours in total.');
    expect(text(m)).toContain('the winner has 3 days to pay');
    expect(text(m)).toContain('open to the Hammerprice room and to operator wallets');
    expect(has(m, 'timed-one-card')).toBe(false);
  });

  it('a chosen length is the pressed one; two cards trigger the one-card warning', () => {
    const m = view({ kind: 'timed', durationS: 3 * 86_400, lotCount: 2 });
    expect(/aria-pressed="true"[^>]*data-testid="duration-259200"/.test(m)).toBe(true);
    expect(text(m)).toContain('exactly one card, and you have picked 2');
  });

  it('German, formal', () => {
    const m = view({ kind: 'timed', durationS: null, lotCount: 3 }, 'de');
    expect(text(m)).toContain('Art der Auktion (erweitert)');
    expect(text(m)).toMatch(/1 h.*6 h.*24 h.*3 T.*7 T/);
    expect(text(m)).toContain('Sie haben 3 gewählt');
    expect(text(m)).toContain('hat der Gewinner 3 Tage Zeit zum Bezahlen');
  });

  it('the slot renders nothing while the feature is off (its first render, before the switch is known) and a live wizard is untouched', () => {
    expect(html(React.createElement(DurationPicker, { kind: 'live', durationS: null, lotCount: 1, onChange: () => {} }))).toBe('');
    expect(html(React.createElement(DurationPicker, { kind: 'timed', durationS: null, lotCount: 1, onChange: () => {} }))).toContain('data-testid="timed-options"');
  });

  it('the choices: live drops the length, timed keeps a picked one or takes one day', () => {
    expect(chooseLive()).toEqual({ kind: 'live', durationS: null });
    expect(chooseTimed(null)).toEqual({ kind: 'timed', durationS: DEFAULT_TIMED_DURATION_S });
    expect(chooseTimed(21_600)).toEqual({ kind: 'timed', durationS: 21_600 });
    expect(chooseDuration(604_800)).toEqual({ kind: 'timed', durationS: 604_800 });
    expect(DEFAULT_TIMED_DURATION_S).toBe(86_400);
  });
});

describe('the wizard state for a timed auction', () => {
  const ASSET = { mint: 'MintA11111111111111111111111111111111111111', name: 'Charizard', imageUrl: null, grade: 'PSA 10', eligible: true, reasons: [] } as unknown as Parameters<typeof togglePick>[1];
  const ASSET2 = { ...ASSET, mint: 'MintB11111111111111111111111111111111111111' };
  const NOW = new Date('2026-10-05T10:00:00Z');
  const ready = (cards: typeof ASSET[], extra: object = {}) => {
    let s = initialState(NOW);
    for (const c of cards) s = togglePick(s, c);
    return { ...applyAssets(s, cards), title: 'One card', ...extra };
  };
  it('a timed auction is publishable with exactly one card, and the request carries the kind and the length', () => {
    const s = ready([ASSET], { kind: 'timed' as const, durationS: 21_600 });
    expect(canPublish(s, NOW)).toBe(true);
    expect(buildCreateRequest(s, NOW)).toMatchObject({ kind: 'timed', rules: { lotDurationS: 21_600 } });
  });
  it('with two cards a timed auction cannot be published (a live show of two can)', () => {
    expect(canPublish(ready([ASSET, ASSET2], { kind: 'timed' as const, durationS: 3600 }), NOW)).toBe(false);
    expect(buildCreateRequest(ready([ASSET, ASSET2], { kind: 'timed' as const }), NOW)).toBeNull();
    expect(canPublish(ready([ASSET, ASSET2]), NOW)).toBe(true);
    expect(canPublish(ready([ASSET, ASSET2], { kind: 'live' as const }), NOW)).toBe(true);
    expect(buildCreateRequest(ready([ASSET]), NOW)).not.toHaveProperty('kind');
  });
});

describe('the rooms list', () => {
  const show = (over: Partial<ShowSummary> = {}): ShowSummary => ({
    id: SHOW, title: 'A room', status: 'live', scheduledAt: null, startedAt: '2026-10-05T09:00:00Z', endedAt: null, lotCount: 6, soldCount: 0, hammerTotal: '0',
    cluster: 'devnet', isHouse: true, thumbs: [], kind: 'live', closesAt: null, ...over,
  });
  const NOW_MS = Date.parse('2026-10-05T10:00:00Z');
  const render = (live: ShowSummary[], scheduled: ShowSummary[] = [], ended: ShowSummary[] = [], locale: 'en' | 'de' = 'en') =>
    html(React.createElement(ScheduleView, { state: { status: 'ready', live, scheduled, ended }, nowMs: NOW_MS, origin: 'https://hp.test' }), locale);

  it('with no timed show the list is as before: no tabs, no timed badge', () => {
    const m = render([show()]);
    expect(has(m, 'rooms-tabs')).toBe(false);
    expect(has(m, 'badge-timed')).toBe(false);
    expect(text(m)).toContain('Live');
  });

  it('a live timed auction shows the badge and the time left (no live dot), and the tabs appear', () => {
    const t = show({ id: '11111111-1111-4111-8111-111111111111', title: 'Charizard', kind: 'timed', lotCount: 1, closesAt: new Date(NOW_MS + 2 * D + 3 * H + 12 * MIN + 44 * S).toISOString() });
    const m = render([show(), t]);
    expect(has(m, 'rooms-tabs')).toBe(true);
    expect(has(m, 'badge-timed')).toBe(true);
    expect(text(m)).toContain('Ends in 2 d 03:12:44');
    expect(text(render([show(), t], [], [], 'de'))).toContain('Endet in 2 T 03:12:44');
    expect((m.match(/hpx-dot/g) ?? []).length).toBe(1); // only the live room has the dot
    expect(text(m)).toMatch(/All.*Live.*Timed/);
  });

  it('a timed show without a deadline yet says it opens soon', () => {
    expect(text(render([show({ kind: 'timed', closesAt: null })]))).toContain('Opening soon');
  });
});

describe('the list helpers', () => {
  const live = { kind: 'live' as const }; const timed = { kind: 'timed' as const }; const old = {};
  it('hasTimed, filterByTab and msToDeadline', () => {
    expect(hasTimed([live], [old])).toBe(false);
    expect(hasTimed([live], [timed])).toBe(true);
    expect(filterByTab([live, timed, old], 'all')).toHaveLength(3);
    expect(filterByTab([live, timed, old], 'live')).toEqual([live, old]);
    expect(filterByTab([live, timed, old], 'timed')).toEqual([timed]);
    expect(msToDeadline('2026-10-05T10:00:10.000Z', Date.parse('2026-10-05T10:00:00Z'))).toBe(10_000);
    expect(msToDeadline(null, 0)).toBeNull();
    expect(msToDeadline('nonsense', 0)).toBeNull();
  });
});

describe('messages', () => {
  type Tree = { [k: string]: string | Tree };
  const leaves = (t: Tree, p = ''): [string, string][] => Object.entries(t).flatMap(([k, v]) => (typeof v === 'string' ? [[`${p}${k}`, v] as [string, string]] : leaves(v, `${p}${k}.`)));
  const en = new Map(leaves(enTimed as Tree));
  const de = new Map(leaves(deTimed as Tree));
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  it('de and en have the same keys and placeholders, no empty text, no em dash, no "open source", no push promise', () => {
    expect([...en.keys()].sort()).toEqual([...de.keys()].sort());
    for (const [k, v] of en) {
      expect(ph(v), k).toBe(ph(de.get(k)!));
      for (const s of [v, de.get(k)!]) { expect(s.trim(), k).not.toBe(''); expect(s, k).not.toMatch(/\u2014|–/); expect(s.toLowerCase(), k).not.toMatch(/open.?source|push|notif|benachrichtig|e-?mail/); }
    }
  });
});
