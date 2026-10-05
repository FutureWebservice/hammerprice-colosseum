/**
 * /how-it-works, /pitch and /faq became sections of /about (#how, #pitch, #faq). The old URLs live on in links, bookmarks and
 * search results, so each answers a permanent redirect (308) to its section, in both locales and without a locale. This
 * test reads the redirect list the way next.config.js serves it, and checks that no page of ours still links the old routes.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require_ = createRequire(import.meta.url);

type Redirect = { source: string; destination: string; permanent?: boolean };
const redirects: Redirect[] = require_('../old-routes.json');

/** What Next does with a source and destination here: a `:locale(de|en)` segment is captured and put back into the destination. */
function resolve(url: string): { to: string; permanent: boolean } | null {
  for (const r of redirects) {
    const re = new RegExp(`^${r.source.replace(':locale(de|en)', '(?<locale>de|en)')}$`);
    const m = re.exec(url);
    if (m) return { to: r.destination.replace(':locale', m.groups?.locale ?? ''), permanent: r.permanent === true };
  }
  return null;
}

describe('old routes redirect to the About page', () => {
  const SECTIONS: Array<[string, string]> = [['how-it-works', 'how'], ['pitch', 'pitch'], ['faq', 'faq']];

  it.each(SECTIONS)('/%s goes to /about#%s, permanently (308), in every locale and without one', (old, section) => {
    for (const l of ['en', 'de']) expect(resolve(`/${l}/${old}`), `/${l}/${old}`).toEqual({ to: `/${l}/about#${section}`, permanent: true });
    expect(resolve(`/${old}`)).toEqual({ to: `/about#${section}`, permanent: true });
  });

  it('touches nothing else: the pitch screenshots (/pitch/en/*.jpg), the About page itself and a look-alike path are not redirected', () => {
    for (const u of ['/pitch/en/landing.jpg', '/pitch/de/status.jpg', '/en/about', '/de/pitchfork', '/en/faq/x', '/fr/faq']) expect(resolve(u), u).toBeNull();
  });

  it('is served by next.config.js, after the legal redirects, and every entry is permanent', async () => {
    const config = require_(path.join(ROOT, 'next.config.js'));
    const served = (await config.redirects()) as Redirect[];
    for (const r of redirects) expect(served).toContainEqual(r);
    expect(served.every((r) => r.permanent === true)).toBe(true);
    expect(served.length).toBeGreaterThan(redirects.length);
  });

  it('the old route files are gone and the sitemap lists /about instead', () => {
    for (const d of ['how-it-works', 'pitch', 'faq']) expect(fs.existsSync(path.join(ROOT, 'src/app/[locale]', d)), d).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'src/app/[locale]/about/page.tsx'))).toBe(true);
  });
});

// Files owned by branches that were open when the routes moved (the landing page and the AI page): their few links still work through the
// redirect above and are moved to /about#... when those branches merge. Delete an entry here when its file is updated.
const STILL_VIA_REDIRECT = ['src/components/landing/HammerpriceLanding.tsx', 'src/components/ai/AiPage.tsx', 'src/components/ai/AskPanel.tsx'];

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(rel);
    return /\.(tsx?|json)$/.test(e.name) ? [rel] : [];
  });
}

describe('no page links the old routes', () => {
  // An href, a link field or a locale-prefixed path to one of the three old routes (not an import such as '@/server/ai/faq').
  const OLD_LINK = /(?:href[=:]\s*\{?\s*|link:\s*)[`"'][^`"']*\/(how-it-works|pitch|faq)(?=[#`"'?/])/;

  it('in src (outside the files above)', () => {
    const offenders: string[] = [];
    for (const f of walk('src').filter((x) => !STILL_VIA_REDIRECT.includes(x) && !x.startsWith('src/lib/old-routes'))) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (OLD_LINK.test(line) && !/\/pitch\/(en|de)\//.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('in llms.txt', () => {
    expect(fs.readFileSync(path.join(ROOT, 'public/llms.txt'), 'utf8')).not.toMatch(/\/(?:en|de)\/(?:how-it-works|pitch|faq)\b/);
  });
});
