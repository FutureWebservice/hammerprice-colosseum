/**
 * "Not enough USDC" in the room (the bid panel, the payment dialog): on devnet the shared Get test USDC button sits next to
 * that message, never on mainnet-beta, and a successful claim re-reads the balance and drops the error.
 * No DOM library in this repo: the markup is rendered, and the click handler of the real FaucetButton is picked up while it
 * renders and called (claimFaucet is mocked), so the claim path itself runs.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/locales/en/room.json';
import de from '@/locales/de/room.json';
import enSettle from '@/locales/en/settlement.json';
import deSettle from '@/locales/de/settlement.json';

vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('../room.css', () => ({}));
vi.mock('@/components/account/api', () => ({ claimFaucet: vi.fn() }));
vi.mock('@/components/explain/WalletPromptHint', () => ({ default: () => null, markHintConfirmed: () => undefined }));
const settlement = vi.hoisted(() => ({ failure: null as { kind: string; code?: unknown } | null }));
vi.mock('@/hooks/useSettlement', () => ({
  useSettlement: () => ({ view: null, state: null, step: 'retry', review: null, failure: settlement.failure, busy: false, sign: () => undefined }),
}));

import { claimFaucet } from '@/components/account/api';
import BidControl from '@/components/auction/BidControl';
import PayModal from '../PayModal';
import type { RoomLot } from '@/components/auction/types';

(globalThis as unknown as { React: typeof React }).React = React; // vitest compiles JSX with the classic runtime

const claim = vi.mocked(claimFaucet);
const MSG = { en: { room: en, settlement: enSettle }, de: { room: de, settlement: deSettle } };
type L = 'en' | 'de';
const html = (ui: React.ReactElement, l: L = 'en') =>
  renderToStaticMarkup(<NextIntlClientProvider locale={l} timeZone="UTC" messages={MSG[l] as never} onError={(e) => { throw e; }}>{ui}</NextIntlClientProvider>);

/** Renders `ui` and returns the click handler of the claim button inside it (the real FaucetButton's own). */
function claimHandler(ui: React.ReactElement, l: L = 'en'): () => void {
  let onClick: (() => void) | undefined;
  const create = React.createElement;
  const spy = vi.spyOn(React, 'createElement').mockImplementation(((type: never, props: Record<string, unknown> | null, ...kids: never[]) => {
    if (props?.['data-testid'] === 'faucet-claim') onClick = props.onClick as () => void;
    return create(type, props, ...kids);
  }) as typeof React.createElement);
  try { html(ui, l); } finally { spy.mockRestore(); }
  if (!onClick) throw new Error('no claim button rendered');
  return onClick;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const count = (m: string, id: string) => m.split(`data-testid="${id}"`).length - 1;

beforeEach(() => { claim.mockReset(); });

// --- the bid panel -----------------------------------------------------------------------------

const lot: RoomLot = { id: 'L3', lotNumber: 3, name: 'Charizard', increment: '5000000', openingPrice: '50000000', highBid: '50000000', reserve: '100000000', state: 'open', closesAt: '2026-10-05T12:00:00Z' };
const NEXT = 55_000_000n;
const ENOUGH = '1000000000';
const LOW = '1000000';

function bidControl(l: L, o: { devnet?: boolean; usdc?: string; error?: string | null; fundsShort?: boolean; onFunded?: () => void; onDismissError?: () => void } = {}) {
  return (
    <BidControl
      lot={lot} gate="ready" busy={false} nextAmount={NEXT} visitor={{ status: 'none' } as never} phase={'live' as never} paddleNumber={7} practice={false}
      pending={false} pendingServer={false} error={o.error === undefined ? null : o.error} fundsShort={o.fundsShort} balance={{ usdc: o.usdc ?? ENOUGH }}
      devnet={o.devnet ?? true} locale={l} prefill={{ amount: NEXT }} // the prefill opens the bid panel at once
      onGate={() => undefined} onConfirm={async () => false} onDismissError={o.onDismissError ?? (() => undefined)} onFunded={o.onFunded}
    />
  );
}

describe('the bid panel: "your USDC does not cover this bid"', () => {
  it.each(['en', 'de'] as const)('%s: devnet shows the button inside the error, once', (l) => {
    const error = (l === 'en' ? en : de).errors.insufficient_funds;
    const m = html(bidControl(l, { error, fundsShort: true }), l);
    expect(m).toMatch(new RegExp(`data-testid="bid-error">${error}[^<]*<span[^>]*data-testid="faucet-button"`));
    expect(count(m, 'faucet-button')).toBe(1);
    expect(m).toContain((l === 'en' ? en : de).ready.funds.claim);
  });
  it('mainnet-beta shows the error and no button, also when the balance is low', () => {
    const error = en.errors.insufficient_funds;
    for (const usdc of [ENOUGH, LOW]) {
      const m = html(bidControl('en', { devnet: false, error, fundsShort: true, usdc }));
      expect(m).toContain(error);
      expect(m).not.toContain('faucet-button');
    }
  });
  it('another error (not the funds one) gets no button', () => {
    const m = html(bidControl('en', { error: en.errors.bid_too_low.replace('{amount}', '$60') }));
    expect(m).not.toContain('faucet-button');
  });
  it('the low-balance line gets the button on devnet (instead of the link to the account page), and with the funds error still only one', () => {
    const low = html(bidControl('en', { usdc: LOW }));
    expect(count(low, 'faucet-button')).toBe(1);
    expect(low).toMatch(/data-testid="bid-balance">[^]*faucet-button/);
    expect(low).not.toContain('#funds');
    const both = html(bidControl('en', { usdc: LOW, error: en.errors.insufficient_funds, fundsShort: true }));
    expect(count(both, 'faucet-button')).toBe(1);
    expect(both).toMatch(/data-testid="bid-error">[^]*faucet-button/);
  });
  it('a wallet with enough USDC on devnet keeps just the link', () => {
    const m = html(bidControl('en'));
    expect(m).not.toContain('faucet-button');
    expect(m).toContain('#funds');
  });
  it('a successful claim re-reads the balance and clears the error', async () => {
    claim.mockResolvedValue({ ok: true } as never);
    const onFunded = vi.fn();
    const onDismissError = vi.fn();
    const click = claimHandler(bidControl('en', { error: en.errors.insufficient_funds, fundsShort: true, onFunded, onDismissError }));
    click();
    await flush();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });
  it('a failed claim changes nothing (the button shows its own message)', async () => {
    claim.mockResolvedValue({ ok: false, code: 'rate_limited' } as never);
    const onFunded = vi.fn();
    const onDismissError = vi.fn();
    claimHandler(bidControl('en', { error: en.errors.insufficient_funds, fundsShort: true, onFunded, onDismissError }))();
    await flush();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(onFunded).not.toHaveBeenCalled();
    expect(onDismissError).not.toHaveBeenCalled();
  });
});

// --- the payment dialog ------------------------------------------------------------------------

const pay = (cluster: string | null, onFunded?: () => void) => (
  <PayModal settlementId="S1" cluster={cluster} agreedGross="55000000" locale="en" serverOffset={0} onFunded={onFunded} onClose={() => undefined} />
);

describe('the payment dialog: "your USDC balance does not cover this payment"', () => {
  beforeEach(() => { settlement.failure = { kind: 'api', code: 'insufficient_usdc' }; });

  it.each(['en', 'de'] as const)('%s: devnet shows the button inside the error', (l) => {
    const m = html(pay('devnet'), l);
    expect(m).toContain((l === 'en' ? enSettle : deSettle).errors.insufficient_usdc);
    expect(m).toMatch(/data-testid="settle-error">[^]*data-testid="faucet-button"/);
    expect(count(m, 'faucet-button')).toBe(1);
    expect(m).toContain((l === 'en' ? en : de).ready.funds.claim);
  });
  it('mainnet-beta (and an unknown cluster) shows the error and no button', () => {
    for (const cluster of ['mainnet-beta', null]) {
      const m = html(pay(cluster));
      expect(m).toContain(enSettle.errors.insufficient_usdc);
      expect(m).not.toContain('faucet-button');
    }
  });
  it('another failure on devnet gets no button', () => {
    settlement.failure = { kind: 'api', code: 'rate_limited' };
    const m = html(pay('devnet'));
    expect(m).toContain('data-testid="settle-error"');
    expect(m).not.toContain('faucet-button');
  });
  it('a successful claim calls the refresh; the pay button stays for the next press', async () => {
    claim.mockResolvedValue({ ok: true } as never);
    const onFunded = vi.fn();
    claimHandler(pay('devnet', onFunded))();
    await flush();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(onFunded).toHaveBeenCalledTimes(1);
    expect(html(pay('devnet'))).toContain('data-testid="sign-button"');
  });
});
