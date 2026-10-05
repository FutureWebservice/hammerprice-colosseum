import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createSignerFromKeypair, publicKey as umiPk } from '@metaplex-foundation/umi';
import { create, createCollection, CheckResult, ruleSet } from '@metaplex-foundation/mpl-core';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';
import type { AssetInfo } from '@/contracts';
import { AssetReadiness } from '@/contracts';
import raw from './fixtures/cc-assets-raw.json';
import { decodeAssetAccount, evaluateAssetReadiness, normalizeStandard, readAsset } from '../asset';
import type { RawAccount, RpcCall } from '../rpc';
import { createWorld, type World } from './svm-world';

const fixture = (r: (typeof raw)[number]): RawAccount => ({ owner: (r as { acctOwnerProgram: string }).acctOwnerProgram, lamports: 1, data: new Uint8Array(Buffer.from((r as { b64: string }).b64, 'base64')) });
const CC_COLLECTION = 'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac';

describe('real Collector Crypt accounts (mainnet bytes, 2026-09-30)', () => {
  const core = raw.filter((r) => r.std === 'core');
  it('has fixtures for each standard', () => {
    expect(core.length).toBe(4);
    expect(raw.filter((r) => r.std === 'pnft').length).toBeGreaterThan(0);
    expect(raw.filter((r) => r.std === 'cnft-v2').length).toBe(1);
  });
  for (const r of core) {
    it(`decodes Core asset ${r.nft.slice(0, 6)}: owner is the API owner, in the CC collection, nothing blocks a plain transfer`, () => {
      const info = decodeAssetAccount(r.nft, fixture(r))!;
      expect(info.standard).toBe('core');
      expect(info.owner).toBe(r.apiOwner);
      expect(info.collection).toBe(CC_COLLECTION);
      expect(info).toMatchObject({ frozen: false, burnt: false, compressed: false, royaltyBlocksOwnerTransfer: false, blockingDelegate: null });
      expect(evaluateAssetReadiness(info, { seller: r.apiOwner })).toEqual({ eligible: true, reasons: [] });
      expect(evaluateAssetReadiness(info, { seller: Keypair.generate().publicKey.toBase58() })).toEqual({ eligible: false, reasons: ['not_owner'] });
    });
  }
  it('a listed asset (foreign TransferDelegate, the CC listing PDA) stays eligible: an owner transfer still works', () => {
    const listed = core.find((r) => r.nft.startsWith('22eCoC'))!;
    expect(evaluateAssetReadiness(decodeAssetAccount(listed.nft, fixture(listed)), { seller: listed.apiOwner }).eligible).toBe(true);
  });
  it('pNFT mints are rejected as unsupported_standard', () => {
    for (const r of raw.filter((x) => x.std === 'pnft')) {
      const info = decodeAssetAccount(r.nft, fixture(r));
      expect(evaluateAssetReadiness(info, { seller: r.apiOwner })).toEqual({ eligible: false, reasons: ['unsupported_standard'] });
    }
  });
  it('a compressed NFT (no account at all) is not_found; its vault label is unsupported_standard', () => {
    expect(evaluateAssetReadiness(decodeAssetAccount('6RtRPbATDhjn3XSmXpqPoDCYKfEbMcny4GPgZydiYtKi', null), { seller: 'x' })).toEqual({ eligible: false, reasons: ['not_found'] });
    const cnft: AssetInfo = { mint: 'm', standard: normalizeStandard('cnft-v2'), owner: 'x', collection: null, name: '', imageUrl: null, frozen: false, compressed: true, burnt: false, royaltyBlocksOwnerTransfer: false, blockingDelegate: null };
    expect(evaluateAssetReadiness(cnft, { seller: 'x' }).reasons).toEqual(['unsupported_standard']);
    expect(normalizeStandard('ERC721')).toBe('unknown');
    expect(evaluateAssetReadiness({ ...cnft, standard: 'unknown', compressed: false }, { seller: 'x' }).reasons).toEqual(['unsupported_standard']);
  });
  it('readAsset reads the asset account, then the collection account, through the RPC layer', async () => {
    const r = core[0]!;
    const seen: string[] = [];
    const call: RpcCall = (async (method: string, params: unknown[]) => {
      seen.push(`${method}:${String(params[0]).slice(0, 6)}`);
      const addr = params[0] as string;
      const acc = addr === r.nft ? fixture(r) : null;
      return { value: acc ? { owner: acc.owner, lamports: 1, data: [Buffer.from(acc.data).toString('base64'), 'base64'] } : null };
    }) as RpcCall;
    const info = await readAsset(r.nft, 'devnet', call);
    expect(info?.owner).toBe(r.apiOwner);
    expect(seen).toEqual([`getAccountInfo:${r.nft.slice(0, 6)}`, 'getAccountInfo:CCrypt']);
    expect(await readAsset('not a key', 'devnet', call)).toBeNull();
  });
});

