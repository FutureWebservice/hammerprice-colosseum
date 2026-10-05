import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OG_IMAGE, LASTMOD, absoluteUrl, alternatesFor, jsonLdString, lastModified, localePath,
  organizationJsonLd, pageMetadata, websiteJsonLd,
} from '../seo';
import { SITE_URL, IDEATHON_LINE, formatCount, formatUsd, formatUsdcUnits, vaultFloorLabel } from '../site';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import { sitemapPaths, robotsAllow } from '@/lib/site-routes';

describe('locale paths and alternates', () => {
  it('builds locale-prefixed paths with no trailing slash on the home page', () => {
    expect(localePath('en', '/')).toBe('/en');
    expect(localePath('de', '/rooms')).toBe('/de/rooms');
    expect(localePath('de', 'faq')).toBe('/de/faq');
    expect(absoluteUrl('en', '/')).toBe(`${SITE_URL}/en`);
  });

  it('gives a canonical for the page itself and hreflang for both languages plus x-default', () => {
    const a = alternatesFor('de', '/rooms');
    expect(a.canonical).toBe(`${SITE_URL}/de/rooms`);
    expect(a.languages).toEqual({ en: `${SITE_URL}/en/rooms`, de: `${SITE_URL}/de/rooms`, 'x-default': `${SITE_URL}/en/rooms` });
  });

  it('advertises only the locales that have the slug', () => {
    const a = alternatesFor('de', '/legal/agb', ['de']);
    expect(a.languages).toEqual({ de: `${SITE_URL}/de/legal/agb`, 'x-default': `${SITE_URL}/de/legal/agb` });
  });
});

describe('pageMetadata', () => {
  const m = pageMetadata({ locale: 'en', path: '/faq', title: 'T', description: 'D' });

  it('spells out the whole Open Graph card, because a page object replaces the layout one', () => {
    expect(m.openGraph).toMatchObject({ type: 'website', siteName: 'Hammerprice', title: 'T', description: 'D', url: `${SITE_URL}/en/faq`, locale: 'en_US', alternateLocale: ['de_DE'] });
    const og = m.openGraph as { images: Array<{ url: string; width: number; height: number; alt: string }> };
    expect(og.images[0]).toMatchObject({ url: DEFAULT_OG_IMAGE.url, width: 1200, height: 630 });
    expect(og.images[0].alt.length).toBeGreaterThan(10);
  });

  it('uses the large Twitter card with an image', () => {
    const tw = m.twitter as { card: string; images: Array<{ url: string }> };
    expect(tw.card).toBe('summary_large_image');
    expect(tw.images[0].url).toBe(DEFAULT_OG_IMAGE.url);
  });

  it('carries canonical, hreflang and the manifest, and is indexable by default', () => {
    expect(m.alternates?.canonical).toBe(`${SITE_URL}/en/faq`);
    expect(m.alternates?.languages).toHaveProperty('de');
    expect(m.manifest).toBe('/manifest.webmanifest');
    expect(m.robots).toBeUndefined();
  });

  it('takes a room-specific image and resolves a root-relative URL against the site', () => {
    const r = pageMetadata({ locale: 'de', path: '/room/abc', title: 'R', description: 'D', image: { url: '/de/room/abc/opengraph-image', alt: 'Raum' } });
    const og = r.openGraph as { images: Array<{ url: string; alt: string }>; locale: string };
    expect(og.images[0]).toMatchObject({ url: `${SITE_URL}/de/room/abc/opengraph-image`, alt: 'Raum' });
    expect(og.locale).toBe('de_DE');
  });

  it('can keep a page out of the index', () => {
    expect(pageMetadata({ locale: 'en', path: '/x', title: 'T', description: 'D', noindex: true }).robots).toEqual({ index: false, follow: false });
  });
});

