/** Title, description, canonical URL and hreflang alternates for a legal page. Pure. */
import type { Metadata } from 'next';
import { defaultLocale, isLocale, locales, type Locale } from '@/lib/i18n/config';
import { CONTENT_DIR, splitFrontMatter } from './content';
import { DEFAULT_OG_ALT, DEFAULT_OG_IMAGE } from '@/components/landing/seo';
import { legalPath, type LegalKey } from './routes';
import fs from 'node:fs';
import path from 'node:path';

export const resolveLocale = (v: string): Locale => (isLocale(v) ? v : defaultLocale);

export function legalMetadata(locale: Locale, key: LegalKey): Metadata {
  const { meta } = splitFrontMatter(fs.readFileSync(path.join(CONTENT_DIR, locale, `${key}.md`), 'utf8'));
  const title = `${meta.title} | Hammerprice`;
  const languages = Object.fromEntries(locales.map((l) => [l, legalPath(l, key)]));
  return {
    title,
    description: meta.description,
    alternates: { canonical: legalPath(locale, key), languages: { ...languages, 'x-default': legalPath(defaultLocale, key) } },
    openGraph: {
      type: 'website',
      siteName: 'Hammerprice',
      title,
      description: meta.description,
      url: legalPath(locale, key),
      locale: locale === 'de' ? 'de_DE' : 'en_US',
      images: [{ ...DEFAULT_OG_IMAGE, alt: DEFAULT_OG_ALT }],
    },
    twitter: { card: 'summary_large_image', title, description: meta.description, images: [{ url: DEFAULT_OG_IMAGE.url, alt: DEFAULT_OG_ALT }] },
    robots: { index: true, follow: true },
  };
}
