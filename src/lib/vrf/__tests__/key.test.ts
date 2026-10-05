import { inspect } from 'node:util';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, describe, expect, it } from 'vitest';
import { toHex } from '../bytes';
import { generateVrfKey, loadVrfKey, parseVrfSeed, requireVrfKey, VrfKey } from '../key';
import { buildAlpha } from '../alpha';
import { vrfVerify } from '../prove';
import { REQUEST_ID, SEED, b58hash } from './testkit';
import { sha256Hex } from '../canonical';

const kp = Keypair.fromSeed(SEED);
const pub = kp.publicKey.toBase58();
const forms: Record<string, string> = {
  'json keypair': JSON.stringify(Array.from(kp.secretKey)),
  'base58 keypair': bs58.encode(kp.secretKey),
  'json seed': JSON.stringify(Array.from(SEED)),
  'hex seed': toHex(SEED),
  'base58 seed': bs58.encode(SEED),
  'quoted json': `"${JSON.stringify(Array.from(kp.secretKey))}"`,
  'padded': `  ${toHex(SEED)}\n`,
};

afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('VRF key from env', () => {
  it.each(Object.entries(forms))('accepts %s', (_n, raw) => {
    const k = loadVrfKey({ VRF_SECRET_KEY: raw })!;
    expect(k.publicKey).toBe(pub);
  });
  it('is null when unset or blank, and requireVrfKey says key_missing', () => {
    expect(loadVrfKey({})).toBeNull();
    expect(loadVrfKey({ VRF_SECRET_KEY: '  ' })).toBeNull();
    expect(() => requireVrfKey({})).toThrow(/VRF_SECRET_KEY is not set/);
  });
  it('rejects garbage without echoing it', () => {
    for (const raw of ['garbage-value-1234', '[1,2,3]', toHex(SEED).slice(2), JSON.stringify([...kp.secretKey.slice(0, 63)]), '{"a":1}']) {
      try { parseVrfSeed(raw); throw new Error('should have thrown'); } catch (e) {
        expect((e as Error).message).toMatch(/VRF_SECRET_KEY is not a valid key/);
        expect((e as Error).message).not.toContain(raw);
      }
    }
  });
  it('rejects a keypair whose public half does not match the seed', () => {
    const bytes = Uint8Array.from(kp.secretKey);
    bytes[40]! ^= 1;
    expect(() => parseVrfSeed(JSON.stringify(Array.from(bytes)))).toThrow(/not a valid key/);
  });
  it('must not be the same key as another role key (any accepted format)', () => {
    const other = JSON.stringify(Array.from(kp.secretKey));
    for (const name of ['SETTLEMENT_AUTHORITY_SECRET_KEY', 'HOUSE_SELLER_SECRET_KEY', 'FAUCET_MINT_AUTHORITY_SECRET_KEY']) {
      expect(() => loadVrfKey({ VRF_SECRET_KEY: toHex(SEED), [name]: other })).toThrow(new RegExp(`must not be the same key as ${name}`));
    }
    const distinct = Keypair.generate();
    expect(loadVrfKey({ VRF_SECRET_KEY: toHex(SEED), SETTLEMENT_AUTHORITY_SECRET_KEY: bs58.encode(distinct.secretKey), HOUSE_SELLER_SECRET_KEY: 'unreadable' })!.publicKey).toBe(pub);
  });
  it('refuses to load in a browser bundle', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(() => loadVrfKey({ VRF_SECRET_KEY: toHex(SEED) })).toThrow(/browser bundle/);
  });
  it('never shows the secret when logged or serialised', () => {
    const k = loadVrfKey({ VRF_SECRET_KEY: toHex(SEED) })!;
    const shown = [inspect(k, { depth: 5, showHidden: true }), JSON.stringify(k), String(k), `${k}`].join('|');
    for (const secret of [toHex(SEED), JSON.stringify(Array.from(kp.secretKey)), bs58.encode(SEED), bs58.encode(kp.secretKey)]) expect(shown).not.toContain(secret);
    expect(shown).toContain(pub);
    expect(Object.keys(k)).toEqual(['publicKey']);
  });
  it('proves canonical alphas that anyone can verify with the public key only', () => {
    const k = loadVrfKey({ VRF_SECRET_KEY: toHex(SEED) })!;
    const alpha = buildAlpha({ cluster: 'devnet', purpose: 'lot_order', subject: REQUEST_ID, paramsHash: sha256Hex('p'), beacon: { slot: 9, blockhash: b58hash('h') } });
    const { proofHex, outputHex } = k.prove(alpha);
    expect(vrfVerify(k.publicKey, alpha, proofHex)).toBe(outputHex);
    expect(() => k.prove('free text')).toThrow(/canonical/);
  });
  it('generateVrfKey makes a fresh key whose env value loads back to the same public key', () => {
    const a = generateVrfKey();
    expect(a.key).toBeInstanceOf(VrfKey);
    expect(loadVrfKey({ VRF_SECRET_KEY: a.envValue })!.publicKey).toBe(a.key.publicKey);
    expect(generateVrfKey().key.publicKey).not.toBe(a.key.publicKey);
  });
});
