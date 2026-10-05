/**
 * Server keys, loaded once from env. Values never appear in an error message or a log line, and the module refuses to run in a browser bundle.
 * Formats accepted: a JSON array of 64 numbers (solana-keygen) or the base58 secret key, with or without wrapping quotes and surrounding whitespace.
 * A missing or unreadable key is ChainError('paused'): the route answers 503 "payments are paused" and names neither the variable nor the value.
 *  - SETTLEMENT_AUTHORITY_SECRET_KEY: fee payer and ATA-rent payer, the third signer. Holds NO authority over any buyer or seller asset.
 *  - HOUSE_SELLER_SECRET_KEY: owns the devnet house inventory (platform test assets); the server signs that seller leg.
 *  - FAUCET_MINT_AUTHORITY_SECRET_KEY: mints test USDC on devnet.
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ChainError, ConfigError } from './errors';

export type KeyName = 'SETTLEMENT_AUTHORITY_SECRET_KEY' | 'HOUSE_SELLER_SECRET_KEY' | 'FAUCET_MINT_AUTHORITY_SECRET_KEY';

export function parseSecretKey(name: string, raw: string): Keypair {
  try {
    const v = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim(); // a pasted value often arrives wrapped in quotes
    const bytes = v.startsWith('[') ? Uint8Array.from(JSON.parse(v) as number[]) : bs58.decode(v);
    if (bytes.length !== 64) throw new Error('length');
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new ConfigError(`${name} is not a valid secret key (JSON byte array or base58)`);
  }
}

const cache = new Map<string, Keypair>();

function load(name: KeyName, env: Record<string, string | undefined>): Keypair | null {
  if (typeof window !== 'undefined') throw new ConfigError('server keys cannot be loaded in a browser bundle');
  const hit = cache.get(name);
  if (hit) return hit;
  const raw = env[name];
  if (!raw?.trim()) return null;
  let kp: Keypair;
  try {
    kp = parseSecretKey(name, raw);
  } catch {
    console.error(`${name} is set but unreadable`); // the name only, never the value
    throw new ChainError('paused', 'Payments are paused: the server key is not usable. Try again later.');
  }
  cache.set(name, kp);
  return kp;
}

const required = (name: KeyName, env: Record<string, string | undefined>): Keypair => {
  const kp = load(name, env);
  if (!kp) {
    console.error(`${name} is not set`);
    throw new ChainError('paused', 'Payments are paused: the server is not set up for settlement yet.');
  }
  return kp;
};

export const settlementAuthority = (env: Record<string, string | undefined> = process.env): Keypair => required('SETTLEMENT_AUTHORITY_SECRET_KEY', env);
export const faucetMintAuthority = (env: Record<string, string | undefined> = process.env): Keypair => required('FAUCET_MINT_AUTHORITY_SECRET_KEY', env);
/** null when not configured (production mainnet has no house seller). */
export const houseSeller = (env: Record<string, string | undefined> = process.env): Keypair | null => load('HOUSE_SELLER_SECRET_KEY', env);
/** Tests only. */
export const clearKeyCache = (): void => cache.clear();
