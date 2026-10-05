/**
 * Every public page the site has, in one list. sitemap.xml and robots.txt both read this file, so a page is added in one place.
 *
 * `exists` says whether the page is built (a test compares the flags with src/app).
 *
 * Pure and dependency-free (locales come from i18n/config, which imports nothing), so tests can use it.
 */
import { locales } from '@/lib/i18n/config';
import type { Locale } from '@/lib/i18n/config';

export interface SiteRoute {
  /** Locale-free path. */
  path: string;
  /** The page is built in this build. */
  exists: boolean;
  /** A page renders at exactly `path`. False for a section that only has children (`/room` has `/room/[id]`). */
  page: boolean;
  /** Dynamic children live under `path`. */
  children?: boolean;
  /** Goes into sitemap.xml (when `page`) and robots.txt Allow. */
  indexable: boolean;
  /** The page answers 404 unless FEATURE_<name>=true, so the sitemap lists it only then (a sitemap must not list a 404). */
  feature?: string;
  /** Only these locales have this slug (the terms page is `agb` in German and `terms` in English). */
  locales?: readonly Locale[];
}

export const SITE_ROUTES: readonly SiteRoute[] = [
  // Built
  { path: '/', exists: true, page: true, indexable: true },
  { path: '/hp', exists: true, page: true, indexable: false }, // locale-free alias of the landing page (a redirect)
  { path: '/rooms', exists: true, page: true, indexable: true }, // the schedule
  { path: '/room', exists: true, page: false, children: true, indexable: true }, // /room/[id]

  // Built: seller and account surfaces, the audit page. Planned: nothing else
  { path: '/sell', exists: true, page: true, children: true, indexable: false }, // /sell/new, /sell/[showId]
  { path: '/account', exists: true, page: true, indexable: false },
  { path: '/verify', exists: true, page: false, children: true, indexable: false }, // /verify/[lotId]
  { path: '/about', exists: true, page: true, indexable: true },
  { path: '/ai', exists: true, page: true, indexable: true }, // where the site uses AI, with the assistant to try

  // Built: the packs pages (FEATURE_PACKS; each answers 404 while the feature is off). /packs, /packs/[id], /packs/manage; the proof page is /verify/packs/[id].
  { path: '/packs', exists: true, page: true, children: true, indexable: true, feature: 'PACKS' }, // /packs/[id] and /packs/manage are noindex themselves

  // Built: the admin panel (ADMIN_WALLETS). Not indexable, not linked from anywhere public; every page answers 404 to anyone who is not an admin wallet.
  { path: '/admin', exists: true, page: true, children: true, indexable: false },

  // Legal pages. German and English share the slugs
  // except the terms; `/legal/terms` and `/legal/agb` are each canonical in one language.
  { path: '/legal', exists: true, page: true, indexable: true },
  { path: '/legal/impressum', exists: true, page: true, indexable: true },
  { path: '/legal/datenschutz', exists: true, page: true, indexable: true },
  { path: '/legal/agb', exists: true, page: true, indexable: true, locales: ['de'] },
  { path: '/legal/terms', exists: true, page: true, indexable: true, locales: ['en'] },
  { path: '/legal/cookies', exists: true, page: true, indexable: true },
  { path: '/legal/consumer', exists: true, page: true, indexable: true },
  { path: '/legal/dsa-contact', exists: true, page: true, indexable: true },
  { path: '/legal/fees', exists: true, page: true, indexable: true },
  { path: '/legal/risk', exists: true, page: true, indexable: true },
];

const LOCALE_PREFIX = new RegExp(`^/(${locales.join('|')})(/.*)?$`);

/** Strip a leading /de or /en so one rule covers every locale. */
export function withoutLocale(pathname: string): string {
  const m = LOCALE_PREFIX.exec(pathname);
  return m ? (m[2] ?? '/') : pathname;
}

/** The route that serves `pathname` (locale optional), or undefined. A children route also serves its sub-paths. */
export function findRoute(pathname: string, routes: readonly SiteRoute[] = SITE_ROUTES): SiteRoute | undefined {
  const p = withoutLocale(pathname).split('#')[0] || '/'; // a link may carry a fragment (/about#faq)
  return routes.find((r) => (r.page && p === r.path) || (r.children && p.startsWith(r.path + '/')));
}

/** Whether a built route serves this path. */
export function isBuiltPath(pathname: string): boolean {
  return findRoute(pathname, SITE_ROUTES.filter((r) => r.exists)) !== undefined;
}

/** Locale-free paths of the built routes, in list order . */
export const builtPaths = (): string[] => SITE_ROUTES.filter((r) => r.exists).map((r) => r.path);

/** Locale-free paths for sitemap.xml in one locale: built, indexable, a real page, and its feature switch (if it has one) is on. */
export function sitemapPaths(locale: Locale, env: Record<string, string | undefined> = process.env): string[] {
  return SITE_ROUTES.filter((r) => r.exists && r.page && r.indexable && (!r.feature || env[`FEATURE_${r.feature}`] === 'true') && (!r.locales || r.locales.includes(locale))).map((r) => r.path);
}

/**
 * robots.txt Allow lines (the file disallows everything else). Children routes end without `$` so the
 * prefix covers them; page routes end with `$` so the allow does not leak onto look-alike paths.
 */
export function robotsAllow(): string[] {
  const lines: string[] = [];
  for (const r of SITE_ROUTES.filter((x) => x.exists && x.indexable)) {
    const ls = r.locales ?? locales;
    const suffix = r.children ? '' : '$';
    for (const prefix of ['', ...ls.map((l) => `/${l}`)]) {
      if (prefix === '' && r.locales) continue; // a locale-restricted slug has no locale-free URL
      const base = r.path === '/' ? prefix : `${prefix}${r.path}`;
      lines.push(base === '' ? '/$' : base + suffix);
    }
  }
  return [...new Set(lines)];
}
