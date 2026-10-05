/**
 * The admin panel is not advertised: no public page, component, locale text or sitemap entry mentions its path, robots.txt does not allow it,
 * and its layout says noindex.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import robots from '@/app/robots';
import sitemap from '@/app/sitemap';

const SRC = path.resolve(__dirname, '../../..');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'admin' ? [] : walk(p); // the admin's own files may name it
  return /\.(tsx?|json|md)$/.test(e.name) ? [p] : [];
});

describe('the admin panel stays unlisted', () => {
  it('no public file links to /admin', () => {
    const hits = [...walk(path.join(SRC, 'components')), ...walk(path.join(SRC, 'app', '[locale]')), ...walk(path.join(SRC, 'locales')), ...walk(path.join(SRC, 'content'))]
      .filter((f) => /["'`]\/(?:\$\{[^}]*\}|en|de)?\/?admin(?:[/"'`?#]|$)/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f));
    expect(hits).toEqual([]);
  });

  it('robots.txt and the sitemap do not name it, the layout asks for noindex', () => {
    expect(JSON.stringify(robots())).not.toMatch(/admin/);
    expect(sitemap().map((e) => e.url).join('\n')).not.toMatch(/admin/);
    expect(fs.readFileSync(path.join(SRC, 'app', '[locale]', 'admin', 'layout.tsx'), 'utf8')).toMatch(/robots:\s*\{\s*index:\s*false/);
  });
});
