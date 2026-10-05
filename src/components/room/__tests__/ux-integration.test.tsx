/**
 * The help pieces as they are drawn inside the real room parts (first render, real messages, both languages, both networks).
 * Here: what is on the page and in which words (no clicks, focus or tour run).
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('../room.css', () => ({}));
vi.mock('@/lib/i18n', () => ({
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
  useRouter: () => ({ push: () => {} }),
}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';
import enTour from '@/locales/en/tour.json';
import deTour from '@/locales/de/tour.json';
import enGl from '@/locales/en/glossary.json';
import deGl from '@/locales/de/glossary.json';
import enRooms from '@/locales/en/rooms.json';
import deRooms from '@/locales/de/rooms.json';
import enSell from '@/locales/en/sell.json';
import deSell from '@/locales/de/sell.json';
import FeeBreakdown from '@/components/auction/FeeBreakdown';
import EventRail from '@/components/auction/EventRail';
import GetReadySheet from '../GetReadySheet';
import { ScheduleView } from '@/components/sell/ScheduleView';
import { GateView } from '@/components/sell/SignInGate';

const MSG = {
  en: { room: enRoom, tour: enTour, glossary: enGl, rooms: enRooms, sell: enSell },
  de: { room: deRoom, tour: deTour, glossary: deGl, rooms: deRooms, sell: deSell },
};
const html = (ui: React.ReactElement, l: 'en' | 'de' = 'en') =>
  renderToStaticMarkup(<NextIntlClientProvider locale={l} messages={MSG[l]} timeZone="Europe/Berlin">{ui}</NextIntlClientProvider>);

describe('fee table', () => {
  it('stays plain text: it is drawn inside the bid panel and the win dialog, which are modal', () => {
    for (const l of ['en', 'de'] as const) {
      const h = html(<FeeBreakdown amountBaseUnits="45000000" solUsd={null} devnet />, l);
      expect(h).not.toContain('data-term=');
    }
  });
  it('names no test money in the fee table: Hammerprice pays the network fee', () => {
    expect(html(<FeeBreakdown amountBaseUnits="45000000" solUsd={null} devnet />)).toContain('Paid by Hammerprice');
    expect(html(<FeeBreakdown amountBaseUnits="45000000" solUsd={null} devnet />, 'de')).toContain('Von Hammerprice getragen');
  });
});

describe('the room list of words', () => {
  const rail = (l: 'en' | 'de' = 'en') => html(<EventRail feed={[]} onSendChat={() => {}} />, l);
  it('is a folded list of glossary words, from the one glossary source', () => {
    const h = rail();
    expect(h).toContain('data-testid="room-terms"');
    for (const id of ['usdc', 'paddle', 'bid', 'reserve', 'hammer', 'hammerPrice', 'antiSniping', 'networkFee', 'settlement', 'memo']) expect(h).toContain(`data-term="${id}"`);
    expect(h).toContain('<details class="ar-glossary">');
  });
  it('shows the plain words, not the technical ones, as the labels', () => {
    const h = rail();
    expect(h).toContain('>Bidding number<');
    expect(h).toContain('>Minimum price<');
    expect(h).toContain('>Sold<');
    const de = rail('de');
    expect(de).toContain('>Bieternummer<');
    expect(de).toContain('>Mindestpreis<');
    expect(de).toContain('>Zuschlag<');
  });
});

describe('the local-only message box', () => {
  it('shows while the room chat is off and is hidden while it is on (one chat, not two)', () => {
    for (const l of ['en', 'de'] as const) {
      const off = html(<EventRail feed={[]} onSendChat={() => {}} />, l);
      expect(off).toContain('data-testid="local-composer"');
      expect(off).toContain('ar-composer-note');
      const on = html(<EventRail feed={[]} onSendChat={() => {}} chatOn />, l);
      expect(on).not.toContain('data-testid="local-composer"');
      expect(on).not.toContain('ar-composer-note');
    }
  });
});

describe('Get ready sheet', () => {
  const sheet = (o: { meStatus: 'signed_out' | 'ready'; usdc: string | null; devnet?: boolean }, l: 'en' | 'de' = 'en') => html(
    <GetReadySheet
      wallet="W" meStatus={o.meStatus} usdc={o.usdc} devnet={o.devnet ?? true} signInBusy={false} signInError={null} paddleBusy={false} paddleError={null}
      onVerify={() => {}} onRefresh={() => {}} onStart={() => {}} onClose={() => {}}
    />, l);
  it('puts the sign-in note above the verify button', () => {
    const h = sheet({ meStatus: 'signed_out', usdc: null });
    expect(h).toContain('data-kind="signin"');
    expect(h.indexOf('data-kind="signin"')).toBeLessThan(h.indexOf('data-testid="ready-verify"'));
  });
  it('puts the bidding number note above the start button', () => {
    const h = sheet({ meStatus: 'ready', usdc: '20000000' });
    expect(h).toContain('data-kind="paddle"');
    expect(h.indexOf('data-kind="paddle"')).toBeLessThan(h.indexOf('data-testid="ready-start"'));
  });
  it('the notes follow the network: mainnet never says test money', () => {
    const dev = sheet({ meStatus: 'ready', usdc: '20000000', devnet: true });
    expect(dev).toContain('data-kind="paddle"');
    const main = sheet({ meStatus: 'signed_out', usdc: null, devnet: false });
    expect(main).toContain('data-kind="signin"');
    expect(main.replace(/<[^>]+>/g, ' ')).not.toMatch(/test USDC|test money/i);
  });
  it('speaks German', () => expect(sheet({ meStatus: 'signed_out', usdc: null }, 'de').replace(/<[^>]+>/g, ' ')).toContain('Ihre Wallet'));
});

describe('visitors without a wallet', () => {
  it('the sign-in gate says what a wallet is for and links to the help, in both languages', () => {
    for (const l of ['en', 'de'] as const) {
      const h = html(<GateView kind="connect" onSignIn={() => {}} walletButton={<button>wallet</button>} />, l);
      expect(h).toContain('data-testid="gate-no-wallet"');
      expect(h).toContain(`href="/${l}/about#wallet"`);
      expect(h).toContain('data-kind="signin"');
    }
  });
  it('the gate offers the help note in the sign step too, and not in the error steps', () => {
    expect(html(<GateView kind="sign" onSignIn={() => {}} walletButton={null} />)).toContain('data-kind="signin"');
    expect(html(<GateView kind="rejected" onSignIn={() => {}} walletButton={null} />)).not.toContain('data-testid="gate-no-wallet"');
  });
});

describe('the rooms page when there is nothing to show', () => {
  it('an empty schedule points to the house room and to selling', () => {
    const h = html(<ScheduleView state={{ status: 'ready', live: [], scheduled: [], ended: [] }} nowMs={0} origin="" />);
    expect(h).toContain('data-testid="rooms-empty"');
    expect(h).toContain('/room/house');
    expect(h).toContain('/sell');
  });
  it('an unavailable schedule says it retries by itself and still offers a way in', () => {
    const h = html(<ScheduleView state={{ status: 'error' }} nowMs={0} origin="" />);
    expect(h).toContain('data-testid="rooms-error"');
    expect(h).toContain('tries again by itself');
    expect(h).toContain('/room/house');
    expect(html(<ScheduleView state={{ status: 'error' }} nowMs={0} origin="" />, 'de')).toContain('von selbst erneut');
  });
  it('loading is announced politely', () => {
    expect(html(<ScheduleView state={{ status: 'loading' }} nowMs={0} origin="" />)).toMatch(/role="status"[^>]*data-testid="rooms-loading"/);
  });
});
