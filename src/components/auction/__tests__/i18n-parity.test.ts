import { describe, expect, it } from 'vitest';
import deRoom from '@/locales/de/room.json';
import enRoom from '@/locales/en/room.json';
import deSettlement from '@/locales/de/settlement.json';
import enSettlement from '@/locales/en/settlement.json';

type Tree = { [k: string]: string | Tree };
const leaves = (tree: Tree, prefix = ''): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === 'string') out.set(prefix + k, v);
    else for (const [k2, v2] of leaves(v, `${prefix}${k}.`)) out.set(k2, v2);
  }
  return out;
};
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)[,}]/g)].map((m) => m[1]).sort().join(',');

describe.each([['room', deRoom, enRoom], ['settlement', deSettlement, enSettlement]] as const)('i18n parity: %s', (_name, de, en) => {
  const d = leaves(de as Tree);
  const e = leaves(en as Tree);
  it('has the same keys in de and en', () => {
    expect([...d.keys()].filter((k) => !e.has(k))).toEqual([]);
    expect([...e.keys()].filter((k) => !d.has(k))).toEqual([]);
  });
  it('uses the same placeholders in both languages', () => {
    for (const [k, v] of d) expect(placeholders(v), k).toBe(placeholders(e.get(k) ?? ''));
  });
  it('has no empty strings and no em dashes', () => {
    for (const map of [d, e]) for (const [k, v] of map) { expect(v.trim(), k).not.toBe(''); expect(v, k).not.toMatch(/\u2014/); }
  });
});
