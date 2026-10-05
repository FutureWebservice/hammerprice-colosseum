/**
 * The About page says each thing once (owner feedback, claim 220). The test renders the whole page per language, collects every visible
 * string (text nodes: headings, lines, buttons, questions and answers, the glossary) and asserts
 *   1. no sentence of six or more words occurs twice (compared without case, punctuation and spacing), and
 *   2. no two strings of five or more content words share more than 70 percent of their content words (the shorter one is the base).
 * Short labels (button texts such as "Sell a card", chips, headings) are exempt on purpose: a button may repeat where a reader needs it.
 * When this fails, keep the fact in its one best place and shorten the other to a pointer with an anchor (#features, #verify, #faq ...).
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enTour from '@/locales/en/tour.json';
import deTour from '@/locales/de/tour.json';
import enGl from '@/locales/en/glossary.json';
import deGl from '@/locales/de/glossary.json';

vi.mock('@/lib/i18n', () => ({
  locales: ['en', 'de'],
  defaultLocale: 'en',
  Link: ({ href, locale, children, className }: { href: string; locale?: string; children: React.ReactNode; className?: string }) =>
    React.createElement('a', { href: `/${locale ?? 'en'}${href === '/' ? '' : href}`, className }, children),
}));
(globalThis as unknown as { React: typeof React }).React = React;
const { default: AboutPage } = await import('../AboutPage');

const MSG = { en: { tour: enTour, glossary: enGl }, de: { tour: deTour, glossary: deGl } };

const ENTITIES: Record<string, string> = { '&#x27;': "'", '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' };
const decode = (t: string) => t.replace(/&#x27;|&amp;|&quot;|&lt;|&gt;/g, (e) => ENTITIES[e]!);

/** Every visible text node of the page, in order. */
function visibleStrings(locale: 'en' | 'de'): string[] {
  const html = renderToStaticMarkup(
    React.createElement(
      NextIntlClientProvider as React.ComponentType<Record<string, unknown>>,
      { locale, messages: MSG[locale], timeZone: 'Europe/Berlin' },
      React.createElement(AboutPage, { locale, total: '151,000+', proofHref: '/verify/random/0b6f6a52-3f0e-4a54-9d7e-1c2d3e4f5a6b' }),
    ),
  );
  return decode(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '\n'))
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s/@-]/gu, ' ').replace(/\s+/g, ' ').trim();
const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).map(norm).filter((x) => x.split(' ').length >= 6);

const STOP: Record<'en' | 'de', string> = {
  en: 'the a an and or of to in on at for with by is are was be it its you your we our us this that these those as from not no do does can will one any each so than then if when what which who',
  de: 'der die das den dem des ein eine einen einem einer eines und oder von zu in im auf an für mit durch ist sind war wird werden es sie ihr ihre ihren ihrem ihrer wir unser unsere uns dies diese dieser dieses als aus nicht kein keine ja nein man nur auch so dann wenn was welche wer bei nach vor über unter zum zur am',
};

const contentWords = (s: string, l: 'en' | 'de') => {
  const stop = new Set(STOP[l].split(' '));
  return new Set(norm(s).split(' ').filter((w) => w.length > 2 && !stop.has(w)));
};

describe.each(['en', 'de'] as const)('the About page says each thing once (%s)', (l) => {
  const strings = visibleStrings(l);

  it('collects the whole page', () => {
    expect(strings.length).toBeGreaterThan(150);
    expect(strings.join(' ')).toContain(l === 'de' ? 'Hinter Hammerprice' : 'Behind Hammerprice');
  });

  it('no sentence of six or more words occurs twice', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const s of strings) for (const x of sentences(s)) {
      if (seen.has(x)) twice.push(x);
      seen.set(x, s);
    }
    expect(twice).toEqual([]);
  });

  it('no two strings share more than 70 percent of their content words', () => {
    const items = [...new Set(strings)].map((s) => ({ s, w: contentWords(s, l) })).filter((x) => x.w.size >= 5);
    const pairs: string[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const [a, b] = items[i]!.w.size <= items[j]!.w.size ? [items[i]!, items[j]!] : [items[j]!, items[i]!];
        let shared = 0;
        for (const w of a.w) if (b.w.has(w)) shared++;
        if (shared / a.w.size > 0.7) pairs.push(`${Math.round((100 * shared) / a.w.size)}%: "${a.s}" ~ "${b.s}"`);
      }
    }
    expect(pairs).toEqual([]);
  });
});
