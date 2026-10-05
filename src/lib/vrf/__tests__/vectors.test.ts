/**
 * Known-answer tests. `vectors.json` is a copy of tests/vectors.json of github.com/blueshift-gg/solana-ecvrf (MIT), so a
 * changed package version shows up here. Its `rfc9381` section is RFC 9381 appendix B.3 (ECVRF-EDWARDS25519-SHA512-TAI,
 * examples 16 to 18), checked against the RFC text; `generated` is pinned to the Rust crate; `mixed_order` are valid
 * proofs under keys with a small-order component.
 */
import { Proof, PublicKey, SecretKey } from '@blueshift-gg/solana-ecvrf';
import { describe, expect, it } from 'vitest';
import { fromHex, toHex } from '../bytes';
import { vrfVerify } from '../prove';
import vectors from './vectors.json';

type V = { sk?: string; pk: string; alpha: string; pi: string; beta: string };
const b58 = (hex: string) => PublicKey.from(fromHex(hex)).toString();

describe('RFC 9381 B.3 (3 vectors)', () => {
  it.each(vectors.rfc9381 as V[])('prove and verify, pk=$pk', ({ sk, pk, alpha, pi, beta }) => {
    const key = SecretKey.fromSeed(fromHex(sk!));
    expect(toHex(key.publicKey.bytes)).toBe(pk);
    const proof = key.prove(fromHex(alpha));
    expect(toHex(proof.bytes)).toBe(pi);
    expect(toHex(proof.verify(key.publicKey, fromHex(alpha)))).toBe(beta);
    // the library path (base58 key, hex proof) gives the same beta
    expect(toHex(Proof.from(fromHex(pi)).verify(PublicKey.from(b58(pk)), fromHex(alpha)))).toBe(beta);
  });
});

describe('Rust crate vectors (24 generated)', () => {
  it.each(vectors.generated as V[])('pk=$pk alpha=$alpha', ({ sk, pk, alpha, pi, beta }) => {
    const key = SecretKey.fromSeed(fromHex(sk!));
    expect(toHex(key.publicKey.bytes)).toBe(pk);
    expect(toHex(key.prove(fromHex(alpha)).bytes)).toBe(pi);
    expect(toHex(Proof.from(fromHex(pi)).verify(PublicKey.from(fromHex(pk)), fromHex(alpha)))).toBe(beta);
  });
});

describe('mixed-order keys (3 vectors)', () => {
  it.each(vectors.mixed_order as V[])('verifies, pk=$pk', ({ pk, alpha, pi, beta }) => {
    const key = PublicKey.from(fromHex(pk));
    expect(key.isValid()).toBe(true);
    expect(toHex(Proof.from(fromHex(pi)).verify(key, fromHex(alpha)))).toBe(beta);
  });
});

describe('tampering', () => {
  const v = (vectors.rfc9381 as V[])[0]!;
  const key = SecretKey.fromSeed(fromHex(v.sk!));
  const alpha = fromHex(v.alpha);

  it('every single-bit change of the 80 proof bytes is rejected', () => {
    for (let i = 0; i < 80; i++) {
      const bad = fromHex(v.pi);
      bad[i]! ^= 1;
      expect(() => Proof.from(bad).verify(key.publicKey, alpha), `byte ${i}`).toThrow();
    }
  });
  it('another input or another key is rejected', () => {
    expect(() => Proof.from(fromHex(v.pi)).verify(key.publicKey, Uint8Array.of(1))).toThrow();
    const other = (vectors.rfc9381 as V[])[1]!;
    expect(() => Proof.from(fromHex(v.pi)).verify(PublicKey.from(fromHex(other.pk)), alpha)).toThrow();
  });
  it('vrfVerify refuses bad hex, bad keys and bad proofs with a bad_proof error and never a raw exception', () => {
    const a = 'whatever';
    expect(() => vrfVerify(b58(v.pk), a, 'zz')).toThrow(/bad_proof|80 bytes/);
    expect(() => vrfVerify('not-a-key', a, v.pi)).toThrow(/invalid public key/);
    expect(() => vrfVerify(b58(v.pk), a, v.pi)).toThrow(/does not verify/);
  });
});
