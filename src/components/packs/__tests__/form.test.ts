import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { PackCreateRequest } from '@/contracts';
import { cardLine, parsePackForm, previewOdds, START, switchMode, type FormInput } from '../form';

const a = () => Keypair.generate().publicKey.toBase58();
const base = (o: Partial<FormInput> = {}): FormInput => ({
  nameDe: 'Mein Pack', nameEn: 'My pack', price: '12.50', cap: '5', mode: 'chance',
  odds: 'common; Häufig; Common; 70\nrare; Selten; Rare; 30',
  cards: `${a()}; common; Card A\n${a()}; common; Card B; https://example.com/b.png; 25\n${a()}; rare; Card C`, ...o,
});

describe('parsePackForm', () => {
  it('turns the typed lines into the strict request (percent to bps, USDC to base units)', () => {
    const r = parsePackForm(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request).toMatchObject({ name: { de: 'Mein Pack', en: 'My pack' }, mode: 'chance', price: '12500000', perWalletDailyCap: 5 });
    expect(r.request.odds).toEqual([{ tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 7000 }, { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 3000 }]);
    expect(r.request.cards[1]).toMatchObject({ name: 'Card B', imageUrl: 'https://example.com/b.png', listedValue: '25000000' });
    expect(r.request.cards).toHaveLength(3);
  });
  it('reports the chances that do not add up to 100', () => {
    const r = parsePackForm(base({ odds: 'common; Häufig; Common; 70\nrare; Selten; Rare; 20' }));
    expect(r).toMatchObject({ ok: false, oddsSum: 90 });
  });
  it('names the line of every problem', () => {
    const r = parsePackForm(base({ cards: `nope; common; A\n${a()}; common\n${a()}; common; B; http://insecure.example/x.png`, odds: '; a; b; 100', price: '0', cap: '99' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((x) => x.line).sort()).toEqual([0, 0, 1, 1, 2, 3].sort());
  });
  it('a card of an unknown tier, a duplicate card or a value on an equal-value pack with mixed values is refused by the contract', () => {
    const dup = a();
    expect(parsePackForm(base({ cards: `${dup}; common; A\n${dup}; rare; B` })).ok).toBe(false);
    expect(parsePackForm(base({ cards: `${a()}; ghost; A` })).ok).toBe(false);
    const eq = parsePackForm({ ...base(), mode: 'equal_value', odds: 'all; Alle; All; 100', cards: `${a()}; all; A; ; 10\n${a()}; all; B; ; 10` });
    expect(eq.ok).toBe(true);
    expect(parsePackForm({ ...base(), mode: 'equal_value', odds: 'all; Alle; All; 100', cards: `${a()}; all; A; ; 10\n${a()}; all; B; ; 11` }).ok).toBe(false);
  });
});

describe('the form as people fill it (reported: "Line 1: German and English name needed" and "Line 1: tier id and name needed")', () => {
  const issuesOf = (r: ReturnType<typeof parsePackForm>) => (r.ok ? [] : r.issues);

  it('takes the cards the wallet picker wrote before any odds existed: the empty tier is the first tier of the odds, and the request is what the create route accepts', () => {
    const picked = [a(), a()].map((mint, i) => cardLine({ mint, name: `Picked ${i}`, imageUrl: null }, ''));
    const r = parsePackForm(base({ cards: `${picked.join('\n')}\n${a()}; rare; Card C` }));
    expect(issuesOf(r)).toEqual([]);
    if (!r.ok) return;
    expect(r.request.cards.map((c) => c.tier)).toEqual(['common', 'common', 'rare']);
    expect(PackCreateRequest.safeParse(r.request).success).toBe(true); // the schema of POST /api/packs
  });

  it('takes an odds line without the names: "id; name; chance" uses the name for both languages, "id; chance" the id, a blank language the other one', () => {
    const r = parsePackForm(base({ odds: 'common; 70\nrare; Selten; 25\nlegend; ; Legend; 5', cards: `${a()}; common; A\n${a()}; rare; B\n${a()}; legend; C` }));
    expect(issuesOf(r)).toEqual([]);
    if (!r.ok) return;
    expect(r.request.odds).toEqual([
      { tier: 'common', label: { de: 'common', en: 'common' }, bps: 7000 },
      { tier: 'rare', label: { de: 'Selten', en: 'Selten' }, bps: 2500 },
      { tier: 'legend', label: { de: 'Legend', en: 'Legend' }, bps: 500 },
    ]);
    expect(PackCreateRequest.safeParse(r.request).success).toBe(true);
  });

  it('takes the chance the way it is typed: a percent sign, a decimal comma, and cents that floating point gets wrong (0.07 * 100)', () => {
    const r = parsePackForm(base({ odds: 'a; A; A; 0.07\nb; B; B; 33,33%\nc; C; C; 66.6', cards: `${a()}; a; X\n${a()}; b; Y\n${a()}; c; Z` }));
    expect(issuesOf(r)).toEqual([]);
    if (!r.ok) return;
    expect(r.request.odds.map((o) => o.bps)).toEqual([7, 3333, 6660]);
  });

  it('reads an odds line the same way in the live preview and at submit', () => {
    for (const odds of ['common; 100', 'common; Häufig; 100', 'common; Häufig; Common; 100', 'common; ; Common; 100%']) {
      const r = parsePackForm(base({ odds, cards: `${a()}; common; A` }));
      expect(r.ok, odds).toBe(true);
      if (r.ok) expect(previewOdds(odds).rows).toEqual(r.request.odds);
    }
  });

  it('still refuses what is really wrong, with the line named: a bad or missing chance, a card without a name, a blank tier with no odds to take it from', () => {
    for (const odds of ['common; Häufig; Common', 'common; Häufig; Common; abc', 'common; Häufig; Common; 0', 'common; Häufig; Common; 100.01', 'common; Häufig; Common; 33.333', 'common']) {
      expect(issuesOf(parsePackForm(base({ odds }))), odds).toContainEqual({ line: 1, why: 'chance: percent above 0, at most 2 decimals' });
    }
    expect(issuesOf(parsePackForm(base({ cards: `${a()}; common` })))).toEqual([{ line: 1, why: 'tier id and name needed' }]);
    expect(issuesOf(parsePackForm(base({ odds: '', cards: `${a()}; ; Card` })))).toEqual([{ line: 1, why: 'tier id and name needed' }]);
  });

  it('saves as it starts: only a card is added (the start values are valid, an equal-value card takes the pack price)', () => {
    const r = parsePackForm({ ...START, cards: `${a()}; ; Card A\n${a()}; all; Card B` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.cards.map((c) => c.listedValue)).toEqual(['5000000', '5000000']);
    const c = parsePackForm(switchMode({ ...START, cards: `${a()}; all; Card A` }, 'chance'));
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.request.cards.map((x) => x.tier)).toEqual(['common']);
  });

  it('makes a rarity id out of whatever is typed instead of refusing it, on the odds line and on the card line alike; one language name is enough', () => {
    const r = parsePackForm(base({ nameEn: '', odds: 'Ultra Rare; Selten; 60\nGewöhnlich; 40', cards: `${a()}; Ultra Rare; Card A\n${a()}; Gewöhnlich; Card B` }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.request.odds.map((o) => o.tier)).toEqual(['ultra-rare', 'gewohnlich']);
      expect(r.request.cards.map((c) => c.tier)).toEqual(['ultra-rare', 'gewohnlich']);
      expect(r.request.name).toEqual({ de: 'Mein Pack', en: 'Mein Pack' });
    }
  });

  it('keeps odds the person already edited when the pack type changes', () => {
    const f = { ...START, odds: 'x; Xx; Xx; 100' };
    expect(switchMode(f, 'chance')).toEqual({ ...f, mode: 'chance' });
  });

  it('a rarity without a card is left out and the others share its chance (the start odds with one rarity filled)', () => {
    const r = parsePackForm({ ...START, mode: 'chance', odds: 'common; Häufig; Common; 80\nrare; Selten; Rare; 20', cards: `${a()}; common; Card A\n${a()}; ; Card B` });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.request.odds.map((o) => [o.tier, o.bps])).toEqual([['common', 10_000]]);
    const t = parsePackForm({ ...START, mode: 'chance', odds: 'a; A; A; 50\nb; B; B; 30\nc; C; C; 20', cards: `${a()}; a; X\n${a()}; b; Y` });
    expect(t.ok).toBe(true);
    if (t.ok) { const bps = t.request.odds.map((o) => o.bps); expect(bps.reduce((x, y) => x + y, 0)).toBe(10_000); expect(t.request.odds.map((o) => o.tier)).toEqual(['a', 'b']); }
  });
});
