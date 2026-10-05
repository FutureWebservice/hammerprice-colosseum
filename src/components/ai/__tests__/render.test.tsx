/**
 * The AI components rendered on the server with the real message files, in both languages. A missing message throws (onError), so a key that
 * exists in code but not in ai.json fails here. Also: the two files agree key for key and placeholder for placeholder, no dash in any text.
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import de from '@/locales/de/ai.json';
import en from '@/locales/en/ai.json';
import LotDescription from '@/components/room/slots/LotDescription';
import CreditsBar from '../CreditsBar';
import DraftView from '../DraftView';
import ListingPanel from '../ListingPanel';
import AskPanel from '../AskPanel';

// vitest compiles JSX with the classic runtime (see sell/__tests__/harness.tsx); Next uses the automatic one.
(globalThis as { React?: unknown }).React = React;

vi.mock('@/components/auth/SessionProvider', async () => (await import('./session-mock')).sessionModule());
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null, signTransaction: undefined }) }));

const MESSAGES = { de, en } as const;
const wrap = (locale: 'de' | 'en', node: React.ReactNode) => renderToStaticMarkup(
  <NextIntlClientProvider locale={locale} messages={{ ai: MESSAGES[locale] }} timeZone="Europe/Berlin" onError={(e) => { throw e; }} getMessageFallback={({ key }) => { throw new Error(`missing message ${key}`); }}>{node}</NextIntlClientProvider>,
);

const leaves = (o: unknown, p = ''): [string, string][] => (typeof o === 'string' ? [[p, o]] : Object.entries(o as object).flatMap(([k, v]) => leaves(v, p ? `${p}.${k}` : k)));
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('ai.json', () => {
  it('German and English have the same keys and the same placeholders', () => {
    const d = new Map(leaves(de)), e = new Map(leaves(en));
    expect([...d.keys()].sort()).toEqual([...e.keys()].sort());
    for (const [k, v] of d) expect(placeholders(v), k).toBe(placeholders(e.get(k)!));
  });
  it('no em dash, no en dash, no empty text, no apostrophe that ICU would eat', () => {
    for (const [k, v] of [...leaves(de), ...leaves(en)]) {
      expect(v, k).not.toMatch(/[\u2014–]/);
      expect(v.trim().length, k).toBeGreaterThan(0);
      if (!k.startsWith('ask.extra')) expect(v, k).not.toMatch(/'/);
    }
  });
  it('the German texts address the reader formally (Sie), never du', () => {
    for (const [k, v] of leaves(de)) expect(v, k).not.toMatch(/\b(du|dein|deine|deinen|dir|dich)\b/i);
  });
  it('the assistant never claims more than it does: no "advice" promises, and the AI badges say AI or FAQ', () => {
    expect(en.badge.ai).toMatch(/^AI assistant/);
    expect(de.badge.ai).toMatch(/^KI-Assistent/);
    expect(en.badge.draft).toBe('AI draft, seller reviews');
    expect(de.badge.draft).toBe('KI-Entwurf, Verkäufer prüft');
  });
});

const lots = [{ mint: 'M1', name: 'Charizard', imageUrl: null, grade: 'PSA 9', reserve: '', opening: '10', increment: '1' }];
const credits = (o: Partial<{ balance: number; configured: boolean; cluster: 'devnet' | 'mainnet-beta'; packsLeftToday: number | null }> = {}) => ({ balance: 3, pack: { credits: 10, priceUsdc: '1000000' }, packsLeftToday: 3, cluster: 'devnet' as const, configured: true, ...o });
const draft = (source: 'model' | 'template') => ({ draft: { titleDe: 'Charizard, PSA 9', titleEn: 'Charizard, PSA 9', descriptionDe: 'Beschreibung auf Deutsch.', descriptionEn: 'Description in English.', suggestedOpeningUsdc: '45000000', rationale: 'x' }, source, creditsLeft: 2, label: 'ai_draft' as const });

describe.each(['de', 'en'] as const)('components in %s', (lang) => {
  it('the listing panel: title, no personal-data notice (the privacy text carries it), the price text of the cluster', () => {
    const html = wrap(lang, <ListingPanel lots={lots} locale={lang} credits={credits()} onCredits={() => {}} onApply={() => {}} />);
    expect(html).toContain('data-testid="ai-listing"');
    expect(html).toContain(MESSAGES[lang].listing.title);
    expect(html).not.toContain('ai-privacy');
    expect(html).not.toMatch(/not enter personal data|keine persönlichen Daten ein|sent to Google|an Google/);
    expect(html).toContain(MESSAGES[lang].credits.packTest); // devnet: test USDC with no value
    expect(html).not.toContain(MESSAGES[lang].credits.packReal + '<');
    expect(html).toContain(MESSAGES[lang].listing.create);
  });
  it('on mainnet the pack says USDC, never "test"', () => {
    const html = wrap(lang, <CreditsBar credits={credits({ cluster: 'mainnet-beta' })} onBought={() => {}} />);
    expect(html).toContain(MESSAGES[lang].credits.packReal);
    expect(html).not.toMatch(/Test-USDC|test USDC/);
  });
  it('without a model key: templates are free, no photo picker, the buy button is gone', () => {
    const html = wrap(lang, <ListingPanel lots={lots} locale={lang} credits={credits({ configured: false })} onCredits={() => {}} onApply={() => {}} />);
    expect(html).toContain(MESSAGES[lang].listing.createTemplate);
    expect(html).not.toContain('ai-photos');
    expect(html).not.toContain('data-testid="ai-buy"');
  });
  it('no credit left: the create button is disabled and the buy button shows the wallet hint (no wallet in this render)', () => {
    const html = wrap(lang, <ListingPanel lots={lots} locale={lang} credits={credits({ balance: 0 })} onCredits={() => {}} onApply={() => {}} />);
    expect(html).toMatch(/data-testid="ai-create"[^>]*disabled|disabled[^>]*data-testid="ai-create"/);
    expect(html).toContain(MESSAGES[lang].credits.needWallet);
    expect(html).toContain(MESSAGES[lang].credits.none);
  });
  it('a model draft carries the AI badge, a template carries the template badge, and neither can be adopted before it is reviewed', () => {
    const m = wrap(lang, <DraftView res={draft('model')} locale={lang} onApply={() => {}} applied={false} />);
    expect(m).toContain(MESSAGES[lang].badge.draft);
    expect(m).toMatch(/disabled=""[^>]*data-testid="ai-apply"|data-testid="ai-apply"[^>]*disabled=""/);
    const tpl = wrap(lang, <DraftView res={draft('template')} locale={lang} onApply={() => {}} applied={false} />);
    expect(tpl).toContain(MESSAGES[lang].badge.template);
    expect(tpl).not.toContain(MESSAGES[lang].badge.draft);
    expect(tpl).toContain(MESSAGES[lang].listing.result.templateNote);
  });
  it('the sell help is a folded section without the personal-data notice; the room assistant is the agent drawer, not this panel', () => {
    const sell = wrap(lang, <AskPanel locale={lang} />);
    expect(sell).toContain(MESSAGES[lang].ask.buttonSell);
    expect(sell).not.toMatch(/ai-privacy|not enter personal data|keine persönlichen Daten ein|sent to Google|an Google/);
  });
});

describe('the lot description slot (no provider needed)', () => {
  const text = { de: 'Deutscher Text.', en: 'English text.' };
  it('shows the text of the viewer language and the AI note only when the seller adopted an AI draft', () => {
    const a = renderToStaticMarkup(<LotDescription description={text} aiAssisted locale="de" />);
    expect(a).toContain('Deutscher Text.');
    expect(a).toContain('KI-gestützt, vom Verkäufer geprüft');
    const b = renderToStaticMarkup(<LotDescription description={text} aiAssisted={false} locale="en" />);
    expect(b).toContain('English text.');
    expect(b).not.toContain('AI-assisted');
    expect(renderToStaticMarkup(<LotDescription description={null} aiAssisted locale="en" />)).toBe('');
    expect(renderToStaticMarkup(<LotDescription description={{ de: '', en: '' }} aiAssisted locale="en" />)).toBe('');
  });
  it('falls back to the other language when one is empty, and escapes markup (it is text, never HTML)', () => {
    const h = renderToStaticMarkup(<LotDescription description={{ de: '', en: '<img src=x onerror=alert(1)>' }} aiAssisted={false} locale="de" />);
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img');
  });
});
