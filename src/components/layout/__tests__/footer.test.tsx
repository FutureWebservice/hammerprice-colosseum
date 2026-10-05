/**
 * The footer: links into the About page (How it works, the pitch and the FAQ are its sections), no prize sentence and no
 * submission count, and one small "demo operation" line that exists only while the cluster is not mainnet (it follows
 * SOLANA_CLUSTER through NEXT_PUBLIC_SOLANA_NETWORK, the switch the legal pages and the test-network notice already use).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enFooter from '@/locales/en/footer.json';
import deFooter from '@/locales/de/footer.json';

vi.mock('@/lib/i18n', () => ({
  Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => React.createElement('a', { href, ...p }, children),
}));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

const MESSAGES = { en: enFooter, de: deFooter };
const EM_DASH = String.fromCharCode(0x2014);

async function footer(locale: 'en' | 'de', network?: string) {
  vi.resetModules();
  if (network === undefined) vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', ''); else vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', network);
  const { default: Footer } = await import('../Footer');
  return renderToStaticMarkup(
    React.createElement(NextIntlClientProvider as React.ComponentType<Record<string, unknown>>, { locale, messages: { footer: MESSAGES[locale] }, timeZone: 'Europe/Berlin' }, React.createElement(Footer)),
  );
}

afterEach(() => vi.unstubAllEnvs());

describe('footer', () => {
  for (const locale of ['en', 'de'] as const) {
    it(`links to the same pages as the header and says nothing about a prize or a submission count (${locale})`, async () => {
      const m = await footer(locale, 'devnet');
      for (const a of ['/', '/rooms', '/sell', '/account', '/ai', '/about']) expect(m).toContain(`href="${a}"`); // the same items as the header bar
      expect(m).not.toMatch(/href="\/(?:how-it-works|pitch|faq)/);
      expect(m).not.toMatch(/38|Ideathon|prize winner|Preisträger|Einreichungen|submissions/);
      expect(m).toContain(locale === 'de' ? 'Gebaut für den Colosseum-Hackathon.' : 'Built for the Colosseum hackathon.');
    });

    it(`shows the demo line on the test network and not on mainnet (${locale})`, async () => {
      const line = locale === 'de' ? 'Demonstrationsbetrieb: Testnetz, Test-USDC und Replikat-Karten' : 'Demo operation: test network, test USDC and replica cards';
      for (const net of ['devnet', undefined]) expect(await footer(locale, net), String(net)).toContain(line);
      for (const net of ['mainnet-beta', 'mainnet']) {
        const m = await footer(locale, net);
        expect(m, net).not.toContain(line);
        expect(m, net).not.toContain('footer-demo');
      }
    });
  }

  it('the new strings carry no em dash', () => {
    for (const f of [enFooter, deFooter]) expect(JSON.stringify(f)).not.toContain(EM_DASH);
  });
});
