import { describe, expect, it } from 'vitest';
import { sha512 } from '@noble/hashes/sha2';
import { concat, fromHex, u32be } from '../bytes';
import { WordStream, drawIndex, lotOrderFromOutput, raffleWinnerFromOutput, shuffle } from '../derive';
import golden from './derive-golden.json';

/** derive-golden.json was produced by an independent Python implementation of the documented steps (hashlib). */
describe('derivation, golden vectors (independent Python reference)', () => {
  for (const g of golden) {
    const out = fromHex(g.output, 64);
    describe(`output ${g.output.slice(0, 8)}`, () => {
      it('word stream', () => {
        const s = new WordStream(out);
        expect(g.first_words.map(() => '0x' + s.next().toString(16))).toEqual(g.first_words);
      });
      it('uniformInt(6) x20 and mixed moduli', () => {
        const s = new WordStream(out);
        expect(Array.from({ length: 20 }, () => s.uniformInt(6))).toEqual(g.uniform6);
        const m = new WordStream(out);
        expect([1, 2, 3, 1000003, 2 ** 53 - 1, 2 ** 32].map((n) => m.uniformInt(n))).toEqual(g.uniformMixed);
      });
      it('shuffle of 10 and a draw of 7', () => {
        expect(shuffle(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual(g.shuffle10);
        expect(drawIndex(out, 7)).toBe(g.draw7);
      });
    });
  }
});

describe('derivation properties', () => {
  const seedOut = (i: number) => sha512(concat(new TextEncoder().encode('seed'), u32be(i)));

  it('a shuffle is a permutation and does not mutate its input', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const copy = [...items];
    const s = shuffle(seedOut(1), items);
    expect(items).toEqual(copy);
    expect([...s].sort((a, b) => a - b)).toEqual(items);
  });
  it('is deterministic and the lot order maps ids', () => {
    const ids = ['a', 'b', 'c', 'd'];
    expect(lotOrderFromOutput(seedOut(2), ids)).toEqual(lotOrderFromOutput(seedOut(2), ids));
    expect(raffleWinnerFromOutput(seedOut(2), [10, 20, 30])).toBe([10, 20, 30][drawIndex(seedOut(2), 3)]);
  });
  it('uniformInt(n) is uniform: chi-square for n = 6 over 10000 outputs stays under the 5% critical value (11.07)', () => {
    const counts = Array(6).fill(0) as number[];
    for (let i = 0; i < 10_000; i++) counts[drawIndex(seedOut(i), 6)]!++;
    const e = 10_000 / 6;
    const chi = counts.reduce((a, c) => a + (c - e) ** 2 / e, 0);
    expect(chi).toBeLessThan(11.07);
  });
  it('a shuffle of 3 reaches all 6 permutations about equally often', () => {
    const seen = new Map<string, number>();
    for (let i = 0; i < 6000; i++) { const k = shuffle(seedOut(i), [1, 2, 3]).join(); seen.set(k, (seen.get(k) ?? 0) + 1); }
    expect(seen.size).toBe(6);
    const e = 1000;
    expect([...seen.values()].reduce((a, c) => a + (c - e) ** 2 / e, 0)).toBeLessThan(11.07);
  });
  it('rejection sampling: a word at or above floor(2^64/n)*n is skipped (artificial output)', () => {
    // A real word that high has probability 2^-64, so stub the stream: first word rejected, second accepted.
    const s = new WordStream(seedOut(0));
    const words = [(1n << 64n) - 1n, 7n];
    (s as unknown as { next: () => bigint }).next = () => words.shift()!;
    expect(s.uniformInt(3)).toBe(1); // first word rejected, 7 mod 3
    expect(words.length).toBe(0);
  });
  it('refuses bad arguments', () => {
    expect(() => new WordStream(new Uint8Array(32))).toThrow();
    expect(() => new WordStream(seedOut(0)).uniformInt(0)).toThrow();
    expect(() => new WordStream(seedOut(0)).uniformInt(1.5)).toThrow();
  });
});
