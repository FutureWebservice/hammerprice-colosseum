/** The room says how long each lot runs (K14: a seller can choose it), in both languages, and says nothing for a timed auction. */
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
vi.mock('@/hooks/room/useUsd', () => ({ useUsd: () => (u: string | null | undefined) => `$${u ?? 'n/a'}` }));
(globalThis as { React?: unknown }).React = React; // vitest compiles JSX with the classic runtime

import CatalogueRail from '../CatalogueRail';

const wrap = (locale: 'en' | 'de', node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? { room: enRoom, glossary: enGlossary } : { room: deRoom, glossary: deGlossary }} timeZone="UTC">{node}</NextIntlClientProvider>,
  );

describe('CatalogueRail lot length', () => {
  it('says how long each lot runs, in words, for the lengths a seller can choose', () => {
    const cases: [number, string, string][] = [[45, '45 seconds', '45 Sekunden'], [90, '90 seconds', '90 Sekunden'], [180, '3 minutes', '3 Minuten'], [300, '5 minutes', '5 Minuten']];
    for (const [s, en, de] of cases) {
      const e = wrap('en', <CatalogueRail lots={[]} currentLotId={null} lotDurationS={s} locale="en" />);
      expect(e).toContain('data-testid="lot-duration-note"');
      expect(e).toContain(`Each lot runs ${en}, longer when a late bid adds time.`);
      const d = wrap('de', <CatalogueRail lots={[]} currentLotId={null} lotDurationS={s} locale="de" />);
      expect(d).toContain(`Jedes Los läuft ${de}, länger, wenn ein spätes Gebot Zeit anhängt.`);
      expect(d).not.toContain('Each lot runs');
    }
  });

  it('says nothing when no length is given (a timed auction, the practice room)', () => {
    expect(wrap('en', <CatalogueRail lots={[]} currentLotId={null} />)).not.toContain('lot-duration-note');
  });
});
