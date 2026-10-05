import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SITE_ROUTES, builtPaths, findRoute, isBuiltPath, robotsAllow, sitemapPaths, withoutLocale } from '../site-routes';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';

const APP = path.join(__dirname, '..', '..', 'app');

/** Does a page for this locale-free route exist on disk (an exact folder, or a single dynamic sibling such as legal/[slug])? */
function pageOnDisk(route: string): boolean {
  const dir = route === '/' ? '' : route;
  const exact = [path.join(APP, '[locale]', dir, 'page.tsx'), path.join(APP, dir, 'page.tsx')];
  if (exact.some((f) => fs.existsSync(f))) return true;
  const parent = path.join(APP, '[locale]', path.dirname(dir));
  return fs.existsSync(parent) && fs.readdirSync(parent).some((d) => /^\[[^\]]+\]$/.test(d) && fs.existsSync(path.join(parent, d, 'page.tsx')));
}
const dirOnDisk = (route: string) => fs.existsSync(path.join(APP, '[locale]', route));

describe('site routes', () => {
  it('lists each path once, locale-free', () => {
    const paths = SITE_ROUTES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^\/([a-z0-9-]+(\/[a-z0-9-]+)*)?$/);
  });

  // This list changing is a decision, not an accident: flip a flag in site-routes.ts and here together.
  it('has built exactly the landing page, the schedule, the room, the About page (how it works, status, pitch, FAQ and team in one), the seller and account pages, the admin page (404 for everyone but ADMIN_WALLETS), the packs pages (404 while FEATURE_PACKS is off) and the legal pages', () => {
    expect(builtPaths()).toEqual(['/', '/hp', '/rooms', '/room', '/sell', '/account', '/verify', '/about', '/ai', '/packs', '/admin', '/legal', '/legal/impressum', '/legal/datenschutz', '/legal/agb', '/legal/terms', '/legal/cookies', '/legal/consumer', '/legal/dsa-contact', '/legal/fees', '/legal/risk']);
  });

  it('has built about, ai and every legal page, and none of the three pages that became sections of /about (they redirect, src/lib/__tests__/old-routes.test.ts)', () => {
    const built = builtPaths();
    for (const p of ['/about', '/ai']) expect(built).toContain(p);
    for (const p of ['/how-it-works', '/pitch', '/faq']) expect(built).not.toContain(p);
    for (const slug of ['impressum', 'datenschutz', 'agb', 'terms', 'cookies', 'consumer', 'dsa-contact', 'fees', 'risk']) {
      expect(built).toContain(`/legal/${slug}`);
    }
  });

  it('matches the flags against src/app, so a page cannot ship without flipping its flag', () => {
    for (const r of SITE_ROUTES) {
      if (r.path === '/hp') continue; // src/app/hp, outside [locale]
      if (r.page) expect(pageOnDisk(r.path), `${r.path} exists=${r.exists}`).toBe(r.exists);
      else expect(dirOnDisk(r.path), `${r.path} exists=${r.exists}`).toBe(r.exists);
    }
    expect(fs.existsSync(path.join(APP, 'hp', 'page.tsx'))).toBe(true);
  });

  it('serves only built routes, in any locale, and only the children that are declared', () => {
    for (const p of ['/', '/en', '/de', '/rooms', '/de/rooms', '/room/abc', '/en/room/abc', '/hp', '/sell', '/en/sell/new', '/account', '/verify/x', '/about', '/de/about', '/legal', '/de/legal/impressum', '/en/legal/terms']) expect(isBuiltPath(p), p).toBe(true);
    for (const p of ['/de/legalese', '/how-it-works/x', '/how-it-works', '/pitch', '/faq', '/rooms/x', '/room']) {
      expect(isBuiltPath(p), p).toBe(false);
    }
  });

  it('strips only real locale prefixes', () => {
    expect(withoutLocale('/de/legal')).toBe('/legal');
    expect(withoutLocale('/en')).toBe('/');
    expect(withoutLocale('/deutsch/legal')).toBe('/deutsch/legal');
    expect(findRoute('/de/room/5')?.path).toBe('/room');
  });

  it('puts German and English slugs in the right locale only', () => {
    const agb = SITE_ROUTES.find((r) => r.path === '/legal/agb')!;
    const terms = SITE_ROUTES.find((r) => r.path === '/legal/terms')!;
    expect(agb.locales).toEqual(['de']);
    expect(terms.locales).toEqual(['en']);
  });
});

describe('sitemap and robots read the same list', () => {
  it('sitemap lists built indexable pages in both locales with alternates', () => {
    const urls = sitemap().map((e) => e.url);
    expect(sitemapPaths('en')).toEqual(['/', '/rooms', '/about', '/ai', '/legal', '/legal/impressum', '/legal/datenschutz', '/legal/terms', '/legal/cookies', '/legal/consumer', '/legal/dsa-contact', '/legal/fees', '/legal/risk']);
    expect(sitemapPaths('de')).toContain('/legal/agb');
    expect(sitemapPaths('de')).not.toContain('/legal/terms');
    for (const l of ['en', 'de']) for (const p of ['', '/rooms', '/about']) expect(urls).toContain(`https://hammerprice-earn.vercel.app/${l}${p}`);
    for (const l of ['en', 'de']) for (const p of ['/how-it-works', '/pitch', '/faq']) expect(urls).not.toContain(`https://hammerprice-earn.vercel.app/${l}${p}`);
    expect(urls.some((u) => u.includes('/hp') || u.endsWith('/room'))).toBe(false);
    expect(sitemap()[0].alternates?.languages).toHaveProperty('de');
  });

  it('robots allows the home pages (they were blocked by the blanket disallow) and the room prefix', () => {
    const allow = robotsAllow();
    for (const a of ['/$', '/en$', '/de$', '/en/rooms$', '/de/about$', '/room', '/en/room', '/de/room']) expect(allow, a).toContain(a);
    expect(allow.some((a) => a.includes('hp'))).toBe(false);
    expect(allow).toContain('/en/legal/terms$');
    expect(allow).toContain('/de/legal/agb$');
    expect(allow.some((a) => a.includes('sell') || a.includes('account'))).toBe(false);
    const rules = robots().rules as { allow: string[]; disallow: string };
    expect(rules.disallow).toBe('/');
    expect(rules.allow).toEqual(allow);
  });
});
