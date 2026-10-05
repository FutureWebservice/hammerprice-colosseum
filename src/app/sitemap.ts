/**
 * The sitemap: every built, indexable page in site-routes.ts, in each locale it exists in, with its
 * real last-modified date (components/landing/seo.ts LASTMOD) and hreflang alternates.
 * '/hp' (a redirect) and sections without a page of their own ('/room' has only '/room/[id]')
 * are left out by the route flags; listing individual rooms would need a DB read here.
 */
import type { MetadataRoute } from 'next';
import { locales } from '@/lib/i18n/config';
import { sitemapPaths } from '@/lib/site-routes';
import { lastModified } from '@/components/landing/seo';
import { SITE_URL } from '@/components/landing/site';

const PRIORITY: Record<string, number> = { '/': 1, '/rooms': 0.9, '/about': 0.7, '/ai': 0.6, '/packs': 0.6 };

const changeFrequency = (path: string): 'daily' | 'monthly' => (path === '/' || path === '/rooms' ? 'daily' : 'monthly');

export default function sitemap(): MetadataRoute.Sitemap {
  const url = (locale: string, path: string) => `${SITE_URL}/${locale}${path === '/' ? '' : path}`;
  const now = new Date();
  return locales.flatMap((locale) =>
    sitemapPaths(locale).map((path) => ({
      url: url(locale, path),
      lastModified: lastModified(path, now),
      changeFrequency: changeFrequency(path),
      priority: PRIORITY[path] ?? 0.5,
      // Only the locales that have this slug are alternates of each other.
      alternates: { languages: Object.fromEntries(locales.filter((l) => sitemapPaths(l).includes(path)).map((l) => [l, url(l, path)])) },
    })),
  );
}
