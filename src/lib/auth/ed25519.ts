/**
 * The two byte-level primitives every signed text in this folder uses. Browser and Edge safe (no Buffer).
 * Signatures travel as canonical base64: re-encoding the decoded bytes must give the same string, so a
 * signature has exactly one spelling and "flip the unused trailing bits" is not a way to mutate it.
 */
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export function decodePubkey(base58: string): Uint8Array | null {
  try {
    const bytes = bs58.decode(base58);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return toBase64(bytes) === b64 ? bytes : null;
  } catch {
    return null;
  }
}

/** True only when `signatureB64` is `pubkeyB58` signing exactly the UTF-8 bytes of `message`. Never throws. */
export function verifySigned(message: string, signatureB64: string, pubkeyB58: string): boolean {
  const pub = decodePubkey(pubkeyB58);
  const sig = fromBase64(signatureB64);
  if (!pub || !sig || sig.length !== 64) return false;
  try {
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pub);
  } catch {
    return false;
  }
}
