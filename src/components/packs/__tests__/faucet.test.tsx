/**
 * "Not enough USDC" in the pack purchase: on devnet the test-USDC button stands next to the message, on mainnet-beta never.
 * Rendered on the server with a stand-in purchase state (no DOM library is installed, so the click itself is not covered).
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import deMessages from '@/locales/de/packs.json';
import enMessages from '@/locales/en/packs.json';
import deRoom from '@/locales/de/room.json';
import enRoom from '@/locales/en/room.json';
import type { PackView } from '@/contracts';
import type { PurchaseState } from '../purchase';

(globalThis as unknown as { React: typeof React }).React = React;
const h = vi.hoisted(() => ({ state: { kind: 'idle' } as unknown }));
vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ connected: true }) }));
vi.mock('@/components/auth/SessionProvider', async () => (await import('@/components/ai/__tests__/session-mock')).sessionModule());
vi.mock('@/components/room/ConnectWalletButton', () => ({ default: () => null }));
vi.mock('../usePackPurchase', () => ({ usePackPurchase: () => ({ state: h.state, start: () => Promise.resolve(), reset: () => undefined, markShown: () => undefined, wallet: 'W' }) }));

const { default: BuyPanel } = await import('../BuyPanel');
const { session } = await import('@/components/ai/__tests__/session-mock');

const W = (n: number) => String(n).repeat(32).slice(0, 32).replace(/0/g, 'A');
const pack = (): PackView => ({
  id: '7b1c2d3e-4f50-4a61-8b72-000000000020', name: { de: 'Starter-Pack', en: 'Starter pack' }, description: null, imageUrl: null, mode: 'chance', status: 'live', cluster: 'devnet', price: '5000000',
  operator: { wallet: W(1), isHouse: true }, odds: [{ tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 10000, remaining: 3, total: 3 }], pool: { total: 3, remaining: 3 },
  commitment: { poolHash: 'ab'.repeat(32), oddsHash: 'cd'.repeat(32), committedAt: '2026-10-05T12:00:00.000Z' }, perWalletDailyCap: 5, vrfPublicKey: W(2), createdAt: '2026-10-05T12:00:00.000Z',
});
const render = (locale: 'de' | 'en', state: PurchaseState) => {
  h.state = state;
  session.status = 'signed-in';
  session.wallet = W(5);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ packs: locale === 'de' ? deMessages : enMessages, room: locale === 'de' ? deRoom : enRoom }}>
      <BuyPanel pack={pack()} locale={locale} />
    </NextIntlClientProvider>,
  );
};
afterEach(() => vi.unstubAllEnvs());

describe.each(['en', 'de'] as const)('not enough USDC in the pack purchase (%s)', (l) => {
  const msgs = l === 'de' ? deMessages : enMessages;
  const room = l === 'de' ? deRoom : enRoom;
  const short: PurchaseState = { kind: 'error', code: 'insufficient_usdc' };

  it('devnet: the message and the "get test USDC" button', () => {
    vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
    const html = render(l, short);
    expect(html).toContain(msgs.errors.insufficient_usdc);
    expect(html).toContain('data-testid="faucet-claim"');
    expect(html).toContain(room.ready.funds.claim);
  });
  it('mainnet-beta: the message, never the button', () => {
    vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'mainnet-beta');
    const html = render(l, short);
    expect(html).toContain(msgs.errors.insufficient_usdc);
    expect(html).not.toContain('faucet');
  });
  it('devnet, another failure: no button', () => {
    vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
    expect(render(l, { kind: 'error', code: 'rate_limited' })).not.toContain('faucet');
    expect(render(l, { kind: 'idle' })).not.toContain('faucet');
  });
});
