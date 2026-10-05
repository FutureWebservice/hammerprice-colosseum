/**
 * Keeps the legal texts true as the code grows. The privacy and cookies pages print two tables
 * (src/legal/tables.ts): what the site stores in the browser, and which hosts it talks to. This test
 * greps the source for both. A storage key or a host that is not in the tables fails here, which means
 * somebody added a tracker-shaped thing without telling the visitor. This test is what catches it when keys and hosts
 * are added from different branches.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HOSTS, STORAGE, STORAGE_NOT_SET } from '@/legal/tables';
import { PADDLE_MAX_VALIDITY_MS, PADDLE_MAX_VALIDITY_TIMED_MS } from '@/lib/auth/intent';

const SRC = path.join(process.cwd(), 'src');

function files(exts: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const rel = path.relative(SRC, p);
      if (fs.statSync(p).isDirectory()) {
        if (f === '__tests__' || f === 'fixtures' || rel === 'legal' || rel === 'locales') continue;
        walk(p);
      } else if (exts.test(f) && !/\.test\./.test(f)) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The literal (or literal prefix) of a storage key expression, resolving one level of `const NAME = '...'`. */
function keyOf(expr: string, src: string): string | null {
  const e = expr.trim();
  const lit = /^(['"`])([^'"`$]*)/.exec(e);
  if (lit) return lit[2];
  const c = new RegExp(`const\\s+${e.replace(/[^\w$]/g, '')}\\s*(?::[^=]+)?=\\s*(['"\`])([^'"\`$]*)`).exec(src);
  return c ? c[2] : null;
}

describe('every storage key in the source is in the cookies table', () => {
  const found: { file: string; key: string; how: string }[] = [];
  const unresolved: string[] = [];
  for (const f of files(/\.(ts|tsx)$/)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    const rel = path.relative(process.cwd(), f);
    for (const m of src.matchAll(/(localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*([^,)]+)/g)) {
      const k = keyOf(m[2], src);
      if (k === null) unresolved.push(`${rel}: ${m[0]}`);
      else found.push({ file: rel, key: k, how: m[1] });
    }
    // Keys reached through a helper (store().getItem(key)): the app names every one 'hp:...' or 'hp.sell...'.
    if (!/__tests__|^src\/(contracts|lib\/chain|server)\//.test(rel)) for (const m of src.matchAll(/(['"`])(hp[:.][a-z0-9:.${}_-]*)\1/gi)) found.push({ file: rel, key: m[2].replace(/\$\{[^}]*\}/g, ''), how: 'helper' });
    for (const m of src.matchAll(/document\.cookie\s*=\s*[`'"]([A-Za-z0-9_-]+)=/g)) found.push({ file: rel, key: m[1], how: 'cookie' });
    for (const m of src.matchAll(/cookies(?:\(\))?\.set\(\s*([^,)]+)/g)) {
      const k = keyOf(m[1], src);
      if (k === null) unresolved.push(`${rel}: ${m[0]}`);
      else found.push({ file: rel, key: k, how: 'cookie' });
    }
  }

  it('resolves every key it finds (a computed key must be made a literal or a const)', () => {
    expect(unresolved).toEqual([]);
  });

  it('lists each key, or explains why it is not set', () => {
    const missing = found.filter((f) => !STORAGE.some((e) => e.match.test(f.key)) && !(f.key in STORAGE_NOT_SET));
    expect(missing, 'add these to STORAGE in src/legal/tables.ts (and to the cookies page)').toEqual([]);
  });

  it('has one row per name and no two rows that match the same key family', () => {
    const names = STORAGE.map((e) => e.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i), 'duplicate row names').toEqual([]);
    const sources = STORAGE.map((e) => e.match.source);
    expect(sources.filter((x, i) => sources.indexOf(x) !== i), 'duplicate match patterns').toEqual([]);
    // every storage key the source uses is described by exactly one row
    const twice = found.filter((f) => STORAGE.filter((e) => e.match.test(f.key)).length > 1).map((f) => f.key);
    expect([...new Set(twice)], 'a key that two rows describe').toEqual([]);
  });

  it('the paddle row names the real validity limits (6 hours live, 7 days in a timed show)', () => {
    const row = STORAGE.find((e) => e.match.test('hp:paddle:x'));
    expect(PADDLE_MAX_VALIDITY_MS).toBe(6 * 3_600_000);
    expect(PADDLE_MAX_VALIDITY_TIMED_MS).toBe(7 * 86_400_000);
    expect(row?.duration.en).toMatch(/6 hours/);
    expect(row?.duration.en).toMatch(/7 days/);
    expect(row?.duration.de).toMatch(/6 Stunden/);
    expect(row?.duration.de).toMatch(/7 Tage/);
  });

  it('knows about the keys that exist today', () => {
    const keys = found.map((f) => f.key);
    expect(keys).toContain('hp.sell.recent');
    expect(keys.some((k) => k.startsWith('hp:paddle'))).toBe(true);
  });
});

describe('every host in the source is classified', () => {
  const hosts = new Map<string, string>();
  for (const f of files(/\.(ts|tsx|css)$/)) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) hosts.set(m[1].toLowerCase(), path.relative(process.cwd(), f));
  }

  it('has a class for each one (src/legal/tables.ts HOSTS)', () => {
    const unknown = [...hosts].filter(([h]) => !(h in HOSTS)).map(([h, f]) => `${h} (${f})`);
    expect(unknown, 'a new third-party host: classify it and update the privacy text').toEqual([]);
  });

  it('lists the browser-direct hosts in the privacy text', () => {
    const privacy = fs.readFileSync('src/legal/content/en/datenschutz.md', 'utf8') + fs.readFileSync('src/legal/tables.ts', 'utf8');
    expect(privacy).toMatch(/CloudFront/);
    expect(privacy).toMatch(/Helius/);
    const browserHosts = Object.entries(HOSTS).filter(([, k]) => k === 'browser').map(([h]) => h);
    expect(browserHosts.length).toBeGreaterThan(0);
  });

  it('names Google in the privacy text (DE and EN) while a Google host is classified', () => {
    const googleHosts = Object.entries(HOSTS).filter(([h, k]) => k === 'server' && /(^|\.)googleapis\.com$/.test(h) && h !== 'fonts.googleapis.com');
    expect(googleHosts.length).toBeGreaterThan(0);
    for (const l of ['de', 'en']) expect(fs.readFileSync(`src/legal/content/${l}/datenschutz.md`, 'utf8')).toMatch(/Google/);
  });

  it('the Content-Security-Policy only allows what the texts admit', () => {
    const cfg = fs.readFileSync('next.config.js', 'utf8');
    // image hosts: our own origin and the CloudFront distribution named in the privacy text
    expect(/img-src[^"]*/.exec(cfg)?.[0]).toMatch(/cloudfront\.net/);
    expect(cfg).toContain("font-src 'self'");
    expect(cfg).toContain("default-src 'self'");
  });
});
