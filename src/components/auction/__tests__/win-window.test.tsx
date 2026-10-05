/**
 * K7: after the payment deadline the win dialog says "payment window ended" by itself, from the deadline and the server clock,
 * without waiting for the server to book the expiry (which it does lazily).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/room.json';
import de from '@/locales/de/room.json';
import WinModal, { settlementPhase, windowEnded } from '../WinModal';
import type { RoomLot } from '../types';

(globalThis as unknown as { React: typeof React }).React = React;

const DUE = '2026-10-06T12:00:00.000Z';
const T = Date.parse(DUE);

describe('windowEnded', () => {
  it('is false before the deadline, true at and after it, false without a deadline or a clock', () => {
    expect(windowEnded(DUE, T - 1)).toBe(false);
    expect(windowEnded(DUE, T)).toBe(true);
    expect(windowEnded(DUE, T + 60_000)).toBe(true);
    expect(windowEnded(undefined, T + 1)).toBe(false);
    expect(windowEnded(null, T + 1)).toBe(false);
    expect(windowEnded(DUE, null)).toBe(false);
    expect(windowEnded('not a time', T)).toBe(false);
  });
});

describe('settlementPhase', () => {
  const s = (status: string) => ({ id: 'S1', status });
  it('turns only the open "awaiting" state into windowEnded', () => {
    expect(settlementPhase(s('awaiting_payment'))).toBe('awaiting');
    expect(settlementPhase(s('awaiting_payment'), true)).toBe('windowEnded');
    expect(settlementPhase(s('awaiting_seller'), true)).toBe('windowEnded');
  });
  it('never turns back a payment that is on its way or done, and keeps the server booked states', () => {
    expect(settlementPhase(s('submitted'), true)).toBe('submitted');
    expect(settlementPhase(s('settled'), true)).toBe('settled');
    expect(settlementPhase(s('expired'), true)).toBe('lapsed');
    expect(settlementPhase(s('failed'), true)).toBe('lapsed');
    expect(settlementPhase(undefined, true)).toBe('pending');
  });
});

const lot: RoomLot = {
  id: 'L1', lotNumber: 1, name: 'Card', increment: '1000000', openingPrice: '1000000', highBid: '5000000', highBidderIsMe: true, state: 'sold',
  settlement: { id: 'S1', status: 'awaiting_payment' },
};
const render = (l: 'en' | 'de', nowMs: number | null) => renderToStaticMarkup(
  <NextIntlClientProvider locale={l} timeZone="UTC" messages={{ room: l === 'en' ? en : de } as never}>
    <WinModal won={{ lot, amount: 5_000_000n }} lots={[lot]} practice={false} cluster="devnet" locale={l}
      dueAtBySettlement={new Map([['S1', DUE]])} nowMs={nowMs} onPay={() => undefined} onClose={() => undefined} />
  </NextIntlClientProvider>,
);

describe('WinModal', () => {
  it.each(['en', 'de'] as const)('shows "payment due" and the pay button before the deadline (%s)', (l) => {
    const h = render(l, T - 5_000);
    expect(h).toContain('data-phase="awaiting"');
    expect(h).toContain('data-testid="win-pay"');
  });
  it.each(['en', 'de'] as const)('shows "payment window ended" and no pay button after the deadline (%s)', (l) => {
    const h = render(l, T + 5_000);
    expect(h).toContain('data-phase="windowEnded"');
    expect(h).not.toContain('data-testid="win-pay"');
    expect(h.replace(/&#x27;/g, "'")).toContain((l === 'en' ? en : de).win.status.windowEnded);
  });
  it('keeps the old behaviour when no deadline or clock is known', () => {
    expect(render('en', null)).toContain('data-phase="awaiting"');
  });
  it('has the new text in both languages without an em dash', () => {
    for (const m of [en, de]) { expect(m.win.status.windowEnded.length).toBeGreaterThan(20); expect(m.win.status.windowEnded).not.toContain('\u2014'); }
  });
});
