import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { locales, NAMESPACES } from '../config';
import { loadMessages } from '../messages';

const ROOT = path.join(__dirname, '..', '..', '..', 'locales');
const files = (l: string) => fs.readdirSync(path.join(ROOT, l)).filter((f) => f.endsWith('.json')).sort();
const read = (l: string, f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, l, f), 'utf8')) as Record<string, unknown>;
const flat = (o: Record<string, unknown>, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]));

type Msgs = { landing: { hero: { coldOpen: { heading: string } }; status: { copy: string }; catalogue: { note: string } }; nav: unknown };

describe('locales', () => {
  it('has the same files in every locale', () => {
    for (const l of locales) expect(files(l)).toEqual(files(locales[0]));
  });

  it('declares a file for every namespace', () => {
    for (const l of locales) for (const ns of NAMESPACES) expect(files(l), `${l}/${ns}`).toContain(`${ns}.json`);
  });

  it('has the same keys in de and en (both languages complete)', () => {
    for (const f of files('en')) expect(flat(read('de', f)).sort(), f).toEqual(flat(read('en', f)).sort());
  });

  it('has no em dash and no empty string in any message (house style)', () => {
    for (const l of locales) for (const f of files(l)) {
      const text = fs.readFileSync(path.join(ROOT, l, f), 'utf8');
      expect(text, `${l}/${f}`).not.toContain('\u2014');
      expect(text, `${l}/${f}`).not.toMatch(/:\s*""/);
    }
  });

  it('loads every namespace, and falls back to English for an unknown locale', async () => {
    const de = await loadMessages('de');
    expect(Object.keys(de).sort()).toEqual([...NAMESPACES].sort());
    expect(de.nav.home).toBe('Startseite');
    expect((await loadMessages('xx')).nav.home).toBe('Home');
  });
  it.each(['en', 'de'])('the landing copy never says devnet, test money or replicas, on any network (%s)', async (l) => {
    const dev = (await loadMessages(l, 'devnet')) as unknown as Msgs;
    const main = (await loadMessages(l, 'mainnet-beta')) as unknown as Msgs;
    expect(JSON.stringify(dev.landing)).not.toMatch(/test|Test|Spielgeld|devnet|Devnet/);
    expect(JSON.stringify(dev.landing)).not.toMatch(/Replikat|Replik|replica/);
    expect(main.landing.catalogue.note).toBe(dev.landing.catalogue.note);
    expect(main.landing.hero.coldOpen).toEqual(dev.landing.hero.coldOpen);
    // everything else is untouched, and the heading stays the same
    expect(main.landing.hero.coldOpen.heading).toBe(dev.landing.hero.coldOpen.heading);
    expect(main.nav).toEqual(dev.nav);
  });
});

/**
 * The demo panels (room banner, rooms page, packs page) are short tutorial lines: they do not name the money or the replicas.
 * Those are said where a person acts (the faucet and its explanation, the network line, the footer line, the demo outcome after a win
 * or a reveal). The tutorial lines that say what each demo shows (rooms.demo.tutorialLive/Timed, packs list.demoTutorial) are separate keys.
 */
describe('the demo panels are neutral', () => {
  const PANELS: Array<[string, string[]]> = [['rooms.json', ['demo', 'sentence']], ['packs.json', ['list', 'demoSentence']]];
  it.each(locales)('%s', (l) => {
    for (const [f, keyPath] of [...PANELS, ['rooms.json', ['demo', 'try']], ['rooms.json', ['demo', 'bots']]] as typeof PANELS) {
      const text = String(keyPath.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], read(l, f)));
      // one "Tutorial:" per panel: the two sentences carry it, the intro and the banner's bot line do not (the banner takes it from tutorialLive/Timed)
      if (PANELS.some(([, k]) => k.join('.') === keyPath.join('.'))) expect(text, `${l}/${f} ${keyPath.join('.')}`).toMatch(/^Tutorial: /);
      else expect(text, `${l}/${f} ${keyPath.join('.')}`).not.toMatch(/Tutorial/);
      expect(text, `${l}/${f} ${keyPath.join('.')}`).not.toMatch(/test usdc|test-usdc|replica|replik|devnet|settles nothing|wickelt nichts ab/i);
    }
  });
});

/** The tutorial line under the demo pack names only the network (devnet) and what the visitor gets (a copy of the drawn card in the wallet): no test USDC, no replicas; mainnet has no demo pack and drops the network. */
describe('the packs tutorial line is one short neutral line', () => {
  const LINE = { en: 'Tutorial on devnet: you are not charged, and a copy of the card you draw is minted into your wallet.', de: 'Tutorial im Devnet: Es wird nichts berechnet, und eine Kopie der gezogenen Karte wird in Ihre Wallet geprägt.' } as const;
  it.each(locales)('%s', (l) => {
    const list = (read(l, 'packs.json') as { list: Record<string, string> }).list;
    expect(list.demoTutorial).toBe(LINE[l as 'en' | 'de']);
    expect(list.demoTutorialMain).not.toMatch(/devnet|test/i);
    expect(list.demoTutorialMain).toMatch(/^Tutorial: /);
    expect(JSON.stringify(read(l, 'packs.json'))).not.toMatch(/test usdc|test-usdc/i);
  });
});

/**
 * The site reads like a live product in the wording it will use on mainnet: no page says "test money", "no real money" or "Spielgeld".
 * What stays are the honest demo hints at the place where a person acts: the footer line, the faucet and its explanation, the network
 * line (settlement, wallet help, proof panel) and the Demo labels. None of them needs these phrases; if one ever has to, name its key here.
 */
describe('no test-money wording outside the legal texts', () => {
  const BANNED = /no real money|kein echtes Geld|test money|Spielgeld|Testgeld/i;
  /** `file.key`: the reason. Legal pages are not locale files (src/legal/content), legal.json is the chrome of those pages. */
  const ALLOWED: Record<string, string> = {
    'footer.demo': 'the single footer line, hidden on mainnet by code',
  };
  // explain.json belongs to the About page owner and still carries the old sentences; drop this entry when that rewrite lands.
  const PENDING = new Set<string>();
  const entries = (o: Record<string, unknown>, p = ''): Array<[string, string]> =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? entries(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]));
  it.each(locales)('%s', (l) => {
    for (const f of files(l)) {
      if (f === 'legal.json' || PENDING.has(f)) continue;
      for (const [k, text] of entries(read(l, f))) {
        if (ALLOWED[`${f.replace('.json', '')}.${k}`]) continue;
        expect(text, `${l}/${f} ${k}`).not.toMatch(BANNED);
      }
    }
  });
});
