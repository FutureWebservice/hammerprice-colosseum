import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import LegalPage from '@/components/legal/LegalPage';
import { legalMetadata, resolveLocale } from '@/legal/metadata';
import { keyForCanonicalSlug, staticSlugs } from '@/legal/routes';

// Only the canonical slugs exist. Aliases (/de/legal/terms, /legal/imprint, ...) are redirects in
// next.config.js (src/legal/redirects.json), so anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams() {
  return staticSlugs();
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const l = resolveLocale(locale);
  const key = keyForCanonicalSlug(l, slug);
  return key ? legalMetadata(l, key) : {};
}

export default async function LegalSlugPage({ params }: { params: Promise<{ locale: string; slug: string }> }) {
  const { locale, slug } = await params;
  const l = resolveLocale(locale);
  const key = keyForCanonicalSlug(l, slug);
  if (!key) notFound();
  setRequestLocale(l);
  return <LegalPage locale={l} docKey={key} />;
}
