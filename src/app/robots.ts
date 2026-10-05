/**
 * Disallow everything, then Allow exactly the built, indexable routes of site-routes.ts (search
 * engines apply the longest matching rule, so a specific Allow beats the blanket Disallow). The home
 * pages (/en, /de) are in that list; the old file left them out and the landing page was blocked from
 * indexing. The production gate reads the same list to 404 anything else at the app level; a crawler
 * that never sees an unlisted route does not burn budget on its 404.
 */
import type { MetadataRoute } from 'next';
import { robotsAllow } from '@/lib/site-routes';
import { SITE_URL } from '@/components/landing/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: robotsAllow(), disallow: '/' },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
