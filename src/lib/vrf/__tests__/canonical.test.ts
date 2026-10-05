import { describe, expect, it } from 'vitest';
import { canonicalJson, paramsHashOf, sha256Hex } from '../canonical';
import { commitmentOf, lotOrderParams, packEpochParams, raffleParams } from '../commitment';
import { LOT_IDS, SHOW_ID } from './testkit';

describe('canonical JSON', () => {
  it('sorts keys recursively, no whitespace, integers only', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: null }], a: 'ä"', c: true })).toBe('{"a":"ä\\"","b":[3,{"a":null,"z":1}],"c":true}');
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: NaN })).toThrow();
    expect(() => canonicalJson(10n)).toThrow();
  });
  it('sha256 of the empty string is the known constant', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(paramsHashOf({})).toBe(sha256Hex('{}'));
  });
});

describe('commitments', () => {
  it('lot order: sorted by number, canonical text is stable', () => {
    const lots = [3, 1, 2].map((n) => ({ id: LOT_IDS[n - 1]!, n }));
    const p = lotOrderParams(SHOW_ID, lots);
    expect(p.lots.map((l) => l.n)).toEqual([1, 2, 3]);
    expect(commitmentOf(p).canonical).toBe(`{"lots":[${[1, 2, 3].map((n) => `{"id":"${LOT_IDS[n - 1]}","n":${n}}`).join(',')}],"show":"${SHOW_ID}","v":1}`);
    expect(commitmentOf(p).paramsHash).toBe(paramsHashOf(p));
  });
  it('refuses duplicates, bad ids and empty sets', () => {
    expect(() => lotOrderParams(SHOW_ID, [])).toThrow();
    expect(() => lotOrderParams(SHOW_ID, [{ id: LOT_IDS[0]!, n: 1 }, { id: LOT_IDS[1]!, n: 1 }])).toThrow();
    expect(() => lotOrderParams(SHOW_ID, [{ id: LOT_IDS[0]!, n: 1 }, { id: LOT_IDS[0]!, n: 2 }])).toThrow();
    expect(() => lotOrderParams('Bad', [{ id: LOT_IDS[0]!, n: 1 }])).toThrow();
    expect(() => lotOrderParams(SHOW_ID, [{ id: LOT_IDS[0]!, n: 0 }])).toThrow();
  });
  it('raffle sorts entrants and refuses duplicates', () => {
    expect(raffleParams(SHOW_ID, [9, 4, 6]).entrants).toEqual([4, 6, 9]);
    expect(() => raffleParams(SHOW_ID, [4, 4])).toThrow();
    expect(() => raffleParams(SHOW_ID, [])).toThrow();
  });
  it('pack epoch', () => {
    const h = sha256Hex('a');
    expect(packEpochParams('2026-10-03T14:00:00.000Z', h, h).v).toBe(1);
    expect(() => packEpochParams('2026-10-03T14:30:00Z', h, h)).toThrow();
    expect(() => packEpochParams('2026-10-03T14:00:00Z', 'x', h)).toThrow();
  });
});
