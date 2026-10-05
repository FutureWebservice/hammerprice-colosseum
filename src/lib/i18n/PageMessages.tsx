import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { pickMessages, ROUTE_NAMESPACES, type RouteGroup } from './route-namespaces';

/** One timezone for server and browser, so a formatted time is the same text on both sides (the root layout says the same). */
export const TIME_ZONE = 'Europe/Berlin';

/**
 * The client provider for one route group: only the namespaces that group's client components read (route-namespaces.ts). It sits inside the locale
 * layout's provider (which holds the page chrome's texts) and replaces it for everything below it. Used by the layout.tsx of each route group.
 */
export default async function PageMessages({ locale, group, children }: { locale: string; group: RouteGroup; children: ReactNode }) {
  setRequestLocale(locale);
  const all = await getMessages({ locale });
  return (
    <NextIntlClientProvider locale={locale} messages={pickMessages(all, ROUTE_NAMESPACES[group])} timeZone={TIME_ZONE}>
      {children}
    </NextIntlClientProvider>
  );
}
