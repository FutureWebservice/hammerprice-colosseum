/**
 * Loads a legal text: reads src/legal/content/{locale}/{key}.md, drops the editor comments, fills the
 * {{PLACEHOLDERS}} from the config and parses the result into blocks. Server only (fs).
 *
 * The guards live here because every page goes through `loadLegalDoc`:
 *  - a placeholder that the config does not know is an error in every environment;
 *  - on a production deployment (VERCEL_ENV=production) a non-empty UNRESOLVED list, or any
 *    "[TBD: ...]" marker in a text, fails the render, which fails `next build` for these static pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Locale } from '@/lib/i18n/config';
import { LEGAL, UNRESOLVED, type PlaceholderValues, type Unresolved } from './config';
import { parseBlocks, type Block } from './markdown';
import { LEGAL_KEYS, type LegalKey } from './routes';
import { recipientsTable, storageTable } from './tables';

export interface LegalDoc {
  key: LegalKey;
  locale: Locale;
  title: string;
  description: string;
  blocks: Block[];
}

export const CONTENT_DIR = path.join(process.cwd(), 'src', 'legal', 'content');

export function assertLegalReady(env: Record<string, string | undefined> = process.env, unresolved: readonly Unresolved[] = UNRESOLVED): void {
  if (env.VERCEL_ENV === 'production' && unresolved.length > 0) {
    throw new Error(
      'Legal texts are not ready for production. Unresolved: ' + unresolved.map((u) => `${u.key} (${u.reason})`).join('; '),
    );
  }
}

/** `---` front matter with `key: "value"` lines, then the body. */
export function splitFrontMatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src.replace(/\r\n?/g, '\n'));
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { meta, body: src.slice(m[0].length).replace(/\r\n?/g, '\n') };
}

const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

/** Pure: source text + config values in, blocks out. */
export function prepareDoc(source: string, locale: Locale, values: PlaceholderValues, opts: { strict?: boolean } = {}): Omit<LegalDoc, 'key'> {
  const { meta, body } = splitFrontMatter(source);
  const all: PlaceholderValues = { ...values, STORAGE_TABLE: storageTable(locale), RECIPIENTS_TABLE: recipientsTable(locale, values) };

  const text = body.replace(/<!--[\s\S]*?-->/g, '');
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    let onlyPlaceholders = /\{\{/.test(line);
    const filled = line.replace(PLACEHOLDER, (_, name: string) => {
      if (!(name in all)) throw new Error(`Unknown placeholder {{${name}}}`);
      if (all[name] !== '') onlyPlaceholders = false;
      return all[name];
    });
    // A line that is nothing but placeholders which all resolved to "" disappears (phone, W-IdNr.).
    if (onlyPlaceholders && filled.trim() === '') continue;
    if (/\{\{|\}\}/.test(filled)) throw new Error(`Malformed placeholder in: ${line}`);
    lines.push(filled);
  }
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  if (opts.strict && /\[TBD: /.test(out)) throw new Error('A text still contains a [TBD: ...] marker');

  return { locale, title: meta.title ?? '', description: meta.description ?? '', blocks: parseBlocks(out) };
}

export function loadLegalDoc(locale: Locale, key: LegalKey): LegalDoc {
  assertLegalReady();
  const source = fs.readFileSync(path.join(CONTENT_DIR, locale, `${key}.md`), 'utf8');
  const doc = prepareDoc(source, locale, LEGAL.values[locale], { strict: process.env.VERCEL_ENV === 'production' });
  return { key, ...doc };
}

/** Page titles for the navigation row, in SPEC order. */
export function legalTitles(locale: Locale): { key: LegalKey; title: string }[] {
  return LEGAL_KEYS.map((key) => ({ key, title: splitFrontMatter(fs.readFileSync(path.join(CONTENT_DIR, locale, `${key}.md`), 'utf8')).meta.title ?? key }));
}
