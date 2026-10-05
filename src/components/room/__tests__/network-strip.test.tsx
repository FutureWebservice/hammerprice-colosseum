/**
 * The network line of a room: names the network a signature goes to ("Solana devnet") and holds the wallet-on-the-wrong-network steps and the
 * faucet link. It is not a banner about money: no "no real money" sentence, no legal notice. Absent on mainnet and in the practice room.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';

vi.mock('../room.css', () => ({}));
vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
(globalThis as { React?: unknown }).React = React;

const MESSAGES = { en: { room: enRoom }, de: { room: deRoom } };

async function strip(l: 'en' | 'de', network: string, wallet: boolean) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', network);
  const { default: NetworkStrip } = await import('../NetworkStrip');
  return renderToStaticMarkup(<NextIntlClientProvider locale={l} messages={MESSAGES[l] as never} timeZone="UTC"><NetworkStrip locale={l} wallet={wallet} /></NextIntlClientProvider>);
}

afterEach(() => vi.unstubAllEnvs());

describe('NetworkStrip', () => {
  it.each(['en', 'de'] as const)('on devnet it names the network, shows the wallet steps and the faucet link, and says nothing about money (%s)', async (l) => {
    const m = await strip(l, 'devnet', true);
    expect(m).toContain('data-testid="network-strip"');
    expect(m).toContain(l === 'en' ? 'Solana devnet' : 'Solana Devnet');
    expect(m).toContain(`href="/${l}/account#funds"`);
    expect(m).not.toMatch(/real money|echtes Geld|test network|Testnetz|Demonstration/i);
  });
  it('is gone on mainnet and in a room that does not settle with a wallet', async () => {
    expect(await strip('en', 'mainnet-beta', true)).toBe('');
    expect(await strip('en', 'devnet', false)).toBe('');
  });
});
