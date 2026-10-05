import { describe, expect, it } from 'vitest';
import { checkBody, duplicateKey, MAX_BODY_CHARS, normalizeBody } from '../rules';

const cp = (...n: number[]): string => String.fromCodePoint(...n);
const ZWSP = cp(0x200b);
const RLO = cp(0x202e);
const BOM = cp(0xfeff);

const refused = (s: string) => { const r = checkBody(s); return r.ok ? 'ok' : r.reason; };

describe('normalizeBody', () => {
  it('folds width, drops invisible and bidi characters, collapses white space', () => {
    expect(normalizeBody(`  Hel${ZWSP}lo${RLO}   wor${' '}ld${BOM} `)).toBe('Hello wor ld');
    expect(normalizeBody(cp(0xff28, 0xff49))).toBe('Hi'); // full-width letters
    expect(normalizeBody('a\n\n\nb')).toBe('a b');
  });
  it('keeps emoji and umlauts', () => {
    expect(normalizeBody('Schöne Karte \u{1F44D}')).toBe('Schöne Karte \u{1F44D}');
  });
});

describe('checkBody: what is refused', () => {
  const table: [string, string][] = [
    ['', 'empty'],
    [`   ${ZWSP}  `, 'empty'],
    ['x'.repeat(MAX_BODY_CHARS + 1), 'too_long'],
    ['see https://evil.example/x', 'link'],
    ['visit www.scam.io now', 'link'],
    ['hxxps://scam', 'link'],
    ['go to scam.com', 'link'],
    ['my site: shop.example.xyz', 'link'],
    ['join t.me/mygroup', 'link'],
    ['scam[.]com', 'link'],
    ['scam (dot) com', 'link'],
    [`ht${ZWSP}tps://x`, 'link'],
    [`h${cp(0xff54)}tp://x`, 'link'],
    ['mail me: a.b@example.com', 'contact_data'],
    ['write me at name [at] example.com', 'contact_data'],
    ['dm @cardking', 'contact_data'],
    ['call +49 170 1234567', 'contact_data'],
    ['0170-123 45 67 8', 'contact_data'],
    ['send to 3Cv8UNdmzgmNFGNo6U7iAMHjf3wv6679SZV3BfTWwdiU', 'contact_data'],
    ['tx 5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW', 'contact_data'],
    ['0x1234567890abcdef1234567890abcdef12345678', 'contact_data'],
    ['AMAZING CARD NOW', 'shouting'],
    ['wowwwwww nice', 'shouting'],
    ['!!!!!', 'shouting'],
  ];
  for (const [text, reason] of table) it(`${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)} is ${reason}`, () => expect(refused(text)).toBe(reason));
});

describe('checkBody: ordinary talk passes', () => {
  const ok = [
    'Schöne Karte, viel Erfolg allen.',
    'Is the card really PSA 10?',
    'Lot 3 looks great, bid 75 USDC',
    'Danke, bis zum nächsten Mal!',
    'Mir gefällt Nr. 12 am besten',
    'GG',
    'OK',
    'z.B. die Holo Version',
    'it costs 1,500 or so',
    'Hello! (nice one) ...',
    'Wann endet das 5. Los? Um 18:30?',
    'Great pull \u{1F389}\u{1F389}',
    'e.g. the first edition',
  ];
  for (const text of ok) it(JSON.stringify(text), () => expect(refused(text)).toBe('ok'));
  it('returns the normalised body', () => {
    const r = checkBody(`  a${ZWSP}b   c `);
    expect(r).toEqual({ ok: true, body: 'ab c' });
  });
  it('counts code points, not UTF-16 units', () => {
    const emoji = (n: number) => Array.from({ length: n }, (_, i) => `${cp(0x1f600 + (i % 40))} `).join('');
    expect(refused(emoji(100))).toBe('ok'); // 199 code points, 299 UTF-16 units
    expect(refused(emoji(101))).toBe('too_long');
  });
});

describe('duplicateKey', () => {
  it('ignores case, spacing and punctuation', () => {
    expect(duplicateKey('Hello,  World!')).toBe(duplicateKey('hello world'));
    expect(duplicateKey('a')).not.toBe(duplicateKey('b'));
  });
});
