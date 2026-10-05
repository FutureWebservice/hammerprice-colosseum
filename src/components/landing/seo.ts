/**
 * Metadata helpers for every public page, so a page is correct by calling one function instead of
 * remembering five rules.
 *
 * Why this exists: a page's `openGraph` and `twitter` objects REPLACE the layout's, they do not merge
 * into it, so a page that wrote `{ title, description }` silently lost the share image and downgraded
 * the Twitter card. `pageMetadata` always spells out the whole card. It also emits the canonical URL
 * and the hreflang alternates (HTML `<link rel="alternate">`, not just the sitemap), which the audit
 * found missing on every page.
 *
 * Pure: no React, no Next runtime. Room pages (owned by another agent) can call it too:
 * `pageMetadata({ locale, path: '/room/<id>', title, description, image })`.
 */
import type { Metadata } from 'next';
import { defaultLocale, locales, type Locale } from '@/lib/i18n/config';
import { CONTACT_EMAIL, FOUNDER, GITHUB_ORG_URL, SITE_NAME, SITE_URL } from './site';

/** The site-wide share card (src/app/opengraph-image.tsx). */
export const DEFAULT_OG_IMAGE = { url: `${SITE_URL}/opengraph-image`, width: 1200, height: 630 } as const;
export const DEFAULT_OG_ALT = 'Hammerprice. The hammer is the payment. Der Hammer ist die Zahlung.';

const OG_LOCALE: Record<Locale, string> = { en: 'en_US', de: 'de_DE' };

/** `/en`, `/en/rooms`, `/de/room/abc`. The home page has no trailing slash. */
export function localePath(locale: Locale, path: string): string {
  return path === '/' || path === '' ? `/${locale}` : `/${locale}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Absolute URL of a locale-free path in one locale. */
export function absoluteUrl(locale: Locale, path: string): string {
  return `${SITE_URL}${localePath(locale, path)}`;
}

/**
 * The canonical URL and the hreflang set for one page. `only` limits the alternates to the locales
 * that really have this slug (a page that exists in German only must not advertise an English twin).
 * `x-default` points at the default-locale version when there is one.
 */
export function alternatesFor(locale: Locale, path: string, only: readonly Locale[] = locales): NonNullable<Metadata['alternates']> {
  const have = only.includes(locale) ? only : [...only, locale];
  const languages: Record<string, string> = Object.fromEntries(have.map((l) => [l, absoluteUrl(l, path)]));
  languages['x-default'] = absoluteUrl(have.includes(defaultLocale) ? defaultLocale : have[0], path);
  return { canonical: absoluteUrl(locale, path), languages };
}

export interface PageMetaInput {
  locale: Locale;
  /** Locale-free path: '/', '/rooms', '/room/<uuid>'. */
  path: string;
  /** Already complete: this site has no title template. */
  title: string;
  description: string;
  /** Only these locales have this slug. Default: all of them. */
  locales?: readonly Locale[];
  /** A page-specific share image (absolute or root-relative URL). Default: the site card. */
  image?: { url: string; alt?: string; width?: number; height?: number };
  /** Keep the page out of the index (previews, private surfaces). */
  noindex?: boolean;
}

/** Everything a page needs in `generateMetadata`: title, description, canonical, hreflang, Open Graph, Twitter card. */
export function pageMetadata(i: PageMetaInput): Metadata {
  const url = absoluteUrl(i.locale, i.path);
  const img = i.image ?? { url: DEFAULT_OG_IMAGE.url, width: DEFAULT_OG_IMAGE.width, height: DEFAULT_OG_IMAGE.height, alt: DEFAULT_OG_ALT };
  const imageUrl = img.url.startsWith('http') ? img.url : `${SITE_URL}${img.url}`;
  const alt = img.alt ?? DEFAULT_OG_ALT;
  return {
    title: i.title,
    description: i.description,
    alternates: alternatesFor(i.locale, i.path, i.locales),
    manifest: '/manifest.webmanifest',
    ...(i.noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      type: 'website',
      siteName: SITE_NAME,
      title: i.title,
      description: i.description,
      url,
      locale: OG_LOCALE[i.locale],
      alternateLocale: locales.filter((l) => l !== i.locale).map((l) => OG_LOCALE[l]),
      images: [{ url: imageUrl, width: img.width ?? 1200, height: img.height ?? 630, alt }],
    },
    twitter: {
      card: 'summary_large_image',
      title: i.title,
      description: i.description,
      images: [{ url: imageUrl, alt }],
    },
  };
}

/**
 * Real last-modified dates for the sitemap. A static page's date is the day its content last
 * changed (edit it in the same commit as the page); the landing page and the schedule render live
 * data, so their date is the build. Anything unlisted also falls back to the build, which is
 * honest for a page that was built just now, and never a date in the future.
 */
export const LASTMOD: Readonly<Record<string, string>> = {
  '/about': '2026-10-04',
  '/ai': '2026-10-03',
};

export function lastModified(path: string, now: Date = new Date()): Date {
  const d = LASTMOD[path];
  return d ? new Date(`${d}T00:00:00Z`) : now;
}

// --- JSON-LD ---------------------------------------------------------------------------------------

const ORG_ID = `${SITE_URL}/#organization`;

/** schema.org Organization: the brand, its founder and the organisation's public profile. */
export function organizationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': ORG_ID,
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/icons/icon-512.png`,
    email: CONTACT_EMAIL,
    founder: { '@type': 'Person', name: FOUNDER.name, jobTitle: FOUNDER.role },
    sameAs: [GITHUB_ORG_URL],
  };
}

/** schema.org WebSite, in both languages. No SearchAction: the site has no search. */
export function websiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    name: SITE_NAME,
    url: SITE_URL,
    inLanguage: [...locales],
    publisher: { '@id': ORG_ID },
  };
}

/** JSON for a `<script type="application/ld+json">` body. `<` is escaped so a value can never close the tag. */
export function jsonLdString(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
