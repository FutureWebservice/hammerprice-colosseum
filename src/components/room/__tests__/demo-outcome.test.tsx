/**
 * Demo room only: a person who wins, pays for or loses a lot is told it was a demo with a replica card, sees the card, and gets two ways
 * into the real product (the real rooms, the sell flow). A real room says none of it. German (Sie) and English.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('@/components/auction/win.css', () => ({}));
vi.mock('../room.css', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
(globalThis as { React?: unknown }).React = React;

import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';
import type { RoomLot } from '@/components/auction/types';
import WinModal from '@/components/auction/WinModal';
import { DemoOutbidModal, DemoOutcome, lostLotOf } from '../DemoOutcome';

const MESSAGES = { en: { room: enRoom }, de: { room: deRoom } };
const wrap = (l: 'en' | 'de', node: React.ReactNode) => renderToStaticMarkup(<NextIntlClientProvider locale={l} messages={MESSAGES[l] as never} timeZone="UTC">{node}</NextIntlClientProvider>);
const text = (h: string) => h.replace(/&#x27;/g, "'");

const lot: RoomLot = {
  id: 'L1', lotNumber: 3, name: 'Charizard Base Set', gradingCompany: 'PSA', grade: '9', imageUrl: 'https://img.test/c.png',
  increment: '1000000', openingPrice: '1000000', highBid: '5000000', highBidderIsMe: true, state: 'sold', settlement: { id: 'S1', status: 'awaiting_payment' },
};

describe('DemoOutcome', () => {
  it.each(['en', 'de'] as const)('won: says demo, replica card, and links to real rooms and /sell (%s)', (l) => {
    const h = text(wrap(l, <DemoOutcome kind="won" locale={l} />));
    expect(h).toContain(MESSAGES[l].room.demoOutcome.wonTitle);
    expect(h).toContain(MESSAGES[l].room.demoOutcome.wonBody);
    expect(h).toContain(MESSAGES[l].room.demoOutcome.try);
    expect(h).toContain(`href="/${l}/rooms#rm-sellers-title"`);
    expect(h).toContain(`href="/${l}/sell"`);
    expect(h).toContain(MESSAGES[l].room.demoOutcome.browse);
    expect(h).toContain(MESSAGES[l].room.demoOutcome.sell);
  });
  it('English wording and German Sie-form', () => {
    expect(enRoom.demoOutcome.wonBody).toMatch(/demo run with a replica card/);
    expect(enRoom.demoOutcome.outbidTitle).toMatch(/outbid in this demo/);
    expect(deRoom.demoOutcome.wonBody).toMatch(/Replik-Karte/);
    expect(deRoom.demoOutcome.wonBody).toMatch(/\bIhre\b/);
    expect(deRoom.demoOutcome.try).toMatch(/Probieren Sie/);
    expect(deRoom.demoOutcome.outbidTitle).toMatch(/Sie wurden/);
  });
});

describe('WinModal in a demo room', () => {
  const modal = (l: 'en' | 'de', demo: boolean) => wrap(l, (
    <WinModal won={{ lot, amount: 5_000_000n }} lots={[lot]} practice={false} demo={demo} cluster="devnet" locale={l} onPay={() => undefined} onClose={() => undefined} />
  ));
  it.each(['en', 'de'] as const)('shows the card, the demo explanation and both buttons, and keeps the pay button (%s)', (l) => {
    const h = modal(l, true);
    expect(h).toContain('data-testid="demo-outcome"');
    expect(h).toContain('data-kind="won"');
    expect(h).toContain('Charizard Base Set');
    expect(h).toContain('https://img.test/c.png');
    expect(h).toContain('PSA 9');
    expect(h).toContain('data-testid="demo-browse"');
    expect(h).toContain('data-testid="demo-sell"');
    expect(h).toContain('data-testid="win-pay"'); // the settlement flow is untouched
  });
  it('a real room shows none of it', () => {
    const h = modal('en', false);
    expect(h).not.toContain('data-testid="demo-outcome"');
    expect(h).toContain('data-testid="win-pay"');
  });
});

describe('DemoOutbidModal and lostLotOf', () => {
  it.each(['en', 'de'] as const)('shows the card, name, grade and the outbid explanation (%s)', (l) => {
    const h = text(wrap(l, <DemoOutbidModal lot={{ ...lot, highBidderIsMe: false }} locale={l} onClose={() => undefined} />));
    expect(h).toContain('data-testid="outbid-modal"');
    expect(h).toContain('data-kind="outbid"');
    expect(h).toContain(MESSAGES[l].room.demoOutcome.outbidTitle);
    expect(h).toContain(MESSAGES[l].room.demoOutcome.outbidBody);
    expect(h).toContain('https://img.test/c.png');
    expect(h).toContain('Charizard Base Set');
    expect(h).toContain('PSA 9');
    expect(h).toContain(`href="/${l}/sell"`);
  });
  it('renders nothing without a lot', () => {
    expect(wrap('en', <DemoOutbidModal lot={null} locale="en" onClose={() => undefined} />)).toBe('');
  });

  const lost = { ...lot, highBidderIsMe: false };
  const set = (...ids: string[]) => new Set(ids);
  it('finds a closed lot someone else won, that the viewer bid on and saw open, once', () => {
    expect(lostLotOf([lost], set('L1'), set('L1'), set())?.id).toBe('L1');
    expect(lostLotOf([{ ...lost, state: 'passed' }], set('L1'), set('L1'), set())?.id).toBe('L1');
    expect(lostLotOf([lost], set('L1'), set('L1'), set('L1'))).toBeNull(); // already shown
  });
  it('ignores lots the viewer won, only watched, never saw open, or that are still running', () => {
    expect(lostLotOf([lot], set('L1'), set('L1'), set())).toBeNull(); // won
    expect(lostLotOf([lost], set(), set('L1'), set())).toBeNull(); // not bid on
    expect(lostLotOf([lost], undefined, set('L1'), set())).toBeNull(); // real room: no bid set passed
    expect(lostLotOf([lost], set('L1'), set(), set())).toBeNull(); // opened on load as closed
    expect(lostLotOf([{ ...lost, state: 'open' }], set('L1'), set('L1'), set())).toBeNull();
    expect(lostLotOf([{ ...lost, highBid: null }], set('L1'), set('L1'), set())).toBeNull();
  });
});
