/**
 * A static reader of the import graph that says which message namespaces the CLIENT side of a page can ask the provider for.
 * Used by route-namespaces.test.ts, which keeps src/lib/i18n/route-namespaces.ts honest. Reads only source text (no TypeScript API): it follows
 * `import ... from`, `export ... from` and `import('...')` with the `@/` alias and relative paths, and finds `useTranslations('ns.sub')`,
 * `useClusterT('ns')` and the two forms that cannot be read statically (`useTranslations()` with no argument, `useMessages`).
 */
import fs from 'node:fs';
import path from 'node:path';

export const SRC = path.join(__dirname, '..', '..', '..');
const EXT = ['.tsx', '.ts', '/index.tsx', '/index.ts'];

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const e of ['', ...EXT]) {
    const f = base + e;
    if (fs.existsSync(f) && fs.statSync(f).isFile() && /\.(tsx?|ts)$/.test(f)) return f;
  }
  return null;
}

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Comments are not code: a doc comment that shows `useTranslations('x')` must not count as a use. */
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

export function importsOf(file: string, text = stripComments(fs.readFileSync(file, 'utf8')), o: { dynamic?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? (o.dynamic === false ? undefined : m[2]);
    if (!spec) continue;
    // `import type` pulls in nothing at run time.
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue;
    const r = resolveSpec(file, spec);
    if (r) out.push(r);
  }
  return out;
}

export interface Usage { namespaces: Set<string>; dynamic: boolean }

/** `useTranslations('a.b')` is namespace `a.b`; the part after the first dot narrows what the page needs but the provider is filled per top-level key. */
export function usageOf(text: string): Usage {
  const namespaces = new Set<string>();
  let dynamic = false;
  for (const m of text.matchAll(/\buse(?:Translations|ClusterT)\(\s*(['"])([\w.]+)\1/g)) namespaces.add(m[2]);
  if (/\buseTranslations\(\s*\)/.test(text) || /\buseMessages\(/.test(text)) dynamic = true;
  return { namespaces, dynamic };
}

/** Every file a page can reach (itself included), skipping tests. */
export function closure(entries: string[], o: { dynamic?: boolean } = {}): string[] {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f) || f.includes('__tests__')) continue;
    seen.add(f);
    for (const d of importsOf(f, undefined, o)) stack.push(d);
  }
  return [...seen];
}

/** Top-level namespaces (and the dotted paths) the client code under these entries reads, with the files that ask. */
export function namespacesOf(entries: string[]): { top: Map<string, string[]>; dotted: Map<string, string[]>; dynamicFiles: string[] } {
  const top = new Map<string, string[]>();
  const dotted = new Map<string, string[]>();
  const dynamicFiles: string[] = [];
  for (const f of closure(entries)) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    // Not only 'use client' files: a hook module without the directive is client code when a client file imports it. Server-only files that call
    // the synchronous useTranslations are counted too, which can only make the list longer, never miss a namespace.
    const u = usageOf(text);
    if (u.dynamic) dynamicFiles.push(path.relative(SRC, f));
    for (const n of u.namespaces) {
      const t = n.split('.')[0];
      (top.get(t) ?? top.set(t, []).get(t)!).push(path.relative(SRC, f));
      (dotted.get(n) ?? dotted.set(n, []).get(n)!).push(path.relative(SRC, f));
    }
  }
  return { top, dotted, dynamicFiles };
}

/** The npm packages a set of entries imports STATICALLY (so they ship with the page's own script; a dynamic import is a later chunk). Returns package -> first file. */
export function staticPackages(entries: string[], pkgs: string[]): Map<string, string> {
  const hit = new Map<string, string>();
  for (const f of closure(entries, { dynamic: false })) {
    const text = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      if (m[1]) continue;
      for (const p of pkgs) if ((m[2] === p || m[2].startsWith(p + '/')) && !hit.has(p)) hit.set(p, path.relative(SRC, f));
    }
  }
  return hit;
}
