/**
 * The nine legal pages and their URLs (SPEC 2.2), in one table. Pure: the pages, the footer, the
 * sitemap flags, the link rewriter and next.config.js (through redirects.json) all read this.
 */
import { locales } from '@/lib/i18n/config';
import type { Locale } from '@/lib/i18n/config';

export const LEGAL_KEYS = ['index', 'impressum', 'datenschutz', 'terms', 'cookies', 'consumer', 'dsa-contact', 'fees', 'risk'] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];

/** Canonical slug per locale ('' = the hub). The terms page is `agb` in German and `terms` in English. */
export const SLUGS: Record<LegalKey, Record<Locale, string>> = {
  index: { de: '', en: '' },
  impressum: { de: 'impressum', en: 'impressum' },
  datenschutz: { de: 'datenschutz', en: 'datenschutz' },
  terms: { de: 'agb', en: 'terms' },
  cookies: { de: 'cookies', en: 'cookies' },
  consumer: { de: 'consumer', en: 'consumer' },
  'dsa-contact': { de: 'dsa-contact', en: 'dsa-contact' },
  fees: { de: 'fees', en: 'fees' },
  risk: { de: 'risk', en: 'risk' },
};

/** Other slugs that mean a page (alias to key). They redirect to the canonical URL. */
export const ALIASES: Record<string, LegalKey> = {
  imprint: 'impressum',
  privacy: 'datenschutz',
  agb: 'terms',
  terms: 'terms',
  widerruf: 'consumer',
  withdrawal: 'consumer',
  notice: 'dsa-contact',
};

/** Locale-free alias URLs get the language the word is in; everything else the default locale. */
const ALIAS_LOCALE: Record<string, Locale> = { agb: 'de', widerruf: 'de' };

/** Locale-free path of a page, for the i18n-aware `Link` (which adds the locale itself). */
export const legalHref = (locale: Locale, key: LegalKey): string => (key === 'index' ? '/legal' : `/legal/${SLUGS[key][locale]}`);

/** Full canonical path including the locale prefix. */
export const legalPath = (locale: Locale, key: LegalKey): string => `/${locale}${legalHref(locale, key)}`;

/** Which page does this slug (canonical in either language, or an alias) mean? */
export function keyForSlug(slug: string): LegalKey | null {
  const hit = LEGAL_KEYS.find((k) => k !== 'index' && locales.some((l) => SLUGS[k][l] === slug));
  return hit ?? ALIASES[slug] ?? null;
}

/** The key whose canonical slug in `locale` is exactly `slug` (what the page route serves). */
export const keyForCanonicalSlug = (locale: Locale, slug: string): LegalKey | null =>
  LEGAL_KEYS.find((k) => k !== 'index' && SLUGS[k][locale] === slug) ?? null;

/**
 * A link written in the content (`/legal/agb`, `/legal/terms`, `/legal/impressum`) to the canonical
 * path for this locale. Returns null for anything that is not a legal link.
 */
export function rewriteLegalLink(locale: Locale, href: string): string | null {
  if (href === '/legal') return legalPath(locale, 'index');
  const m = /^\/legal\/([a-z-]+)$/.exec(href);
  const key = m ? keyForSlug(m[1]) : null;
  return key ? legalPath(locale, key) : null;
}

export interface Redirect {
  source: string;
  destination: string;
  permanent: true;
}

/**
 * The redirects next.config.js must serve (it reads the JSON copy: src/legal/redirects.json, kept in
 * sync by a test). Old inherited URLs, the other language's terms slug, and the SPEC aliases.
 */
export function buildRedirects(): Redirect[] {
  const out: Redirect[] = [];
  const add = (source: string, destination: string) => out.push({ source, destination, permanent: true });
  // The old top-level German URLs.
  for (const key of ['impressum', 'datenschutz', 'terms'] as const) add(`/de/${ALIAS_OLD_DE[key]}`, legalPath('de', key));
  // In-locale aliases, including the terms slug of the other language.
  for (const locale of locales) {
    for (const [alias, key] of Object.entries(ALIASES)) {
      if (alias !== SLUGS[key][locale]) add(`/${locale}/legal/${alias}`, legalPath(locale, key));
    }
  }
  // Locale-free aliases.
  for (const [alias, key] of Object.entries(ALIASES)) {
    const locale = ALIAS_LOCALE[alias] ?? 'en';
    add(`/legal/${alias}`, legalPath(locale, key));
  }
  return out;
}
const ALIAS_OLD_DE = { impressum: 'impressum', datenschutz: 'datenschutz', terms: 'agb' } as const;

/** Every canonical page as [locale, slug] for generateStaticParams of the [slug] route. */
export const staticSlugs = (): { locale: Locale; slug: string }[] =>
  locales.flatMap((locale) => LEGAL_KEYS.filter((k) => k !== 'index').map((k) => ({ locale, slug: SLUGS[k][locale] })));
