/**
 * Prove and verify with @blueshift-gg/solana-ecvrf (RFC 9381 ECVRF-EDWARDS25519-SHA512-TAI, byte for byte the
 * solana-ecvrf Rust crate; pinned to 0.0.1 because it is a young package, vectors in __tests__ catch any drift).
 * Browser safe. `vrfProve` is the only place a secret key is used and it proves canonical alphas only.
 */
import { Proof, PublicKey, SecretKey } from '@blueshift-gg/solana-ecvrf';
import { isBase58Key32, parseAlpha } from './alpha';
import { fromHex, toHex, utf8 } from './bytes';
import { VrfError } from './types';

export interface ProofResult { proofHex: string; outputHex: string }

/** RFC 9381 prove, then verify with the public key before anything is stored or published. */
export function vrfProve(secret: SecretKey, alphaText: string): ProofResult {
  parseAlpha(alphaText); // refuses any text that is not a canonical alpha
  const alpha = utf8(alphaText);
  const proof = secret.prove(alpha);
  let output: Uint8Array;
  try { output = proof.verify(secret.publicKey, alpha); } catch { throw new VrfError('bad_proof', 'self-check of the fresh proof failed'); }
  return { proofHex: toHex(proof.bytes), outputHex: toHex(output) };
}

/** The 64-byte output (hex) if `proofHex` proves `alphaText` under `publicKey` (base58), else VrfError('bad_proof'). */
export function vrfVerify(publicKey: string, alphaText: string, proofHex: string): string {
  if (!isBase58Key32(publicKey)) throw new VrfError('bad_proof', 'invalid public key');
  try {
    const pk = PublicKey.from(publicKey);
    return toHex(Proof.from(fromHex(proofHex, 80)).verify(pk, utf8(alphaText)));
  } catch (e) {
    if (e instanceof VrfError) throw new VrfError('bad_proof', 'proof is not 80 bytes of lowercase hex');
    throw new VrfError('bad_proof', (e as Error).message === 'invalid public key' ? 'invalid public key' : 'proof does not verify');
  }
}
