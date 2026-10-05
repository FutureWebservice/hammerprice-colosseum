import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../canonical';
import { MEMO_MAX_BYTES, buildCommitMemo, buildDefaultMemo, buildKeyMemo, buildRevealMemo, parseMemo } from '../memo';
import { BEACON_SLOT, REQUEST_ID, b58hash, makeWorld } from './testkit';

const ph = sha256Hex('x');
const beacon = { slot: BEACON_SLOT, blockhash: b58hash('b') };

describe('memo formats', () => {
  it('commit is 122 bytes and round-trips', () => {
    const m = buildCommitMemo(REQUEST_ID, ph, 1_790_000_120);
    expect(m).toBe(`hp:vrf:c1:${REQUEST_ID}:${ph}:1790000120`);
    expect(new TextEncoder().encode(m).length).toBe(122);
    expect(parseMemo(m)).toEqual({ kind: 'commit', requestId: REQUEST_ID, paramsHash: ph, revealByUnix: 1_790_000_120 });
  });
  it('reveal, default and key round-trip and stay under the transaction limit', () => {
    const w = makeWorld();
    const r = buildRevealMemo(REQUEST_ID, beacon, w.view.proofHex!);
    expect(r.length).toBeLessThan(MEMO_MAX_BYTES);
    expect(r.length).toBeGreaterThan(250);
    expect(parseMemo(r)).toEqual({ kind: 'reveal', requestId: REQUEST_ID, beacon, proofHex: w.view.proofHex });
    expect(parseMemo(buildDefaultMemo(REQUEST_ID))).toEqual({ kind: 'default', requestId: REQUEST_ID });
    for (const c of ['devnet', 'mainnet-beta'] as const) {
      expect(parseMemo(buildKeyMemo(w.publicKey, c))).toEqual({ kind: 'key', publicKey: w.publicKey, cluster: c });
    }
  });
  it('parser accepts nothing but the built spelling', () => {
    const c = buildCommitMemo(REQUEST_ID, ph, 1_790_000_120);
    for (const bad of ['', 'hello', c + ':', c + ' ', c.replace('c1', 'c2'), c.replace(REQUEST_ID, REQUEST_ID.toUpperCase()), c.slice(0, -1), 'hp:vrf:c1:x', `hp:vrf:d1:${REQUEST_ID}:`, c.replace('hp:', 'xp:')]) {
      expect(parseMemo(bad), bad).toBeNull();
    }
  });
  it('builders refuse bad input', () => {
    expect(() => buildCommitMemo('x', ph, 1_790_000_120)).toThrow();
    expect(() => buildCommitMemo(REQUEST_ID, 'zz', 1_790_000_120)).toThrow();
    expect(() => buildCommitMemo(REQUEST_ID, ph, 12)).toThrow();
    expect(() => buildRevealMemo(REQUEST_ID, beacon, 'ab')).toThrow();
    expect(() => buildKeyMemo('abc', 'devnet')).toThrow();
  });
});
