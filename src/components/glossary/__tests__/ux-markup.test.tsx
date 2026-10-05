/**
 * Markup of the help pieces in their first (server) render, with the real messages. No DOM library is installed, so
 * clicks, focus and keys are not run; here: what is drawn, in both
 * languages and on both networks.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enTour from '@/locales/en/tour.json';
import deTour from '@/locales/de/tour.json';
import enGl from '@/locales/en/glossary.json';
import deGl from '@/locales/de/glossary.json';
import type { Cluster } from '@/contracts';
import Term from '../Term';
import GlossaryList from '../GlossaryList';
import NextStepLine from '@/components/explain/NextStepLine';
import WalletPromptHint, { HINT_KINDS } from '@/components/explain/WalletPromptHint';
import Advanced from '@/components/explain/Advanced';
import HelpMenu from '@/components/tour/HelpMenu';
import type { NextStepState } from '@/lib/client/next-step';

(globalThis as unknown as { React: typeof React }).React = React;

const MSG = { en: { tour: enTour, glossary: enGl }, de: { tour: deTour, glossary: deGl } };
const html = (ui: React.ReactElement, l: 'en' | 'de' = 'en') =>
  renderToStaticMarkup(<NextIntlClientProvider locale={l} messages={MSG[l]} timeZone="Europe/Berlin">{ui}</NextIntlClientProvider>);
const text = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('Term', () => {
  it('draws a closed button with the label, aria-expanded false and a dialog popup', () => {
    const h = html(<Term id="usdc" />);
    expect(h).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*>USDC<\/button>/);
    expect(h).toContain('data-term="usdc"');
    expect(h).not.toContain('role="dialog"');
  });
  it('shows the children instead of the label when given', () => {
    expect(html(<Term id="networkFee">fees</Term>)).toContain('>fees</button>');
  });
  it('speaks German', () => expect(html(<Term id="paddle" />, 'de')).toContain('>Bieternummer</button>'));
  it('is plain text for a test-network word on mainnet, a button on devnet', () => {
    expect(html(<Term id="testUsdc" cluster="mainnet-beta">free coins</Term>)).toBe('free coins');
    expect(html(<Term id="testUsdc" cluster="devnet" />)).toContain('<button');
    expect(html(<Term id="usdc" cluster="mainnet-beta" />)).toContain('<button');
  });
});

describe('GlossaryList', () => {
  const ids = (h: string) => [...h.matchAll(/data-term="(\w+)"/g)].map((m) => m[1]);
  it('lists all 19 terms on devnet, each with its sentence, under id="glossary"', () => {
    const h = html(<GlossaryList cluster="devnet" />);
    expect(h).toContain('id="glossary"');
    expect(ids(h)).toHaveLength(19);
    expect(text(h)).toContain('Free USDC for trying the site out');
  });
  it('drops the test-network terms and the test wording on mainnet', () => {
    for (const l of ['en', 'de'] as const) {
      const h = html(<GlossaryList cluster="mainnet-beta" />, l);
      expect(ids(h)).toHaveLength(16);
      expect(ids(h)).not.toContain('testUsdc');
      expect(text(h)).not.toMatch(/test|replik|replica|devnet/i);
    }
  });
});

const STATE: NextStepState = { wallet: null, me: 'off', usdc: null, hasPaddle: false, show: 'live', standing: 'none', settlement: null };
describe('NextStepLine', () => {
  it('writes the sentence for the state, in both languages', () => {
    expect(text(html(<NextStepLine state={STATE} cluster="devnet" />))).toContain('Connect your wallet to bid.');
    expect(text(html(<NextStepLine state={STATE} cluster="devnet" />, 'de'))).toContain('Verbinden Sie Ihre Wallet, um mitzubieten.');
  });
  it('is a polite status line carrying the step key', () => {
    const h = html(<NextStepLine state={{ ...STATE, settlement: 'won' }} cluster="devnet" />);
    expect(h).toContain('role="status"');
    expect(h).toContain('data-step="won"');
  });
  it('uses the mainnet wording for funds and never says test there', () => {
    const s = { ...STATE, wallet: 'W', me: 'ready' as const, usdc: '0' };
    expect(text(html(<NextStepLine state={s} cluster="devnet" />))).toContain('Get free test USDC.');
    const main = text(html(<NextStepLine state={s} cluster={'mainnet-beta' as Cluster} />));
    expect(main).toContain('Add USDC to your wallet.');
    expect(main).not.toMatch(/test/i);
  });
});

describe('WalletPromptHint', () => {
  it.each(HINT_KINDS)('%s: a titled note with its sentence in both languages', (kind) => {
    for (const l of ['en', 'de'] as const) {
      const h = html(<WalletPromptHint kind={kind} cluster="devnet" />, l);
      expect(h).toContain(`data-kind="${kind}"`);
      expect(h).toContain('data-compact="false"');
      expect(text(h)).toContain(l === 'en' ? 'What your wallet shows next' : 'Was Ihre Wallet gleich zeigt');
      expect(text(h)).toContain(l === 'en' ? 'Why does my wallet ask this?' : 'Warum fragt meine Wallet das?');
    }
  });
  it('says the wallet may add its own notes, and does not describe a particular wallet', () => {
    const h = text(html(<WalletPromptHint kind="pay" cluster="devnet" />));
    expect(h).toContain('Your wallet may show its own notes.');
    expect(h).not.toMatch(/phantom|solflare|backpack/i);
  });
  it('the listing hint needs no wallet confirmation and so omits the caveat', () => {
    expect(text(html(<WalletPromptHint kind="consign" cluster="devnet" />))).not.toContain('own notes');
  });
  it('credits and pay say plain USDC on every network, never test money', () => {
    for (const cluster of ['devnet', 'mainnet-beta'] as const) {
      const credits = text(html(<WalletPromptHint kind="credits" cluster={cluster} />));
      expect(credits).toContain('1 USDC');
      expect(credits).not.toMatch(/test/i);
      expect(text(html(<WalletPromptHint kind="pay" cluster={cluster} />))).not.toMatch(/test|Hammerprice pays/i);
    }
  });
});

describe('Advanced and HelpMenu', () => {
  it('Advanced is a closed details with the one word as title, in both languages', () => {
    const h = html(<Advanced id="limit"><p>inside</p></Advanced>);
    expect(h).toMatch(/<details[^>]*data-testid="advanced-limit"/);
    expect(h).not.toMatch(/<details[^>]*\sopen/);
    expect(h).toContain('<summary>Advanced options</summary>');
    expect(html(<Advanced id="limit">x</Advanced>, 'de')).toContain('<summary>Erweitert</summary>');
  });
  it('Advanced can start open', () => expect(html(<Advanced id="a" defaultOpen>x</Advanced>)).toMatch(/<details[^>]*\sopen/));
  it('HelpMenu is a closed disclosure button that carries the tour anchor', () => {
    const h = html(<HelpMenu />);
    expect(h).toContain('data-tour="help"');
    expect(h).toContain('aria-expanded="false"');
    expect(h).not.toContain('data-testid="help-list"');
    expect(text(html(<HelpMenu />, 'de'))).toContain('Hilfe');
  });
});
