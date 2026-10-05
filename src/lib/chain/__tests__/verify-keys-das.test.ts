import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ApiError, AssetInfo, ExpectedSettlement } from '@/contracts';
import fixture from '@/contracts/fixtures/expected-settlement.json';
import { dasItemToAssetInfo } from '../das';
import { ConfigError } from '../errors';
import { clearKeyCache, houseSeller, parseSecretKey, settlementAuthority } from '../keys';
import { verifySettled, type ParsedTx } from '../verify-settled';

const e = ExpectedSettlement.parse(fixture);
const tb = (owner: string, amount: bigint, mint = e.usdcMint, i = 1) => ({ accountIndex: i, mint, owner, uiTokenAmount: { amount: amount.toString(), decimals: 6 } });
/** A getTransaction(jsonParsed) result in the RPC's shape. */
const tx = (o: Partial<{ err: unknown; post: ReturnType<typeof tb>[]; pre: ReturnType<typeof tb>[]; memo: string | null }> = {}): ParsedTx => ({
  slot: 1,
  meta: {
    err: o.err ?? null,
    preTokenBalances: o.pre ?? [tb(e.buyer, 500_000_000n, e.usdcMint, 1), tb(e.seller, 10_000_000n, e.usdcMint, 2)],
    postTokenBalances: o.post ?? [tb(e.buyer, 380_000_000n, e.usdcMint, 1), tb(e.seller, 127_000_000n, e.usdcMint, 2), tb(e.feeWallet, 3_000_000n, e.usdcMint, 3)],
  },
  transaction: { message: { instructions: [{ program: 'spl-token' }, ...(o.memo === null ? [] : [{ program: 'spl-memo', parsed: o.memo ?? e.memo }])] } },
});

describe('verifySettled', () => {
  it('accepts a transaction with the expected deltas, memo and owner', () => {
    expect(verifySettled(tx(), e, e.buyer)).toEqual({ ok: true });
  });
  it('a failed transaction is not settled', () => {
    expect(verifySettled(tx({ err: { InstructionError: [4, { Custom: 1 }] } }), e, e.buyer)).toMatchObject({ ok: false, code: 'tx_failed' });
    expect(verifySettled(null, e, e.buyer)).toMatchObject({ ok: false, code: 'tx_failed' });
    expect(verifySettled({ ...tx(), meta: null }, e, e.buyer)).toMatchObject({ ok: false, code: 'tx_failed' });
  });
  it('wrong deltas: short to the seller, fee not paid, buyer paid too much, money to a stranger', () => {
    const base = (seller: bigint, fee: bigint, buyer = 380_000_000n) => [tb(e.buyer, buyer), tb(e.seller, seller), tb(e.feeWallet, fee)];
    expect(verifySettled(tx({ post: base(126_999_999n, 3_000_000n) }), e, e.buyer)).toMatchObject({ code: 'delta_mismatch' });
    expect(verifySettled(tx({ post: base(127_000_000n, 0n) }), e, e.buyer)).toMatchObject({ code: 'delta_mismatch' });
    expect(verifySettled(tx({ post: base(127_000_000n, 3_000_000n, 379_000_000n) }), e, e.buyer)).toMatchObject({ code: 'delta_mismatch' });
    const stranger = Keypair.generate().publicKey.toBase58();
    expect(verifySettled(tx({ post: [...base(127_000_000n, 3_000_000n), tb(stranger, 1n, e.usdcMint, 4)] }), e, e.buyer)).toMatchObject({ code: 'delta_mismatch' });
  });
  it('balances of another mint do not count as the payment', () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r = verifySettled(tx({ post: [tb(e.buyer, 380_000_000n, other), tb(e.seller, 127_000_000n, other), tb(e.feeWallet, 3_000_000n, other)], pre: [tb(e.buyer, 500_000_000n, other), tb(e.seller, 10_000_000n, other)] }), e, e.buyer);
    expect(r).toMatchObject({ ok: false, code: 'delta_mismatch' });
  });
  it('a wrong asset owner is not settled', () => {
    expect(verifySettled(tx(), e, e.seller)).toMatchObject({ code: 'owner_mismatch' });
    expect(verifySettled(tx(), e, null)).toMatchObject({ code: 'owner_mismatch' });
  });
  it('the memo must be present exactly once and equal', () => {
    expect(verifySettled(tx({ memo: null }), e, e.buyer)).toMatchObject({ code: 'memo_mismatch' });
    expect(verifySettled(tx({ memo: 'hp:settle:other' }), e, e.buyer)).toMatchObject({ code: 'memo_mismatch' });
  });
  it('checks the royalty leg when there is one', () => {
    const r = ExpectedSettlement.parse({ ...e, royalty: '6000000', royaltyRecipient: Keypair.generate().publicKey.toBase58() });
    const post = [tb(r.buyer, 380_000_000n), tb(r.seller, 121_000_000n), tb(r.feeWallet, 3_000_000n), tb(r.royaltyRecipient!, 6_000_000n)];
    expect(verifySettled(tx({ post }), r, r.buyer)).toEqual({ ok: true });
    expect(verifySettled(tx({ post: post.slice(0, 3) }), r, r.buyer)).toMatchObject({ code: 'delta_mismatch' });
  });
});