describe('plugins on the real Core program', () => {
  let w: World;
  beforeAll(() => { w = createWorld(); });
  const acct = (addr: string): RawAccount => { const a = w.svm.getAccount(addr as never) as { programAddress: string; data: Uint8Array }; return { owner: String(a.programAddress), lamports: 1, data: a.data }; };
  const U = (k: Keypair) => umiPk(k.publicKey.toBase58());
  function mint(plugins: unknown[] = [], adapters: Record<string, unknown> = {}, collection?: { kp: Keypair }) {
    const asset = Keypair.generate(), u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(create(u, { asset: createSignerFromKeypair(u, fromWeb3JsKeypair(asset)), name: 'Plugin card', uri: 'https://example.com/a.json', owner: U(w.seller), collection: { publicKey: collection ? U(collection.kp) : umiPk(w.collection.toBase58()) } as never, plugins: plugins as never, ...adapters } as never) as never), w.sa, [asset]);
    return asset.publicKey.toBase58();
  }
  const readiness = (addr: string) => { const a = acct(addr); const info = decodeAssetAccount(addr, a, info0(addr, a)); return { info, r: evaluateAssetReadiness(info, { seller: w.seller.publicKey.toBase58() }) }; };
  const info0 = (addr: string, a: RawAccount) => { const first = decodeAssetAccount(addr, a); return first?.collection ? acct(first.collection) : null; };

  it('a plain replica (collection, no plugins) is eligible and owned by the seller', () => {
    const { info, r } = readiness(mint());
    expect(info).toMatchObject({ standard: 'core', owner: w.seller.publicKey.toBase58(), collection: w.collection.toBase58(), name: 'Plugin card' });
    expect(AssetReadiness.parse(r).eligible).toBe(true);
  });
  it('a foreign TransferDelegate does not block an owner transfer', () => {
    expect(readiness(mint([{ type: 'TransferDelegate', authority: { type: 'Address', address: U(w.attacker) } }])).r.eligible).toBe(true);
  });
  it('a frozen asset is refused', () => {
    expect(readiness(mint([{ type: 'FreezeDelegate', frozen: true }])).r).toEqual({ eligible: false, reasons: ['frozen'] });
    expect(readiness(mint([{ type: 'PermanentFreezeDelegate', frozen: true }])).r.reasons).toEqual(['frozen']);
  });
  it('an unfrozen freeze delegate is fine', () => {
    expect(readiness(mint([{ type: 'FreezeDelegate', frozen: false }])).r.eligible).toBe(true);
  });
  it('a royalty rule set other than None is refused; None (the Collector Crypt shape) is fine', () => {
    const creators = [{ address: U(w.seller), percentage: 100 }];
    expect(readiness(mint([{ type: 'Royalties', basisPoints: 200, creators, ruleSet: ruleSet('None') }])).r.eligible).toBe(true);
    expect(readiness(mint([{ type: 'Royalties', basisPoints: 200, creators, ruleSet: ruleSet('ProgramAllowList', [[umiPk('11111111111111111111111111111111')]]) }])).r.reasons).toEqual(['royalty_rules_block_transfer']);
    expect(readiness(mint([{ type: 'Royalties', basisPoints: 200, creators, ruleSet: ruleSet('ProgramDenyList', [[umiPk('11111111111111111111111111111111')]]) }])).r.reasons).toEqual(['royalty_rules_block_transfer']);
  });
  it('an oracle that can reject transfers makes the outcome depend on a third party: refused', () => {
    const addr = mint([{ type: 'Oracle', resultsOffset: { type: 'Anchor' }, baseAddress: U(w.attacker), lifecycleChecks: { transfer: [CheckResult.CAN_REJECT] } }]);
    const { info, r } = readiness(addr);
    expect(info?.blockingDelegate).toBe(w.attacker.publicKey.toBase58());
    expect(r.reasons).toEqual(['foreign_delegate_blocks']);
  });
  it('collection-level plugins count: a frozen permanent freeze on the collection freezes every asset in it', () => {
    const coll = Keypair.generate(), u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(createCollection(u, { collection: createSignerFromKeypair(u, fromWeb3JsKeypair(coll)), name: 'Frozen collection', uri: 'https://example.com/c.json', plugins: [{ type: 'PermanentFreezeDelegate', frozen: true }] } as never) as never), w.sa, [coll]);
    expect(readiness(mint([], {}, { kp: coll })).r.reasons).toEqual(['frozen']);
  });
  it('an asset owned by someone else is not_owner; a burnt (uninitialised) Core account is not_found', () => {
    const addr = mint();
    const info = decodeAssetAccount(addr, acct(addr))!;
    expect(evaluateAssetReadiness(info, { seller: w.buyer.publicKey.toBase58() }).reasons).toEqual(['not_owner']);
    const burnt = decodeAssetAccount(addr, { ...acct(addr), data: new Uint8Array([0]) })!;
    expect(burnt.burnt).toBe(true);
    expect(evaluateAssetReadiness(burnt, { seller: w.seller.publicKey.toBase58() }).reasons).toEqual(['not_found']);
    expect(evaluateAssetReadiness(null, { seller: 'x' }).reasons).toEqual(['not_found']);
  });
  it('several problems are all reported, in a stable order', () => {
    const { r } = readiness(mint([{ type: 'FreezeDelegate', frozen: true }, { type: 'Royalties', basisPoints: 100, creators: [{ address: U(w.seller), percentage: 100 }], ruleSet: ruleSet('ProgramAllowList', [[umiPk('11111111111111111111111111111111')]]) }]));
    expect(r.reasons).toEqual(['frozen', 'royalty_rules_block_transfer']);
  });
});
