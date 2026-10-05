import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.join(__dirname, '..', '..', '..', 'public');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
// middleware.ts pulls in next/server, which vitest cannot load, so the pattern is read from the source text.
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'middleware.ts'), 'utf8');
const pattern = /'(\/\(\(\?![^']+)'/.exec(src)?.[1] ?? '';
const matcher = new RegExp(`^${pattern.replace(/\\\\/g, '\\')}$`);

describe('middleware matcher', () => {
  // A file in public/ that goes through the locale middleware gets a 307 to /en/<file> and then a 404 (the manifest did).
  it('skips every static file in public/', () => {
    for (const f of walk(PUBLIC)) {
      const url = '/' + path.relative(PUBLIC, f).split(path.sep).join('/');
      if (url.startsWith('/generated/') || url.startsWith('/pitch/') || url.startsWith('/icons/')) continue; // image trees, covered by their extensions below
      expect({ url, localised: matcher.test(url) }).toEqual({ url, localised: false });
    }
  });
  it('skips images by extension and still localises pages', () => {
    for (const f of walk(PUBLIC)) {
      if (/\.(webp|jpg|png|ico)$/.test(f)) expect(matcher.test('/' + path.relative(PUBLIC, f).split(path.sep).join('/'))).toBe(false);
    }
    for (const page of ['/en', '/de/rooms', '/pitch', '/room/house']) expect(matcher.test(page)).toBe(true);
  });
});
