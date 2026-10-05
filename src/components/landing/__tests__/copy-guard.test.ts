/**
 * The house style and the truthfulness rules, enforced on everything CONTENT owns: the marketing
 * locale files, the documents and the public text files. A sentence that breaks a rule fails the build.
 *
 *   - no em dash in any user-facing copy or document (plain direct sentences instead)
 *   - none of the claims the audit found false or the owner ruled out
 *   - the ideathon wording is the owner's exact line, on landing, pitch and about
 *   - the vault count is one figure everywhere ("more than 150,000"), not a mix of 132k/140k/150k
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IDEATHON_LINE } from '../site';

const ROOT = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function walk(dir: string, accept: (f: string) => boolean): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(rel, accept);
    return accept(rel) ? [rel] : [];
  });
}

const DOCS = ['README.md'].filter((f) => fs.existsSync(path.join(ROOT, f)));
const PUBLIC_TEXT = ['public/llms.txt', 'public/manifest.webmanifest'];
const LOCALE_FILES = ['en', 'de'].flatMap((l) => ['landing', 'pitch', 'explain', 'aipage'].map((n) => `src/locales/${l}/${n}.json`));
const SOURCES = [
  ...['src/components/landing', 'src/components/explain', 'src/components/pitch', 'src/components/scrolly', 'src/components/gallery']
    .flatMap((d) => walk(d, (f) => /\.(tsx?|css)$/.test(f))),
  'src/components/ai/AiPage.tsx', 'src/app/[locale]/ai/page.tsx', 'src/components/layout/Header.tsx', 'src/components/layout/Footer.tsx',
  'src/app/[locale]/page.tsx', 'src/app/[locale]/about/page.tsx',
  'src/app/opengraph-image.tsx', 'src/app/sitemap.ts', 'src/app/robots.ts',
];

// Phrases that must never appear in copy or documents. Case-insensitive.
const BANNED: Array<[RegExp, string]> = [
  [/nothing here is a mockup/i, 'the audit found this claim false'],
  [/nichts hier ist ein mockup/i, 'the audit found this claim false'],
  [/won the ideathon/i, 'the owner ruled out claiming a win'],
  [/ideathon gewonnen|den ideathon gewonnen/i, 'the owner ruled out claiming a win'],
  [/\b6th\b/i, 'the exact rank is not verified, never state one'],
  [/\b7th\b/i, 'the exact rank is not verified, never state one'],
  [/\b(sechster|siebter|6\.|7\.) platz\b/i, 'the exact rank is not verified, never state one'],
  [/top[- ]10 finisher/i, 'the exact rank is not verified, never state one'],
  [/140,000|140\.000|132k|132\.000|132,000/i, 'the vault count is "more than 150,000" everywhere'],
  [/\b164 tests\b/i, 'a stale test count'],
  [/hammerprice\.app/i, 'a domain the project does not own'],
  [/juror (quote|feedback)|positive (juror|jury) feedback/i, 'no juror quote or feedback claim'],
];

describe('em dash', () => {
  it.each([...LOCALE_FILES, ...DOCS, ...PUBLIC_TEXT])('%s has none', (f) => {
    expect(read(f)).not.toContain('\u2014');
  });
});

describe('banned claims', () => {
  it.each([...LOCALE_FILES, ...DOCS, ...PUBLIC_TEXT, ...SOURCES])('%s makes none of them', (f) => {
    const text = read(f);
    for (const [re, why] of BANNED) expect(text, `${f}: ${re} (${why})`).not.toMatch(re);
  });

  it('does not describe machinery that was deleted', () => {
    const gone = [/bot filter|isMaliciousBot|PASSWORD_PROTECT|password wall/i, /NEXT_LOCALE/, /supabase/i, /delegate rail|TransferDelegate|core_delegate rail/i, /server-sent events|EventSource|SSE live feed|SSE feed/i];
    for (const f of DOCS) {
      const t = read(f);
      // A document may say a thing was removed; it may not describe it as present. Such mentions are
      // allowed only in a paragraph that also says it was cut, deleted or replaced.
      for (const re of gone) {
        for (const para of t.split(/\n\s*\n/).filter((p) => re.test(p))) {
          expect(para, `${f}: ${para.trim().slice(0, 100)}`).toMatch(/cut|delet|remov|replac|never|no longer|not built|gone|instead of|stripped/i);
        }
      }
    }
  });
});

describe('ideathon wording', () => {
  it('is the owner\'s exact line, in both languages', () => {
    expect(IDEATHON_LINE.en).toBe("One of ten prize winners at Superteam Germany's Road to Colosseum Ideathon");
    expect(IDEATHON_LINE.de).toBe('Einer von zehn Preisträgern beim Road-to-Colosseum-Ideathon von Superteam Germany');
  });

  it('carries no number of submissions, anywhere', () => {
    expect(IDEATHON_LINE.en).not.toMatch(/\d/);
    expect(IDEATHON_LINE.de).not.toMatch(/\d/);
  });

  it('is rendered from that one constant in the pitch section of the about page, and not on the landing page', () => {
    for (const f of ['src/components/pitch/PitchSections.tsx']) {
      expect(read(f), f).toContain('IDEATHON_LINE');
    }
    for (const f of ['src/components/landing/HammerpriceLanding.tsx', 'src/components/landing/journeys/Journeys.tsx']) {
      expect(read(f), f).not.toContain('IDEATHON_LINE');
    }
    for (const l of ['en', 'de']) expect(read(`src/locales/${l}/landing.json`), l).not.toMatch(/Ideathon/i);
  });

  it('appears verbatim in llms.txt and in the submission', () => {
    expect(read('public/llms.txt')).toContain(IDEATHON_LINE.en);
    if (fs.existsSync(path.join(ROOT, 'SUBMISSION.md'))) expect(read('SUBMISSION.md')).toContain(IDEATHON_LINE.en);
  });
});

describe('truthfulness of the headline claims', () => {
  it('says nothing about devnet or a test network on the landing page, and never claims mainnet is live', () => {
    const NETWORK = /devnet|testnet|test network|testnetz|test[- ]usdc|spielgeld/i;
    for (const l of ['en', 'de']) {
      const landing = read(`src/locales/${l}/landing.json`);
      expect(landing, l).not.toMatch(NETWORK);
      expect(landing, l).not.toMatch(/mainnet-?live|live on mainnet|auf mainnet live|im mainnet live/i);
      // the feature explainers are landing copy too; only the docs-only keys (status, intro) may name the network
      expect(JSON.stringify(JSON.parse(read(`src/locales/${l}/features.json`)).items), l).not.toMatch(NETWORK);
    }
  });

  it('presents the product as live and in beta, mainnet as a plan, and makes no user, volume or revenue claim', () => {
    const en = JSON.parse(read('src/locales/en/landing.json')).product.copy as string;
    const de = JSON.parse(read('src/locales/de/landing.json')).product.copy as string;
    expect(en).toMatch(/is live/);
    expect(en).toMatch(/beta/);
    expect(en).toMatch(/plan to/);
    expect(de).toMatch(/ist live/);
    expect(de).toMatch(/Beta/);
    expect(de).toMatch(/planen/);
    for (const t of [en, de]) expect(t).not.toMatch(/\d|users?\b|nutzer|umsatz|revenue|volume|volumen/i);
  });

  it('keeps the headline the site is built around', () => {
    expect(read('src/locales/en/landing.json')).toContain('The hammer is the payment.');
    expect(read('src/locales/de/landing.json')).toContain('Der Hammer ist die Zahlung.');
  });

  it('never offers "Buy now" as a thing you can do: no explain or pitch text names it (the engine and the route exist, no screen has a button)', () => {
    for (const l of ['en', 'de']) {
      for (const f of ['explain', 'pitch']) expect(read(`src/locales/${l}/${f}.json`), `${l}/${f}`).not.toMatch(/buy now|sofort kaufen|jetzt kaufen/i);
    }
  });
});
