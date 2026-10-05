/**
 * A lot without a minimum price (the seller set none) says so in words, in every state and both languages: the catalogue row, the
 * lower third and the announcer never print "n/a", "null", "undefined" or "NaN".
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import enRoom from '@/locales/en/room.json';
import deRoom from '@/locales/de/room.json';
import enGlossary from '@/locales/en/glossary.json';
import deGlossary from '@/locales/de/glossary.json';

vi.mock('@/lib/i18n', () => ({ Link: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('@/components/room/slots/FairnessChip', () => ({ default: () => null }));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import CatalogueRail from '../CatalogueRail';
import LowerThird from '../LowerThird';
import { formatUsdc } from '../types';
import { lotLimit } from '../limit';
import type { RoomLot, LotState } from '../types';

const wrap = (locale: 'en' | 'de', node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? { room: enRoom, glossary: enGlossary } : { room: deRoom, glossary: deGlossary }} timeZone="UTC">{node}</NextIntlClientProvider>,
  );

const lot = (state: LotState, over: Partial<RoomLot> = {}): RoomLot => ({
  id: `lot-${state}`, lotNumber: 1, name: 'Charizard', increment: '5000000', openingPrice: '20000000', state, ...over,
});
const LEAKS = ['n/a', 'null', 'undefined', 'NaN', '[object'];

describe('lotLimit', () => {
  it('is the reserve, else the insured value, else none; a reserve of 0 is no reserve', () => {
    expect(lotLimit({ reserve: '150000000', insuredValue: '90000000' })).toEqual({ kind: 'reserve', value: '150000000' });
    expect(lotLimit({ reserve: null, insuredValue: '90000000' })).toEqual({ kind: 'insured', value: '90000000' });
    expect(lotLimit({ reserve: '0', insuredValue: null })).toEqual({ kind: 'none', value: null });
    expect(lotLimit({ reserve: undefined, insuredValue: undefined })).toEqual({ kind: 'none', value: null });
    expect(lotLimit({ reserve: 'abc', insuredValue: '' })).toEqual({ kind: 'none', value: null });
  });
  it('the money formatter never falls back to "n/a"', () => {
    expect(formatUsdc(null)).not.toContain('n/a');
    expect(formatUsdc('x')).not.toContain('n/a');
  });
});

describe.each([['en', 'No minimum'], ['de', 'Kein Mindestpreis']] as const)('a lot with no minimum price (%s)', (locale, words) => {
  const states: LotState[] = ['catalogued', 'open', 'sold', 'passed', 'withdrawn'];

  it.each(states)('the catalogue row (%s) says it in words', (state) => {
    const html = wrap(locale, <CatalogueRail lots={[lot(state, { highBid: state === 'sold' ? '40000000' : null, reserve: null })]} currentLotId={null} locale={locale} />);
    for (const w of LEAKS) expect(html).not.toContain(w);
    if (state !== 'sold') expect(html).toContain(words);
  });

  it.each(states)('the lower third (%s) shows no leak', (state) => {
    const html = wrap(locale, <LowerThird lot={lot(state, { reserve: null, highBid: state === 'sold' ? '40000000' : null })} phase={state === 'sold' || state === 'passed' ? 'hammered' : 'open'} msToNext={5000} jitterToken={0} />);
    for (const w of LEAKS) expect(html).not.toContain(w);
  });

  it('the lower third of a catalogued lot without a minimum shows the starting price, not a missing number', () => {
    const html = wrap(locale, <LowerThird lot={lot('catalogued', { reserve: null })} phase="open" msToNext={null} jitterToken={0} />);
    expect(html).toContain(locale === 'en' ? '$20.00' : '20,00');
    expect(html).toContain(locale === 'en' ? 'starting price' : 'Startpreis');
  });
});
