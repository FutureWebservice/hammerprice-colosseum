/**
 * Copy rules for the help namespaces (tour, glossary): house style, the planned vocabulary, length limits, and the
 * network wording (a text about test money has a mainnet twin; the twin never says "test"; devnet never says "real money").
 * Parity of keys and the Sie-form are also covered by the generic locale tests, which read every file.
 */
import { describe, expect, it } from 'vitest';
import de from '@/locales/de/tour.json';
import en from '@/locales/en/tour.json';
import deG from '@/locales/de/glossary.json';
import enG from '@/locales/en/glossary.json';
import { DEVNET_ONLY, GLOSSARY_IDS, TERM_MAX_CHARS, visibleTermIds } from '@/components/glossary/terms';
import { HINT_KINDS } from '@/components/explain/WalletPromptHint';
import { MAIN_SUFFIX } from '@/lib/client/cluster-text';
import { ALL_TOUR_STEP_IDS } from '../steps';

type Tree = { [k: string]: string | Tree };
const FILES: Array<[string, Tree]> = [['de/tour', de], ['en/tour', en], ['de/glossary', deG], ['en/glossary', enG]];

function flat(o: Tree, p = ''): Array<[string, string]> {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${p}${k}`, v] as [string, string]] : flat(v, `${p}${k}.`)));
}

// What a test-network sentence looks like, in both languages.
const TESTY = /test|replik|replica|devnet|übung|practice|play money|spielgeld/i;
const REAL_MONEY = /real money|echtes geld|echtem geld/i;
// The vocabulary list: words that belong only to "Advanced" and technical areas, never to everyday text.
const TECH_ONLY = /\b(paddle|paddleauthv1|reserve|hammer|settlement|co-sign|strike|faucet|signieren|sign|signs|signed)\b/i;
// The glossary entry that explains the technical word may name it.
const MAY_NAME_DEVNET = new Set(['terms.devnet.label', 'terms.devnet.text']);
// A glossary sentence may give the English or technical alias of its term, so a reader of the room can match the word they see.
const MAY_NAME_ALIAS = new Set(['terms.paddle.text', 'terms.reserve.text', 'terms.hammerPrice.text', 'terms.settlement.text']);

describe.each(FILES)('%s', (name, tree) => {
  const entries = flat(tree);
  it('has no em dash, en dash or empty text', () => {
    for (const [k, v] of entries) { expect(v, `${name} ${k}`).not.toMatch(/[\u2014–]/); expect(v.trim(), `${name} ${k}`).not.toBe(''); }
  });
  it('uses none of the technical words in everyday text', () => {
    for (const [k, v] of entries) {
      const text = MAY_NAME_DEVNET.has(k) ? v.replace(/devnet/gi, '') : MAY_NAME_ALIAS.has(k) ? v.replace(/\b(paddle|reserve|hammer|settlement)\b/gi, '') : v;
      expect(text, `${name} ${k}`).not.toMatch(TECH_ONLY);
      if (!MAY_NAME_DEVNET.has(k)) expect(text, `${name} ${k}`).not.toMatch(/devnet/i);
    }
  });
  it('has no gradient or rank claim wording', () => {
    for (const [k, v] of entries) expect(v, `${name} ${k}`).not.toMatch(/gradient|\b(6th|7th)\b|ideathon/i);
  });
});

describe('network wording', () => {
  for (const [name, tree] of FILES) {
    const entries = flat(tree);
    const keys = new Set(entries.map(([k]) => k));
    it(`${name}: every Main text has a plain twin, and the Main text never mentions the test network`, () => {
      for (const [k, v] of entries) {
        if (!k.endsWith(MAIN_SUFFIX)) continue;
        expect(keys.has(k.slice(0, -MAIN_SUFFIX.length)), `${name} ${k} has no twin`).toBe(true);
        expect(v, `${name} ${k}`).not.toMatch(TESTY);
      }
    });
    it(`${name}: a plain text about the test network has a Main twin or is devnet-only`, () => {
      for (const [k, v] of entries) {
        if (k.endsWith(MAIN_SUFFIX) || !TESTY.test(v)) continue;
        if (name.endsWith('glossary') && DEVNET_ONLY.some((id) => k.startsWith(`terms.${id}.`))) continue;
        expect(keys.has(k + MAIN_SUFFIX), `${name} ${k} talks about test money but has no ${k}${MAIN_SUFFIX}`).toBe(true);
      }
    });
    it(`${name}: nothing promises real money on the test network`, () => {
      for (const [k, v] of entries) if (!k.endsWith(MAIN_SUFFIX)) expect(v, `${name} ${k}`).not.toMatch(REAL_MONEY);
    });
  }

  it('on mainnet no visible glossary term, in any language, says test network', () => {
    for (const g of [enG, deG]) {
      for (const id of visibleTermIds('mainnet-beta')) {
        const term = (g.terms as Record<string, Record<string, string>>)[id]!;
        const text = term[`text${MAIN_SUFFIX}`] ?? term.text!;
        expect(text, id).not.toMatch(TESTY);
        expect(term.label, id).not.toMatch(TESTY);
      }
    }
  });
  it('the test-network terms are exactly the ones hidden on mainnet', () => {
    expect(GLOSSARY_IDS.filter((id) => !visibleTermIds('mainnet-beta').includes(id))).toEqual([...DEVNET_ONLY]);
    expect(visibleTermIds('devnet')).toEqual([...GLOSSARY_IDS]);
  });
});

describe('structure and limits', () => {
  it('the glossary has the 19 terms with a label and one sentence of at most 140 characters, in both languages', () => {
    expect(GLOSSARY_IDS).toHaveLength(19);
    for (const g of [enG, deG]) {
      expect(Object.keys(g.terms).sort()).toEqual([...GLOSSARY_IDS].sort());
      for (const [id, t] of Object.entries(g.terms as Record<string, Record<string, string>>)) {
        for (const [k, v] of Object.entries(t)) {
          if (k.startsWith('text')) expect(v.length, `${id}.${k}: ${v.length} characters`).toBeLessThanOrEqual(TERM_MAX_CHARS);
        }
        expect(t.label!.length, id).toBeGreaterThan(0);
      }
    }
  });
  it('every tour step has a sentence of at most 120 characters, and the buttons exist, in both languages', () => {
    for (const t of [en, de]) {
      for (const id of ALL_TOUR_STEP_IDS) expect(t.tour.steps[id].length, id).toBeLessThanOrEqual(120);
      for (const k of ['next', 'back', 'skip', 'done', 'progress', 'label'] as const) expect(t.tour[k], k).toBeTruthy();
    }
  });
  it('every wallet hint kind has a text in both languages and a mainnet twin where it names test money', () => {
    for (const t of [en, de]) {
      const hint = t.hint as Record<string, string>;
      for (const k of HINT_KINDS) {
        expect(hint[k], k).toBeTruthy();
        if (TESTY.test(hint[k]!)) expect(hint[k + MAIN_SUFFIX], `${k} needs ${k}${MAIN_SUFFIX}`).toBeTruthy();
      }
    }
  });
  it('a hint is one sentence and says the wallet may show its own notes, not what a wallet shows', () => {
    for (const t of [en, de]) {
      for (const k of HINT_KINDS) {
        const s = (t.hint as Record<string, string>)[k]!;
        expect(s.split(/[.!?]\s/).length, s).toBe(1);
      }
      expect(t.hint.caveat).toMatch(/may show its own notes|eigene Hinweise einblenden/);
    }
  });
  it('the German texts match the planned wording for the tour and the advanced fold', () => {
    expect(de.tour.steps.stage).toBe('Hier sehen Sie die Karte, die gerade aufgerufen wird.');
    expect(de.advanced.title).toBe('Erweitert');
    expect(en.advanced.title).toBe('Advanced options');
    expect(deG.title).toBe('Was bedeutet das?');
    expect(enG.title).toBe('What does this mean?');
  });
});
