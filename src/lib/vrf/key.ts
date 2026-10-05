/**
 * The VRF key. SERVER ONLY: this file refuses to run in a browser bundle and is NOT exported from ./index.
 *
 *  - Source: env VRF_SECRET_KEY, nothing else. Accepted forms: a 64-byte Solana keypair (JSON array of 64 numbers or
 *    base58, like the other role keys) or a 32-byte seed (JSON array of 32 numbers, 64 hex characters or base58).
 *    The Ed25519 address of the key IS the VRF public key (RFC 9381 over edwards25519).
 *  - Separate by construction: the key is never derived from, and must never equal, another role key
 *    (settlement authority, house seller, faucet authority). A shared key is a startup error.
 *  - It signs only memo transactions that carry a canonical alpha proof or one of our hp:vrf memos. There is no route
 *    that signs caller-supplied bytes, and `prove` refuses text that is not a canonical alpha.
 *  - Never printed: errors name the variable, never the value; the secret lives in private fields, so logging a VrfKey
 *    shows only the public key; `toJSON` is the public key.
 */
import { SecretKey } from '@blueshift-gg/solana-ecvrf';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { parseSecretKey, type KeyName } from '@/lib/chain/keys';
import { fromHex } from './bytes';
import { vrfProve, type ProofResult } from './prove';
import { VrfError } from './types';

type Env = Record<string, string | undefined>;
export const VRF_KEY_ENV = 'VRF_SECRET_KEY';
const ROLE_KEYS: readonly KeyName[] = ['SETTLEMENT_AUTHORITY_SECRET_KEY', 'HOUSE_SELLER_SECRET_KEY', 'FAUCET_MINT_AUTHORITY_SECRET_KEY'];

export class VrfKey {
  readonly publicKey: string;
  readonly #secret: SecretKey;
  readonly #keypair: Keypair;
  constructor(seed: Uint8Array) {
    this.#keypair = Keypair.fromSeed(seed);
    this.#secret = SecretKey.fromSeed(seed);
    this.publicKey = this.#keypair.publicKey.toBase58();
  }
  /** RFC 9381 proof for a canonical alpha, self-checked. */
  prove(alphaText: string): ProofResult { return vrfProve(this.#secret, alphaText); }
  /** The web3.js signer for the memo transactions (SA stays fee payer). Do not log it. */
  get signer(): Keypair { return this.#keypair; }
  toJSON(): { publicKey: string } { return { publicKey: this.publicKey }; }
  toString(): string { return `VrfKey(${this.publicKey})`; }
}

const invalid = () => new VrfError('key_invalid', `${VRF_KEY_ENV} is not a valid key (64-byte keypair or 32-byte seed as JSON array, hex or base58)`);

/** Parse a raw env value to a 32-byte seed. The error never contains the value. */
export function parseVrfSeed(raw: string): Uint8Array {
  try {
    const v = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    const bytes = v.startsWith('[') ? Uint8Array.from(JSON.parse(v) as number[]) : /^[0-9a-f]{64}$/.test(v) ? fromHex(v) : bs58.decode(v);
    if (bytes.length === 32) return bytes;
    if (bytes.length === 64) {
      const seed = bytes.slice(0, 32);
      if (Keypair.fromSeed(seed).publicKey.toBase58() !== bs58.encode(bytes.slice(32))) throw new Error('mismatch');
      return seed;
    }
  } catch { /* fall through */ }
  throw invalid();
}

/** null when VRF_SECRET_KEY is unset (the feature then falls back to catalogue order). */
export function loadVrfKey(env: Env = process.env): VrfKey | null {
  if (typeof window !== 'undefined') throw new VrfError('browser_bundle', 'the VRF key cannot be loaded in a browser bundle');
  const raw = env[VRF_KEY_ENV];
  if (!raw?.trim()) return null;
  const key = new VrfKey(parseVrfSeed(raw));
  for (const name of ROLE_KEYS) {
    const other = env[name];
    if (!other?.trim()) continue;
    let pub: string | null = null;
    try { pub = parseSecretKey(name, other).publicKey.toBase58(); } catch { /* an unreadable role key is that module's problem */ }
    if (pub === key.publicKey) throw new VrfError('key_not_separate', `${VRF_KEY_ENV} must not be the same key as ${name}`);
  }
  return key;
}

export function requireVrfKey(env: Env = process.env): VrfKey {
  const k = loadVrfKey(env);
  if (!k) throw new VrfError('key_missing', `${VRF_KEY_ENV} is not set`);
  return k;
}

/** For the keygen script: a fresh random key and the env value to store (JSON array of the 64 keypair bytes). Print only `key.publicKey`. */
export function generateVrfKey(): { key: VrfKey; envValue: string } {
  const kp = Keypair.generate();
  return { key: new VrfKey(kp.secretKey.slice(0, 32)), envValue: JSON.stringify(Array.from(kp.secretKey)) };
}