describe('sitemap', () => {
  const entries = sitemap();

  it('lists the home page in both languages, with hreflang alternates for each', () => {
    for (const l of ['en', 'de']) {
      const home = entries.find((e) => e.url === `${SITE_URL}/${l}`);
      expect(home, l).toBeDefined();
      expect(home?.alternates?.languages).toMatchObject({ en: `${SITE_URL}/en`, de: `${SITE_URL}/de` });
    }
  });

  it('has one entry per built indexable page and locale, and nothing else', () => {
    const expected = (['en', 'de'] as const).flatMap((l) => sitemapPaths(l).map((p) => `${SITE_URL}/${l}${p === '/' ? '' : p}`));
    expect(entries.map((e) => e.url).sort()).toEqual(expected.sort());
  });

  it('gives every page a real last-modified date that is not in the future', () => {
    const now = Date.now() + 1000;
    for (const e of entries) {
      const t = new Date(e.lastModified as Date).getTime();
      expect(Number.isNaN(t), e.url).toBe(false);
      expect(t, e.url).toBeLessThanOrEqual(now);
    }
  });

  it('uses the recorded content date for a static page, not the build time', () => {
    for (const [p, d] of Object.entries(LASTMOD)) expect(lastModified(p).toISOString().slice(0, 10)).toBe(d);
    const now = new Date('2030-01-01T00:00:00Z');
    expect(lastModified('/rooms', now)).toBe(now); // live content: the build
    const how = entries.find((e) => e.url.endsWith('/en/about'));
    expect(new Date(how!.lastModified as Date).toISOString().slice(0, 10)).toBe(LASTMOD['/about']);
  });
});

describe('robots', () => {
  it('allows the home pages the old file blocked, names the sitemap and keeps the blanket disallow', () => {
    const r = robots();
    const rules = r.rules as { userAgent: string; allow: string[]; disallow: string };
    for (const a of ['/$', '/en$', '/de$']) expect(rules.allow, a).toContain(a);
    expect(rules.allow).toEqual(robotsAllow());
    expect(rules.disallow).toBe('/');
    expect(r.sitemap).toBe(`${SITE_URL}/sitemap.xml`);
  });
});

describe('structured data', () => {
  it('describes the organisation with its founder and only verifiable links', () => {
    const o = organizationJsonLd();
    expect(o['@type']).toBe('Organization');
    expect(o.founder).toEqual({ '@type': 'Person', name: 'Farshad Shadjari', jobTitle: 'Founder' });
    expect(o.url).toBe(SITE_URL);
    expect(o.sameAs).toEqual(['https://github.com/FutureWebservice']);
  });

  it('describes the website in both languages and points at the organisation', () => {
    const w = websiteJsonLd();
    expect(w['@type']).toBe('WebSite');
    expect(w.inLanguage).toEqual(['en', 'de']);
    expect(w.publisher['@id']).toBe(organizationJsonLd()['@id']);
  });

  it('can never close the script tag it is embedded in', () => {
    const s = jsonLdString({ a: '</script><script>alert(1)</script>' });
    expect(s).not.toContain('<');
    expect(JSON.parse(s).a).toBe('</script><script>alert(1)</script>');
  });
});

describe('locale-correct numbers and money', () => {
  const nbsp = / /g;
  it('formats counts with the locale separator', () => {
    expect(formatCount(159184, 'en')).toBe('159,184');
    expect(formatCount(159184, 'de')).toBe('159.184');
    expect(vaultFloorLabel('en')).toBe('150,000');
    expect(vaultFloorLabel('de')).toBe('150.000');
  });

  it('always shows two decimals and the locale decimal mark', () => {
    expect(formatUsd(1091, 'en')).toBe('$1,091.00');
    expect(formatUsd(137.5, 'en')).toBe('$137.50');
    expect(formatUsd(1091, 'de').replace(nbsp, ' ')).toBe('1.091,00 $');
    expect(formatUsd(10.449, 'en')).toBe('$10.45');
  });

  it('converts USDC base units by integer math', () => {
    expect(formatUsdcUnits('27000000', 'en')).toBe('$27.00');
    expect(formatUsdcUnits('26319999', 'en')).toBe('$26.31'); // truncated to cents, never rounded up
    expect(formatUsdcUnits('1234567890', 'de').replace(nbsp, ' ')).toBe('1.234,56 $');
    expect(formatUsdcUnits(null, 'en')).toBe('');
    expect(formatUsdcUnits('not a number', 'en')).toBe('');
  });

  it('keeps the ideathon wording exact and rank-free in both languages', () => {
    expect(IDEATHON_LINE.en).toBe("One of ten prize winners at Superteam Germany's Road to Colosseum Ideathon");
    expect(IDEATHON_LINE.de).toBe('Einer von zehn Preisträgern beim Road-to-Colosseum-Ideathon von Superteam Germany');
  });
});
