/**
 * The room link of a Telegram lot alert (`?lot=<n>&bid=<amount>`): the parameters are validated, and they only pre-fill the existing bid
 * confirmation. Pure rules first, then the real BidControl rendered in both languages (no DOM library in this repo: states are rendered to markup).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/room.json';
import de from '@/locales/de/room.json';
import { MAX_BID } from '@/contracts/common';
import BidControl from '../BidControl';
import { parseBidPrefill, prefillAmount, withoutPrefill } from '../prefill';
import type { BidGate } from '../model';
import type { RoomLot } from '../types';

(globalThis as unknown as { React: typeof React }).React = React;

describe('parseBidPrefill: untrusted text from the address bar', () => {
  it('reads a lot number and a decimal amount in USDC into base units', () => {
    expect(parseBidPrefill('?lot=3&bid=55.00')).toEqual({ lot: 3, amount: 55_000_000n });
    expect(parseBidPrefill('?bid=60.5&lot=12')).toEqual({ lot: 12, amount: 60_500_000n });
    expect(parseBidPrefill('?lot=1&bid=7')).toEqual({ lot: 1, amount: 7_000_000n });
    expect(parseBidPrefill('?lot=9999&bid=0.000001')).toEqual({ lot: 9999, amount: 1n });
    expect(parseBidPrefill('?x=1&lot=2&bid=10.25&settle=abc')).toEqual({ lot: 2, amount: 10_250_000n });
  });
  it('refuses everything that is not a plain positive integer lot and a plain decimal amount', () => {
    const bad = [
      '', '?lot=3', '?bid=55', '?lot=0&bid=5', '?lot=-1&bid=5', '?lot=10000&bid=5', '?lot=1.5&bid=5', '?lot=0x3&bid=5', '?lot=3e1&bid=5', '?lot=%203&bid=5', '?lot=abc&bid=5',
      '?lot=3&bid=0', '?lot=3&bid=0.0', '?lot=3&bid=-5', '?lot=3&bid=1e3', '?lot=3&bid=1,5', '?lot=3&bid=.5', '?lot=3&bid=5.', '?lot=3&bid=5.1234567', '?lot=3&bid=NaN', '?lot=3&bid=Infinity',
      '?lot=3&bid=0x10', '?lot=3&bid=<script>', '?lot=3&bid=99999999', '?lot=3&bid=' + '9'.repeat(40),
      '?lot=3&lot=4&bid=5', '?lot=3&bid=5&bid=6', '?lot=3&bid=',
    ];
    for (const q of bad) expect(parseBidPrefill(q), q).toBeNull();
  });
  it('is bounded by the engine\'s bid cap', () => {
    expect(MAX_BID).toBe(1_000_000_000_000n); // 1,000,000 USDC
    expect(parseBidPrefill('?lot=1&bid=1000000')).toEqual({ lot: 1, amount: MAX_BID });
    expect(parseBidPrefill('?lot=1&bid=1000000.01')).toBeNull();
  });
});

describe('prefillAmount: a link can raise the shown amount a little, never lower it, never far', () => {
  const min = 55_000_000n;
  it('uses the amount from the minimum up to twice the minimum', () => {
    expect(prefillAmount({ amount: min }, min)).toEqual({ amount: min, used: true });
    expect(prefillAmount({ amount: 60_500_000n }, min)).toEqual({ amount: 60_500_000n, used: true });
    expect(prefillAmount({ amount: min * 2n }, min)).toEqual({ amount: min * 2n, used: true });
  });
  it('shows the current minimum when the amount is below it (someone bid since) or far above it', () => {
    expect(prefillAmount({ amount: 50_000_000n }, min)).toEqual({ amount: min, used: false });
    expect(prefillAmount({ amount: 1n }, min)).toEqual({ amount: min, used: false });
    expect(prefillAmount({ amount: min * 2n + 1n }, min)).toEqual({ amount: min, used: false });
    expect(prefillAmount({ amount: MAX_BID }, min)).toEqual({ amount: min, used: false });
  });
});

describe('withoutPrefill: a reload must not replay it', () => {
  it('removes lot and bid, keeps the rest', () => {
    expect(withoutPrefill('/en/room/S1', '?lot=3&bid=55.00', '')).toBe('/en/room/S1');
    expect(withoutPrefill('/en/room/S1', '?settle=T1&lot=3&bid=55.00', '#x')).toBe('/en/room/S1?settle=T1#x');
  });
});

const lot: RoomLot = { id: 'L3', lotNumber: 3, name: 'Charizard', increment: '5000000', openingPrice: '50000000', highBid: '50000000', reserve: '100000000', state: 'open', closesAt: '2026-10-05T12:00:00Z' };
const NEXT = 55_000_000n;

function render(l: 'en' | 'de', over: { gate?: BidGate; prefill?: { amount: bigint } | null; paddle?: number | null; lot?: RoomLot } = {}) {
  const gate = over.gate ?? 'ready';
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={l} timeZone="UTC" messages={{ room: l === 'en' ? en : de } as never} onError={(e) => { throw e; }}>
      <BidControl
        lot={over.lot ?? lot} gate={gate} busy={false} nextAmount={NEXT} visitor={{ status: 'none' } as never} phase={'live' as never} paddleNumber={over.paddle === undefined ? 7 : over.paddle} practice={false}
        pending={false} pendingServer={false} error={null} balance={{ usdc: '1000000000' }} devnet locale={l}
        prefill={over.prefill === undefined ? null : over.prefill} onGate={() => undefined} onConfirm={async () => true} onDismissError={() => undefined}
      />
    </NextIntlClientProvider>,
  );
}
const has = (m: string, id: string) => new RegExp(`data-testid="${id}"`).test(m);
const text = (m: string, id: string) => new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m)?.[1];

describe('the bid confirmation opens pre-filled', () => {
  it.each(['en', 'de'] as const)('%s: with an amount from the link the confirmation is open with that amount and the "from your link" line, and still needs the confirm button', (l) => {
    const m = render(l, { prefill: { amount: 60_500_000n } });
    expect(has(m, 'bid-panel')).toBe(true);
    expect(text(m, 'bid-amount')).toMatch(l === 'en' ? /\$60\.50/ : /60,50/);
    expect(has(m, 'bid-from-link')).toBe(true);
    expect(m).toContain((l === 'en' ? en : de).bidPanel.fromLink);
    expect(has(m, 'bid-confirm')).toBe(true); // the person presses it and signs in their own wallet: nothing was sent by rendering
    expect(m).toContain((l === 'en' ? en : de).bidPanel.binding.slice(0, 20));
  });
  it('the amount of the link equal to the next bid is shown as is', () => {
    expect(text(render('en', { prefill: { amount: NEXT } }), 'bid-amount')).toMatch(/\$55\.00/);
  });
  it.each(['en', 'de'] as const)('%s: an amount below the minimum, or far above it, shows the current next bid and says so', (l) => {
    for (const amount of [50_000_000n, 1n, 500_000_000n]) {
      const m = render(l, { prefill: { amount } });
      expect(text(m, 'bid-amount'), String(amount)).toMatch(l === 'en' ? /\$55\.00/ : /55,00/);
      expect(m).toContain((l === 'en' ? en : de).bidPanel.fromLinkAdjusted);
    }
  });
  it('without a link there is no open panel, and a visitor who is not ready sees the Get ready slab, not a confirmation', () => {
    expect(has(render('en'), 'bid-panel')).toBe(false);
    for (const gate of ['connect', 'sign_in', 'register'] as const) {
      const m = render('en', { gate, prefill: { amount: NEXT } });
      expect(has(m, 'bid-panel'), gate).toBe(false);
      expect(m).toContain(en.bid.getReady);
    }
    expect(has(render('en', { gate: 'leading', prefill: { amount: NEXT } }), 'bid-panel')).toBe(false);
  });
  it('the new words exist in both languages, say that nothing is placed before the confirm, and have no em dash', () => {
    for (const [l, r] of [['en', en], ['de', de]] as const) {
      for (const s of [r.bidPanel.fromLink, r.bidPanel.fromLinkAdjusted, r.prefill.notOpen]) expect(s, l).not.toContain('\u2014');
      expect(r.prefill.notOpen).toContain('{number}');
    }
    expect(en.bidPanel.fromLink).toMatch(/Nothing is placed until you confirm and sign in your own wallet/);
    expect(de.bidPanel.fromLink).toMatch(/erst etwas abgegeben, wenn Sie bestätigen und in Ihrer eigenen Wallet unterschreiben/);
  });
});

describe('the bidder-number line is about the viewer, never about the room', () => {
  const scheduled: RoomLot = { ...lot, state: 'catalogued', closesAt: null } as RoomLot;
  it.each(['en', 'de'] as const)('%s: without a bidder number it says bidding is open (lot open) or opens soon (not yet), and never "not ready"', (l) => {
    const r = l === 'en' ? en : de;
    const open = render(l, { gate: 'register', paddle: null });
    expect(text(open, 'bid-no-paddle')).toBe(r.bid.noPaddleOpen);
    const soon = render(l, { gate: 'register', paddle: null, lot: scheduled });
    expect(text(soon, 'bid-no-paddle')).toBe(r.bid.noPaddleSoon);
    for (const s of [r.bid.noPaddleOpen, r.bid.noPaddleSoon]) { expect(s).not.toMatch(/not ready|nicht bereit/i); expect(s).not.toContain('\u2014'); }
  });
  it('the words are the agreed ones', () => {
    expect(en.bid.noPaddleOpen).toBe('Bidding is open. Get your bidder number to join.');
    expect(en.bid.noPaddleSoon).toBe('Bidding opens soon. You can get your bidder number now.');
    expect(de.bid.noPaddleOpen).toBe('Das Bieten ist offen. Holen Sie sich Ihre Bieternummer, um teilzunehmen.');
    expect(de.bid.noPaddleSoon).toBe('Das Bieten startet gleich. Sie können Ihre Bieternummer schon jetzt holen.');
  });
  it('a viewer who has a number sees it, not this line', () => {
    expect(has(render('en', { paddle: 7 }), 'bid-no-paddle')).toBe(false);
  });
});