describe('keys', () => {
  afterEach(() => clearKeyCache());
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());
  const kp = Keypair.generate();
  it('reads a JSON byte array and a base58 secret key to the same keypair', () => {
    expect(parseSecretKey('K', JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey)).toBe(true);
    expect(parseSecretKey('K', bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('a bad key is a ConfigError that never contains the value', () => {
    for (const bad of ['[1,2,3]', 'nonsense', bs58.encode(new Uint8Array(32)), '{"a":1}']) {
      expect(() => parseSecretKey('K', bad)).toThrow(ConfigError);
      try { parseSecretKey('K', bad); } catch (err) { expect(String(err)).not.toContain(bad); }
    }
  });
  it('the settlement authority is required, the house seller optional', () => {
    expect(() => settlementAuthority({})).toThrow(expect.objectContaining({ code: 'paused' }));
    expect(houseSeller({})).toBeNull();
    expect(houseSeller({ HOUSE_SELLER_SECRET_KEY: '  ' })).toBeNull();
    expect(settlementAuthority({ SETTLEMENT_AUTHORITY_SECRET_KEY: bs58.encode(kp.secretKey) }).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it('a missing or unusable server key is a paused ApiError that names neither the variable nor the value', () => {
    const spy = vi.mocked(console.error);
    const junk = 'not-a-key-at-all-' + bs58.encode(new Uint8Array(8));
    for (const env of [{}, { SETTLEMENT_AUTHORITY_SECRET_KEY: junk }]) {
      try { settlementAuthority(env); throw new Error('should have thrown'); } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err).toMatchObject({ code: 'paused', status: 503 });
        expect(String(err)).not.toMatch(/SECRET_KEY|not-a-key/);
      }
    }
    expect(spy.mock.calls.flat().join(' ')).not.toContain(junk); // logs name the variable, never the value
  });
  it('accepts the formats Vercel env will hold: wrapped quotes, padding, a JSON array with spaces', () => {
    const arr = JSON.stringify(Array.from(kp.secretKey));
    for (const v of [`"${bs58.encode(kp.secretKey)}"`, `  ${bs58.encode(kp.secretKey)}\n`, `'${arr}'`, arr.replace(/,/g, ', ')]) {
      expect(parseSecretKey('K', v).publicKey.equals(kp.publicKey)).toBe(true);
    }
  });
  it('refuses to load in a browser bundle', () => {
    (globalThis as { window?: unknown }).window = {};
    try { expect(() => settlementAuthority({ SETTLEMENT_AUTHORITY_SECRET_KEY: bs58.encode(kp.secretKey) })).toThrow(/browser/); } finally { delete (globalThis as { window?: unknown }).window; }
  });
});

describe('DAS mapping (documented item shape; no live DAS sample was available)', () => {
  const core = { id: Keypair.generate().publicKey.toBase58(), interface: 'MplCoreAsset', ownership: { owner: e.seller, frozen: false }, burnt: false, compression: { compressed: false }, grouping: [{ group_key: 'collection', group_value: e.collection }], content: { metadata: { name: 'Charizard' }, links: { image: 'https://img/x.png' } }, plugins: { royalties: { data: { basis_points: 200, rule_set: 'None' } } } };
  it('maps a Core asset and validates against the AssetInfo contract', () => {
    const a = dasItemToAssetInfo(core)!;
    expect(AssetInfo.parse(a)).toEqual(a);
    expect(a).toMatchObject({ standard: 'core', owner: e.seller, collection: e.collection, name: 'Charizard', imageUrl: 'https://img/x.png', frozen: false, royaltyBlocksOwnerTransfer: false, blockingDelegate: null });
  });
  it('maps standards, frozen, compressed and royalty rule sets', () => {
    expect(dasItemToAssetInfo({ ...core, interface: 'ProgrammableNFT' })!.standard).toBe('pnft');
    expect(dasItemToAssetInfo({ ...core, interface: 'V1_NFT' })!.standard).toBe('nft');
    expect(dasItemToAssetInfo({ ...core, interface: 'V2_NFT', compression: { compressed: true } })).toMatchObject({ standard: 'cnft', compressed: true });
    expect(dasItemToAssetInfo({ ...core, ownership: { owner: e.seller, frozen: true } })!.frozen).toBe(true);
    expect(dasItemToAssetInfo({ ...core, plugins: { permanent_freeze_delegate: { data: { frozen: true } } } })!.frozen).toBe(true);
    expect(dasItemToAssetInfo({ ...core, plugins: { royalties: { data: { rule_set: { ProgramAllowList: [['x']] } } } } })!.royaltyBlocksOwnerTransfer).toBe(true);
    expect(dasItemToAssetInfo({ ...core, burnt: true })!.burnt).toBe(true);
    expect(dasItemToAssetInfo({ ...core, interface: 'Custom' })!.standard).toBe('unknown');
  });
  it('an item without an id is dropped', () => expect(dasItemToAssetInfo({})).toBeNull());
});
