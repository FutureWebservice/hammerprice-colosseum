/**
 * The vocabulary list, applied to the user texts of the room, sell, account and rooms pages next to the
 * help files (tour, glossary): the technical words stay in "Advanced" and technical areas, everything else says bidding number, minimum
 * price, sold, payment and handover, warning, "claim test USDC" and "confirm". Also: no em dash, no en dash, German in the formal address.
 * The settlement, vrf, chat, ai, packs, video and timed namespaces and the explain and pitch files are not covered here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

type Tree = { [k: string]: string | Tree };
const FILES = ['room', 'sell', 'account', 'rooms', 'tour', 'glossary', 'nav', 'common'] as const;
const load = (l: string, f: string): Tree => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/locales', l, `${f}.json`), 'utf8')) as Tree;
function flat(o: Tree, p = ''): Array<[string, string]> {
  return Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[`${p}${k}`, v] as [string, string]] : flat(v, `${p}${k}.`)));
}

// Technical words. "Hammerprice" is the product name, and an ICU placeholder such as {paddle} is not text.
const TECH = {
  en: /\b(paddles?|reserve|hammer|hammered|strikes?|faucet|co-sign\w*|settlement)\b/i,
  de: /(paddle|reserve|hammer(?!price)|strike|faucet|settlement|abwicklung|mitsignier)/i,
};
// Where the technical word is the point: the glossary sentences that give the alias (tour.test covers them), and the Advanced area of the account.
// The seller's binding rules (wizard, manager, strike notice) mirror the contract copy that the legal texts and the contract-copy tests assume word for word.
const MAY_USE_TECH = new Set([
  'sell.wizard.publish.ruleCosign', 'sell.wizard.publish.ruleOnline', 'sell.manage.rules', 'account.desk.bannerSeller',
  'account.advanced.body', 'account.advanced.paddles',
  'glossary.terms.paddle.text', 'glossary.terms.reserve.text', 'glossary.terms.hammerPrice.text', 'glossary.terms.settlement.text',
  'glossary.terms.devnet.text',
]);
const strip = (s: string) => s.replace(/\{[^}]*\}/g, '');

describe.each(['en', 'de'] as const)('user texts (%s)', (l) => {
  const all = FILES.flatMap((f) => flat(load(l, f), `${f}.`).map(([k, v]) => [k, v] as [string, string]));

  it('has no em dash and no en dash anywhere', () => {
    for (const [k, v] of all) expect(v, k).not.toMatch(/[\u2014–]/);
  });
  it('uses none of the technical words outside the places that explain them', () => {
    for (const [k, v] of all) {
      if (MAY_USE_TECH.has(k)) continue;
      expect(strip(v), k).not.toMatch(TECH[l]);
    }
  });
  it('has no gradient wording and no placeholder text', () => {
    for (const [k, v] of all) {
      expect(v, k).not.toMatch(/gradient|lorem ipsum|TODO|TBD|\bXXX\b/i);
      expect(v.trim(), k).not.toBe('');
    }
  });
});

describe('German formal address in the new texts', () => {
  const NEW = ['room.ready.connect.watch', 'sell.gate.noWallet', 'rooms.emptyHouse', 'rooms.errorAuto', 'common.skipToContent'];
  it('never uses du, dein, dir, dich or euch', () => {
    const de = new Map(FILES.flatMap((f) => flat(load('de', f), `${f}.`)));
    for (const k of NEW) expect(de.get(k), k).toBeTruthy();
    for (const [k, v] of de) expect(v, k).not.toMatch(/\b(du|dein\w*|dir|dich|euch|euer\w*)\b/); // lower case only: "Ihr" and "Ihnen" are the formal address
  });
  it('the new texts exist in both languages', () => {
    const en = new Map(FILES.flatMap((f) => flat(load('en', f), `${f}.`)));
    for (const k of NEW) expect(en.get(k), k).toBeTruthy();
  });
});
