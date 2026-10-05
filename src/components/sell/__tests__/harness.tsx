/**
 * Test harness: render a client component to static HTML with real messages and a stubbed i18n Link.
 * No DOM library is installed (package.json is frozen), so component tests render states and assert on markup
 * and data-testid attributes; behaviour lives in pure modules and fetch-stubbed wrappers with their own tests.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import React, { type ReactElement } from 'react';
import enSell from '@/locales/en/sell.json';
import enAccount from '@/locales/en/account.json';
import enRooms from '@/locales/en/rooms.json';
import enTimed from '@/locales/en/timed.json';
import deSell from '@/locales/de/sell.json';
import deAccount from '@/locales/de/account.json';
import deRooms from '@/locales/de/rooms.json';
import deTimed from '@/locales/de/timed.json';
import enTour from '@/locales/en/tour.json';
import deTour from '@/locales/de/tour.json';
import enGlossary from '@/locales/en/glossary.json';
import deGlossary from '@/locales/de/glossary.json';

// vitest.config.ts is PLATFORM's and compiles JSX with the classic runtime (React.createElement), while Next uses the
// automatic one. Publishing React as a global here keeps the components free of a `import React` only tests need.
(globalThis as { React?: unknown }).React = React;

const MESSAGES = {
  en: { sell: enSell, account: enAccount, rooms: enRooms, timed: enTimed, tour: enTour, glossary: enGlossary },
  de: { sell: deSell, account: deAccount, rooms: deRooms, timed: deTimed, tour: deTour, glossary: deGlossary },
};

export function html(ui: ReactElement, locale: 'en' | 'de' = 'en'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Europe/Berlin">
      {ui}
    </NextIntlClientProvider>,
  );
}

/** The opening tag of the first element carrying `data-testid="<id>"`, or null. */
export function tag(markup: string, testId: string): string | null {
  const m = new RegExp(`<[a-z0-9]+[^>]*data-testid="${testId}"[^>]*>`).exec(markup);
  return m ? m[0] : null;
}
export const count = (markup: string, testId: string) => (markup.match(new RegExp(`data-testid="${testId}"`, 'g')) ?? []).length;
export const isDisabled = (markup: string, testId: string) => /\sdisabled(=|\s|>)/.test(tag(markup, testId) ?? '');
