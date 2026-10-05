/**
 * The devnet scripts' logic on LiteSVM (real Core program) and embedded Postgres: idempotent bootstrap, the funding stop,
 * replica minting, and the smoke settlement. The real devnet run is a human step (SA needs devnet SOL); this proves the
 * instruction sets and the flow offline so the first real run is not the first run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { deserializeCollectionV1 } from '@metaplex-foundation/mpl-core';
import { publicKey as umiPk } from '@metaplex-foundation/umi';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { decodeAssetAccount, evaluateAssetReadiness } from '@/lib/chain/asset';
import { normalizeTraits } from '@/lib/chain/devnet-cards';
import { ataAddress } from '@/lib/chain/ix';
import { createSvmPort } from '@/lib/chain/__tests__/svm-port';
import { createWorld, CORE_SO } from '@/lib/chain/__tests__/svm-world';
import cards from '@/lib/chain/__tests__/fixtures/cc-wallet-cards.json';
import {
  addressesFor, COST, derivedKeypair, ensureCollection, ensureUsdcMint, FundingError, fundingMessage, mintReplica, neededLamports, replicaAttributes, REPLICA_LABEL, requireFunds, runSmoke, type Io, type ReplicaSource, type RoleKeys,
} from '@/lib/chain/replica-mint';

function svmIo(svm: LiteSVM): Io {
  const acct = (pk: PublicKey) => svm.getAccount(pk.toBase58() as never) as { exists: boolean; data: Uint8Array; programAddress: string };
  return {
    getBalance: async (pk) => svm.getBalance(pk.toBase58() as never) ?? 0n,
    exists: async (pk) => acct(pk).exists,
    rentExempt: async (n) => svm.minimumBalanceForRentExemption(BigInt(n)),
    async send(ixs, payer, extra, label) {
      const tx = new Transaction(); tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = payer.publicKey; tx.add(...ixs); tx.sign(payer, ...extra);
      const r = svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()));
      if (r instanceof FailedTransactionMetadata) throw new Error(`${label} failed: ${r.toString()}`);
      return label;
    },
  };
}
const freshSvm = (saSol = 10_000_000_000n) => {
  const svm = new LiteSVM();
  svm.addProgramFromFile('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d' as never, CORE_SO);
  const keys: RoleKeys = { sa: Keypair.generate(), house: Keypair.generate(), faucet: Keypair.generate(), feeWallet: Keypair.generate().publicKey };
  if (saSol > 0n) svm.airdrop(keys.sa.publicKey.toBase58() as never, saSol as never);
  svm.airdrop(keys.faucet.publicKey.toBase58() as never, 1_000_000_000n as never);
  return { svm, keys, io: svmIo(svm) };
};
const source = (n: number): ReplicaSource => ({ replicaOf: `CCMint${n}`.padEnd(44, 'x'), name: `2021 #4 Charizard PSA 9 card number ${n} with a very long name that keeps going`, imageUrl: 'https://img.example/x.png', grade: 'GEM MINT 10', gradingCompany: 'CGC', gradingId: '123', vault: 'PWCC', set: 'Celebrations', category: 'Pokemon', insuredValueUsd: 42 });

describe('addresses', () => {
  it('are stable for one settlement authority, differ between authorities, and are not the SA key itself', () => {
    const { keys } = freshSvm(), other = freshSvm().keys;
    expect(addressesFor(keys.sa)).toEqual(addressesFor(keys.sa));
    expect(addressesFor(keys.sa).usdcMint.equals(addressesFor(other.sa).usdcMint)).toBe(false);
    expect(addressesFor(keys.sa).usdcMint.equals(addressesFor(keys.sa).collection)).toBe(false);
    expect(derivedKeypair(keys.sa, 'x').publicKey.equals(keys.sa.publicKey)).toBe(false);
  });
});

describe('funding stop', () => {
  it('SA with no SOL: stops with the exact public key and amounts, no faucet loop', async () => {
    const { keys, io } = freshSvm(0n);
    const need = await neededLamports(io, keys, { cards: 8 });
    const err = await requireFunds(io, keys.sa.publicKey, need).catch((e) => e);
    expect(err).toBeInstanceOf(FundingError);
    expect(err.message).toContain(keys.sa.publicKey.toBase58());
    expect(err.message).toMatch(/has 0\.000 devnet SOL/);
    expect(err.message).toMatch(/Send at least 1\.000 devnet SOL/);
    expect(err.message).not.toMatch(/secret/i);
  });
  it('asks for more than 1 SOL only when the run needs more', () => {
    expect(fundingMessage(Keypair.generate().publicKey, 0n, 2_500_000_000n)).toMatch(/Send at least 2\.500 devnet SOL/);
  });
  it('enough SOL passes silently', async () => {
    const { keys, io } = freshSvm();
    await expect(requireFunds(io, keys.sa.publicKey, await neededLamports(io, keys, { cards: 8 }))).resolves.toBeUndefined();
  });
});

describe('bootstrap steps on the real Core program', () => {
  it('creates the test USDC mint once (6 decimals, authority = faucet, no freeze) and is idempotent', async () => {
    const { svm, keys, io } = freshSvm();
    const first = await ensureUsdcMint(io, keys), second = await ensureUsdcMint(io, keys);
    expect([first.created, second.created]).toEqual([true, false]);
    expect(first.mint.equals(second.mint)).toBe(true);
    const d = (svm.getAccount(first.mint.toBase58() as never) as { data: Uint8Array }).data;
    expect(d.length).toBe(82);
    expect(new PublicKey(d.subarray(4, 36)).equals(keys.faucet.publicKey)).toBe(true); // mint authority
    expect(d[44]).toBe(6); // decimals
    expect(Buffer.from(d.subarray(46, 50)).readUInt32LE(0)).toBe(0); // no freeze authority
  });
  it('creates the vault collection: royalties ruleSet None, and NO platform authority over assets', async () => {
    const { svm, keys, io } = freshSvm();
    const a = await ensureCollection(io, keys), b = await ensureCollection(io, keys);
    expect([a.created, b.created]).toEqual([true, false]);
    const acc = svm.getAccount(a.collection.toBase58() as never) as { data: Uint8Array; programAddress: string };
    const c = deserializeCollectionV1({ publicKey: umiPk(a.collection.toBase58()), owner: umiPk(acc.programAddress), lamports: { basisPoints: 1n, identifier: 'SOL', decimals: 9 }, data: acc.data, executable: false, rentEpoch: 0n, header: { executable: false, owner: umiPk(acc.programAddress), lamports: { basisPoints: 1n, identifier: 'SOL', decimals: 9 }, rentEpoch: 0n } } as never) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(c.name).toBe('Hammerprice Devnet Vault');
    expect(c.royalties.basisPoints).toBe(200);
    expect(c.royalties.creators[0].address).toBe(keys.feeWallet.toBase58());
    expect((c.royalties.ruleSet.type ?? c.royalties.ruleSet.__kind)).toBe('None');
    for (const p of ['permanentTransferDelegate', 'permanentBurnDelegate', 'permanentFreezeDelegate', 'transferDelegate', 'freezeDelegate']) expect(c[p], p).toBeUndefined();
  });
  it('mints a labelled replica owned by the house seller, in the collection, eligible for the house as seller', async () => {
    const { svm, keys, io } = freshSvm();
    const { collection } = await ensureCollection(io, keys);
    const r = await mintReplica(io, keys, collection, source(1));
    expect(r.name.endsWith('(devnet replica)')).toBe(true);
    expect(r.name.length).toBeLessThanOrEqual(64);
    expect(r.attributes).toMatchObject({ label: REPLICA_LABEL, replica: 'true', replica_of: source(1).replicaOf, grade: 'GEM MINT 10', grading_company: 'CGC', vault: 'PWCC', insured_value_usd: '42' });
    const get = (pk: PublicKey) => { const a = svm.getAccount(pk.toBase58() as never) as { data: Uint8Array; programAddress: string }; return { owner: String(a.programAddress), lamports: 1, data: a.data }; };
    const info = decodeAssetAccount(r.mint.toBase58(), get(r.mint), get(collection));
    expect(info).toMatchObject({ standard: 'core', owner: keys.house.publicKey.toBase58(), collection: collection.toBase58(), royaltyBlocksOwnerTransfer: false, frozen: false });
    expect(evaluateAssetReadiness(info, { seller: keys.house.publicKey.toBase58() }).eligible).toBe(true);
    const onChain = Buffer.from(get(r.mint).data); // the on-chain Attributes plugin carries the same trait names as the /sell test card (Title Case), not the snake_case keys
    expect(onChain.includes('Grading Company')).toBe(true);
    expect(onChain.includes('grading_company')).toBe(false);
  });
  it('replicaAttributes drops missing fields instead of writing "null"', () => {
    const a = replicaAttributes({ ...source(2), grade: null, vault: null, insuredValueUsd: null });
    expect(Object.keys(a)).not.toContain('grade');
    expect(Object.values(a)).not.toContain('null');
  });
  it('the cost estimate covers what bootstrap plus 3 cards actually spend', async () => {
    const { svm, keys, io } = freshSvm();
    const need = await neededLamports(io, keys, { cards: 3 });
    const before = svm.getBalance(keys.sa.publicKey.toBase58() as never)!;
    await ensureUsdcMint(io, keys);
    const { collection } = await ensureCollection(io, keys);
    for (let i = 0; i < 3; i++) await mintReplica(io, keys, collection, source(i));
    const spent = before - svm.getBalance(keys.sa.publicKey.toBase58() as never)!;
    expect(spent).toBeLessThan(need);
    expect(need - spent).toBeLessThan(COST.cushion + 3n * COST.card); // and the estimate is not absurdly high either
    expect(await neededLamports(io, keys, { cards: 0 })).toBe(COST.cushion); // everything exists: only the cushion remains
  });
});

describe('the smoke settlement (production modules, LiteSVM instead of devnet)', () => {
  it('funds a 0-SOL buyer with test USDC, settles a house card with one buyer signature, and verifies it from the chain', async () => {
    const w = createWorld();
    const k: RoleKeys = { sa: w.sa, house: w.houseSeller, faucet: w.mintAuth, feeWallet: w.feeWallet.publicKey };
    const buyer = Keypair.generate();
    const port = createSvmPort(w, () => [buyer.publicKey.toBase58()]), io = svmIo(w.svm);
    const asset = w.consign('House smoke card', w.houseSeller);
    const r = await runSmoke(io, port, k, buyer, { asset, collection: w.collection, usdcMint: w.usdc, grossUsdc: 12 });
    expect(r).toMatchObject({ verified: true, gross: '12000000', ownerAfter: buyer.publicKey.toBase58() });
    expect(r.explorerUrl).toBe(`https://explorer.solana.com/tx/${r.signature}?cluster=devnet`);
    expect(w.ownerOf(asset)).toBe(buyer.publicKey.toBase58());
    expect(w.usdcOf(w.houseSeller)).toBe(11_700_000n);
    expect(w.usdcOf(w.feeWallet)).toBe(300_000n);
    expect(w.usdcOf(buyer.publicKey)).toBe(12_000_000n); // minted 24, paid 12
    expect(w.sol(buyer)).toBe(0n);
    expect(ataAddress(w.usdc, buyer.publicKey).toBase58()).toBeTruthy();
  });
});

describe('mint-house-inventory with embedded Postgres and a stubbed catalogue', () => {
  let t: TestPg | undefined, skip: string | undefined;
  beforeAll(async () => {
    const r = await startTestPg({ poolMax: 4 });
    if ('skip' in r) { skip = r.skip; return; }
    t = r.pg;
    process.env.DATABASE_URL = t.url;
  }, 120_000);
  afterAll(async () => { await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => undefined); await t?.stop(); });
  afterEach(() => vi.unstubAllGlobals());

  it('copies real-shaped vault cards, records them in devnet_assets, and a second run mints nothing new', async (ctx) => {
    if (!t) return ctx.skip(skip);
    const { svm, keys, io } = freshSvm();
    await ensureCollection(io, keys);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ filterNFtCard: cards.filterNFtCard.map((c) => ({ ...c, itemName: c.itemName })), nextCursor: null, total: 9 }) }) as Response));
    const { mintHouseInventory } = await import('../mint-house-inventory');
    const logs: string[] = [];
    const n = await mintHouseInventory(io, keys, 3, (s) => logs.push(s));
    expect(n).toBe(3);
    const { db, devnetAssets } = await import('@/db');
    const rows = await db.select().from(devnetAssets);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.ownerWallet).toBe(keys.house.publicKey.toBase58());
      const traits = normalizeTraits(r.attributes); // stored as a Metaplex trait list: ENGINE and the metadata route read it
      expect(Array.isArray(r.attributes)).toBe(true);
      expect(traits.find((t) => t.trait_type === 'Replica of')?.value).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // the REAL CC mint
      expect(traits.find((t) => t.trait_type === 'Label')?.value).toBe(REPLICA_LABEL);
      expect(traits.find((t) => t.trait_type === 'Grade')?.value).toBeTruthy();
      expect(r.name).toMatch(/\(devnet replica\)$/);
      expect(r.imageUrl).toMatch(/^https:\/\//);
      expect((svm.getAccount(r.mint as never) as { exists: boolean }).exists).toBe(true);
    }
    expect(await mintHouseInventory(io, keys, 3, () => undefined)).toBe(0);
    expect((await db.select().from(devnetAssets)).length).toBe(3);
    expect(logs.join('\n')).not.toMatch(/secret/i);
  }, 60_000);
});
