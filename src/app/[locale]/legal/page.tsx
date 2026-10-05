import { setRequestLocale } from 'next-intl/server';
import LegalPage from '@/components/legal/LegalPage';
import { legalMetadata, resolveLocale } from '@/legal/metadata';
import { locales } from '@/lib/i18n/config';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return legalMetadata(resolveLocale(locale), 'index');
}

/** The hub: every legal text on one page. */
export default async function LegalHubPage({ params }: { params: Promise<{ locale: string }> }) {
  const locale = resolveLocale((await params).locale);
  setRequestLocale(locale);
  return <LegalPage locale={locale} docKey="index" />;
}
