import type { ReactNode } from 'react';
import PageMessages from '@/lib/i18n/PageMessages';

/** Sends this route group only the message namespaces its client components read (src/lib/i18n/route-namespaces.ts). */
export default async function RoomsLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return <PageMessages locale={locale} group="rooms">{children}</PageMessages>;
}
