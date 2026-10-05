import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLUSTERS, resolveCluster } from '@/lib/chain/config';
import { buildAlpha, parseAlpha, ALPHA_HEADER } from '../alpha';
import { sha256Hex } from '../canonical';
import { vrfProve, vrfVerify } from '../prove';
import { ALPHA_PURPOSE_OF, CLUSTER_LIST, isCluster } from '../types';
import { REQUEST_ID, b58hash, makeWorld, secretKey } from './testkit';

const base = { cluster: 'devnet' as const, purpose: 'lot_order' as const, subject: REQUEST_ID, paramsHash: sha256Hex('p'), beacon: { slot: 123456, blockhash: b58hash('b') } };

describe('alpha text', () => {
  it('has exactly one spelling and round-trips', () => {
    const t = buildAlpha(base);
    expect(t.split('\n')).toEqual([
      ALPHA_HEADER, 'cluster: devnet', 'purpose: lot_order', `subject: ${REQUEST_ID}`, `params: ${base.paramsHash}`, `beacon: 123456:${base.beacon.blockhash}`,
    ]);
    expect(parseAlpha(t)).toEqual(base);
    expect(buildAlpha({ ...base, cluster: 'mainnet-beta', purpose: 'pack_pull' })).toContain('cluster: mainnet-beta\npurpose: pack_pull');
  });
  it('takes the cluster from the one config switch (SOLANA_CLUSTER), both values', () => {
    for (const [env, want] of [[{}, 'devnet'], [{ SOLANA_CLUSTER: 'devnet' }, 'devnet'], [{ SOLANA_CLUSTER: 'mainnet-beta' }, 'mainnet-beta']] as const) {
      const c = resolveCluster(env);
      expect(c).toBe(want);
      expect(parseAlpha(buildAlpha({ ...base, cluster: c })).cluster).toBe(want);
    }
  });
  it('rejects other spellings', () => {
    const t = buildAlpha(base);
    for (const bad of [t + '\n', t + ' ', t.replace(/\n/g, '\r\n'), t.replace('devnet', 'testnet'), t.replace('lot_order', 'Lot_order'), t.replace('123456', '0123456'),
      t.replace('123456', '+123456'), t.toUpperCase(), ' ' + t, t.replace('cluster: devnet\npurpose: lot_order', 'purpose: lot_order\ncluster: devnet'),
      t.replace(base.paramsHash, base.paramsHash.toUpperCase()), t.replace(REQUEST_ID, REQUEST_ID.toUpperCase()), '', t.split('\n').slice(0, 5).join('\n'),
      t.replace(`${base.beacon.blockhash}`, `${base.beacon.blockhash.slice(0, 40)}`), t.replace('subject: ', 'subject:  ')]) {
      expect(() => parseAlpha(bad), JSON.stringify(bad)).toThrow(/canonical/);
    }
  });
  it('builder refuses bad fields', () => {
    expect(() => buildAlpha({ ...base, cluster: 'x' as never })).toThrow();
    expect(() => buildAlpha({ ...base, subject: 'nope' })).toThrow();
    expect(() => buildAlpha({ ...base, paramsHash: 'ab' })).toThrow();
    expect(() => buildAlpha({ ...base, beacon: { slot: 1.5, blockhash: base.beacon.blockhash } })).toThrow();
    expect(() => buildAlpha({ ...base, beacon: { slot: 5, blockhash: 'short' } })).toThrow();
  });
  it('the browser-safe cluster list equals the config list', () => {
    expect([...CLUSTER_LIST].sort()).toEqual([...CLUSTERS].sort());
    expect(isCluster('devnet') && isCluster('mainnet-beta')).toBe(true);
    expect(isCluster('testnet') || isCluster('toString') || isCluster(5)).toBe(false);
  });
  it('maps every request purpose to an alpha purpose', () => {
    expect(ALPHA_PURPOSE_OF).toEqual({ lot_order: 'lot_order', raffle: 'raffle', pack_epoch: 'pack_pull' });
  });
  it('the prover refuses text that is not an alpha', () => {
    expect(() => vrfProve(secretKey(), 'sign this please')).toThrow(/canonical/);
  });
});

describe('mutation: any single-character change breaks the parse or the proof', () => {
  const w = makeWorld();
  const alpha = w.view.alphaText!;
  const pk = w.publicKey;
  const proof = w.view.proofHex!;
  const swaps = ['0', 'a', 'Z', ' ', '\n', ':', '9'];

  it('exhaustive over every position and 7 replacements', () => {
    let tried = 0;
    for (let i = 0; i < alpha.length; i++) {
      for (const r of swaps) {
        if (alpha[i] === r) continue;
        const m = alpha.slice(0, i) + r + alpha.slice(i + 1);
        tried++;
        let parsed = true;
        try { parseAlpha(m); } catch { parsed = false; }
        if (parsed) {
          // still a valid alpha: then it must be a different alpha, and the proof must not verify for it
          expect(m).not.toBe(alpha);
          expect(() => vrfVerify(pk, m, proof), `pos ${i} -> ${JSON.stringify(r)}`).toThrow();
        }
      }
    }
    expect(tried).toBeGreaterThan(1000);
  });

  it('fast-check: random single-character edits and truncations never keep both parse and verify', () => {
    fc.assert(
      fc.property(fc.nat(alpha.length - 1), fc.string({ minLength: 0, maxLength: 1 }), (i, ch) => {
        const m = alpha.slice(0, i) + ch + alpha.slice(i + 1);
        if (m === alpha) return true;
        try { parseAlpha(m); } catch { return true; }
        try { vrfVerify(pk, m, proof); } catch { return true; }
        return false;
      }),
      { numRuns: 300 },
    );
  });
});
