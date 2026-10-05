/**
 * "Your wallet does not hold enough USDC for this" when buying AI credits: on devnet the test-USDC button stands next to the message, on mainnet-beta never.
 * Rendered on the server (no DOM library is installed, so the click itself is not covered).
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import de from '@/locales/de/ai.json';
import en from '@/locales/en/ai.json';
import deRoom from '@/locales/de/room.json';
import enRoom from '@/locales/en/room.json';
import type { Cluster } from '@/contracts';
import { BuyError } from '../BuyCredits';

(globalThis as { React?: unknown }).React = React;
const wrap = (locale: 'de' | 'en', err: string | null, cluster: Cluster) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={{ ai: locale === 'de' ? de : en, room: locale === 'de' ? deRoom : enRoom }} timeZone="Europe/Berlin">
    <BuyError err={err} cluster={cluster} onFunded={() => {}} />
  </NextIntlClientProvider>,
);

describe.each(['en', 'de'] as const)('not enough USDC for credits (%s)', (l) => {
  const m = l === 'de' ? de : en;
  const room = l === 'de' ? deRoom : enRoom;
  it('devnet: the message and the "get test USDC" button', () => {
    const html = wrap(l, 'insufficient', 'devnet');
    expect(html).toContain(m.credits.insufficient);
    expect(html).toContain('data-testid="faucet-claim"');
    expect(html).toContain(room.ready.funds.claim);
  });
  it('mainnet-beta: the message, never the button', () => {
    const html = wrap(l, 'insufficient', 'mainnet-beta');
    expect(html).toContain(m.credits.insufficient);
    expect(html).not.toContain('faucet');
  });
  it('devnet, another failure or none: no button', () => {
    expect(wrap(l, 'failed', 'devnet')).not.toContain('faucet');
    expect(wrap(l, null, 'devnet')).toBe('');
  });
});
