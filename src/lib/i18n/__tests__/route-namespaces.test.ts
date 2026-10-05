/**
 * The per-route message lists (src/lib/i18n/route-namespaces.ts) must cover everything the client components of a route read. A page whose
 * provider lacks a namespace renders the raw key instead of the text, and a test that renders one component never sees that. So this reads the import
 * graph of every route (namespace-graph.ts) and compares.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAMESPACES } from '../config';
import { CHROME, pickMessages, ROUTE_NAMESPACES, type RouteGroup } from '../route-namespaces';
import { namespacesOf, SRC } from './namespace-graph';

const APP = path.join(SRC, 'app', '[locale]');
const top = (names: readonly string[]) => new Set(names.map((n) => n.split('.')[0]));

/** Every page.tsx and layout.tsx below a directory. */
function entriesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...entriesUnder(f));
    else if (/^(page|layout)\.tsx$/.test(e.name)) out.push(f);
  }
  return out;
}

/** The route groups are the directories of app/[locale] that have a page below them. */
const groups = fs.readdirSync(APP, { withFileTypes: true }).filter((e) => e.isDirectory() && entriesUnder(path.join(APP, e.name)).some((f) => f.endsWith('page.tsx'))).map((e) => e.name);
/** Groups that need nothing beyond the chrome (their client components read no namespace of their own). */
const CHROME_ONLY = new Set(['admin', 'legal', '[...rest]']);

describe('route message namespaces', () => {
  it('every name in the lists is a real namespace', () => {
    for (const n of [...CHROME, ...Object.values(ROUTE_NAMESPACES).flat()]) expect(NAMESPACES as readonly string[], n).toContain(n.split('.')[0]);
  });

  it('every route group is either listed or known to need only the chrome, and has its layout when listed', () => {
    for (const g of groups) {
      const listed = g in ROUTE_NAMESPACES;
      expect(listed || CHROME_ONLY.has(g), `${g} is a route group with pages: add it to ROUTE_NAMESPACES (and a layout.tsx using PageMessages) or to CHROME_ONLY here`).toBe(true);
      if (listed) expect(fs.existsSync(path.join(APP, g, 'layout.tsx')), `${g}/layout.tsx`).toBe(true);
    }
    for (const g of Object.keys(ROUTE_NAMESPACES)) expect(groups, g).toContain(g);
  });

  for (const g of groups) {
    it(`${g}: the client components read only namespaces the list sends`, () => {
      expect(g in ROUTE_NAMESPACES || CHROME_ONLY.has(g)).toBe(true);
      const used = namespacesOf(entriesUnder(path.join(APP, g)).filter((f) => f.endsWith('page.tsx')));
      expect(used.dynamicFiles, 'useTranslations() without a namespace, or useMessages, cannot be checked').toEqual([]);
      if (g in ROUTE_NAMESPACES) {
        const own = top(ROUTE_NAMESPACES[g as RouteGroup]);
        for (const [ns, files] of used.top) expect(own.has(ns), `${g} reads '${ns}' (${files.slice(0, 3).join(', ')}) but ROUTE_NAMESPACES.${g} does not send it`).toBe(true);
      } else {
        // No layout of its own: the page reads the root layout's provider, which holds CHROME only.
        for (const [ns, files] of used.dotted) expect(CHROME.some((c) => ns === c || ns.startsWith(c + '.')), `${g} reads '${ns}' (${files.slice(0, 3).join(', ')}): CHROME does not send it, so give ${g} a route group`).toBe(true);
      }
    });
  }

  it('the chrome reads only what CHROME sends, and only the listed parts of the namespaces it takes in part', () => {
    const used = namespacesOf(['layout.tsx', 'error.tsx', 'not-found.tsx'].map((f) => path.join(APP, f)));
    expect(used.dynamicFiles).toEqual([]);
    const sent = top(CHROME);
    for (const [ns, files] of used.top) expect(sent.has(ns), `the page chrome reads '${ns}' (${files.join(', ')}) but CHROME does not send it`).toBe(true);
    // Namespaces taken in part: every literal key those files ask for must start with a sent path.
    const partial: Array<{ file: string; call: string; ns: string }> = [
      { file: 'components/layout/SiteChrome.tsx', call: 'room', ns: 'room' },
      { file: 'components/room/WalletSheet.tsx', call: 't', ns: 'room' },
      { file: 'components/layout/Header.tsx', call: 'ta', ns: 'account' },
      { file: 'components/layout/Header.tsx', call: 'th', ns: 'tour' },
      { file: 'components/tour/HelpMenu.tsx', call: 't', ns: 'tour' },
    ];
    for (const p of partial) {
      const text = fs.readFileSync(path.join(SRC, p.file), 'utf8');
      const keys = [...text.matchAll(new RegExp(`\\b${p.call}\\(\\s*[\`'"]([A-Za-z0-9_.]+)`, 'g'))].map((m) => m[1]);
      expect(keys.length, `${p.file} ${p.call}()`).toBeGreaterThan(0);
      for (const k of keys) {
        const full = `${p.ns}.${k}`;
        expect(CHROME.some((c) => full === c || full.startsWith(c + '.')), `${p.file} asks ${full}, which CHROME does not send`).toBe(true);
      }
    }
    // The Header's session control reads account.session.* through `t` (its other `t` is the nav namespace).
    const header = fs.readFileSync(path.join(SRC, 'components/layout/Header.tsx'), 'utf8');
    for (const m of header.matchAll(/\bt\('(session\.[A-Za-z]+)'/g)) expect(CHROME, m[1]).toContain('account.session');
  });
});

describe('pickMessages', () => {
  const all = { a: { x: 1, y: { z: 2 } }, b: { k: 'v' }, c: 3 };
  it('takes whole namespaces and paths inside them, and skips what does not exist', () => {
    expect(pickMessages(all, ['b'])).toEqual({ b: { k: 'v' } });
    expect(pickMessages(all, ['a.y'])).toEqual({ a: { y: { z: 2 } } });
    expect(pickMessages(all, ['a.y.z', 'a.x', 'nope', 'b.nope.deeper'])).toEqual({ a: { x: 1, y: { z: 2 } } });
  });
  it('does not change its input', () => {
    pickMessages(all, ['a.y', 'a']);
    expect(all).toEqual({ a: { x: 1, y: { z: 2 } }, b: { k: 'v' }, c: 3 });
  });
});
