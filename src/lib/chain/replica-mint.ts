/**
 * Devnet plumbing shared by the house restock (src/server/house/rollover.ts) and scripts/chain/devnet-bootstrap.ts and mint-house-inventory.ts.
 *
 * Everything that touches the chain goes through `Io`, so the same code runs against a real devnet RPC (the scripts and the restock) and
 * against LiteSVM with the real Core program (scripts/chain/__tests__). Secrets: keys are read from a local file and held in
 * memory; nothing in here prints or logs a secret key, only public keys.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { createSignerFromKeypair, publicKey as umiPk } from '@metaplex-foundation/umi';
import { create, createCollection, ruleSet } from '@metaplex-foundation/mpl-core';
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters';
import type { ExpectedSettlement } from '@/contracts';
import { settlementMemo } from '@/contracts';
import { derivedKeypair, toIxs, umiFor } from '@/lib/chain/devnet';
import { REPLICA_LABEL, normalizeTraits } from '@/lib/chain/devnet-cards';
import { ataAddress, createAtaIdempotentIx, initializeMint2Ix, mintToIx, MINT_SIZE, TOKEN_PROGRAM_ID } from '@/lib/chain/ix';
import { explorerTxUrl } from '@/lib/chain/explorer';
import type { ChainPort } from '@/lib/chain/port';
import { buildExpected, buildSettlementTx } from '@/lib/chain/settlement-build';
import { assembleSettlementTx, extractPartySignature, signAs } from '@/lib/chain/settlement-sign';
import { verifySettled } from '@/lib/chain/verify-settled';

// ---- keys -------------------------------------------------------------------------------------------------------------------

export const ROLE_NAMES = ['SETTLEMENT_AUTHORITY', 'HOUSE_SELLER', 'FAUCET_MINT_AUTHORITY', 'PLATFORM_FEE_WALLET'] as const;
export interface RoleKeys { sa: Keypair; house: Keypair; faucet: Keypair; feeWallet: PublicKey }

export const keysFilePath = (env: Record<string, string | undefined> = process.env) => env.HP_KEYS_FILE ?? path.join(os.homedir(), '.hammerprice', 'devnet-keys.json');

/** Reads the role keys. Validates that each public key matches its secret. Returns keypairs only; never prints a secret. */
export function loadRoleKeys(file = keysFilePath()): RoleKeys {
  let j: Record<string, { publicKey: string; secretKey: number[] }>;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`cannot read the keys file at ${file} (set HP_KEYS_FILE to another path)`); }
  const kp = (name: string): Keypair => {
    const e = j[name];
    if (!e || !Array.isArray(e.secretKey)) throw new Error(`keys file has no ${name}`);
    const k = Keypair.fromSecretKey(Uint8Array.from(e.secretKey));
    if (k.publicKey.toBase58() !== e.publicKey) throw new Error(`keys file: ${name} public key does not match its secret`);
    return k;
  };
  return { sa: kp('SETTLEMENT_AUTHORITY'), house: kp('HOUSE_SELLER'), faucet: kp('FAUCET_MINT_AUTHORITY'), feeWallet: kp('PLATFORM_FEE_WALLET').publicKey };
}

export { derivedKeypair };

// ---- io ---------------------------------------------------------------------------------------------------------------------

export interface Io {
  getBalance(pk: PublicKey): Promise<bigint>;
  exists(pk: PublicKey): Promise<boolean>;
  rentExempt(dataLen: number): Promise<bigint>;
  /** Sends one transaction signed by `payer` (fee payer) and `extra`; returns the signature. Throws on failure. */
  send(ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[], label: string): Promise<string>;
}

export function devnetUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
  if (/mainnet/i.test(url)) throw new Error('refusing to run: the RPC URL looks like mainnet');
  return url;
}

export function connectionIo(conn: Connection): Io {
  return {
    getBalance: async (pk) => BigInt(await conn.getBalance(pk, 'confirmed')),
    exists: async (pk) => (await conn.getAccountInfo(pk, 'confirmed')) !== null,
    rentExempt: async (n) => BigInt(await conn.getMinimumBalanceForRentExemption(n)),
    async send(ixs, payer, extra, label) {
      const tx = new Transaction().add(...ixs);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash; tx.feePayer = payer.publicKey; tx.sign(payer, ...extra);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' });
      const r = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
      if (r.value.err) throw new Error(`${label} failed on chain: ${JSON.stringify(r.value.err)}`);
      return sig;
    },
  };
}

// ---- cost and funding -------------------------------------------------------------------------------------------------------

export const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Measured on LiteSVM with the real Core program, rounded up (see scripts/chain/__tests__). Lamports. */
export const COST = { signature: 5_000n, collection: 6_000_000n, card: 5_000_000n, ata: 2_100_000n, cushion: 5_000_000n } as const;

export function fundingMessage(sa: PublicKey, haveLamports: bigint, needLamports: bigint): string {
  const sol = (l: bigint) => (Number(l) / 1e9).toFixed(3);
  const ask = needLamports > LAMPORTS_PER_SOL ? needLamports : LAMPORTS_PER_SOL;
  return [
    `STOP: the settlement authority has ${sol(haveLamports)} devnet SOL and this run needs about ${sol(needLamports)} SOL.`,
    `Send at least ${sol(ask)} devnet SOL to this public key (faucet.solana.com, choose devnet, or any devnet wallet):`,
    `  ${sa.toBase58()}`,
    `Then run the same command again. It is idempotent and picks up where it stopped.`,
  ].join('\n');
}

/** One airdrop attempt, never a loop: the public faucet rate-limits hard. Returns true when SOL arrived. */
export async function tryOneAirdrop(conn: Connection, to: PublicKey, sol = 1): Promise<boolean> {
  try {
    const sig = await conn.requestAirdrop(to, sol * 1_000_000_000);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    return true;
  } catch { return false; }
}

/** Stops with the exact funding message unless SA holds `need`. One airdrop attempt first when a connection is given. */
export async function requireFunds(io: Io, sa: PublicKey, need: bigint, conn?: Connection): Promise<void> {
  let have = await io.getBalance(sa);
  if (have >= need) return;
  if (conn && (await tryOneAirdrop(conn, sa))) have = await io.getBalance(sa);
  if (have < need) throw new FundingError(fundingMessage(sa, have, need));
}
export class FundingError extends Error {}

// ---- instruction builders (umi with no-op signers, converted to web3.js: src/lib/chain/devnet.ts) ----------------------------------

export const PUBLIC_URL = (env: Record<string, string | undefined> = process.env) => env.HP_PUBLIC_URL ?? env.NEXT_PUBLIC_SITE_URL ?? 'https://hammerprice-earn.vercel.app';

// ---- bootstrap steps ---------------------------------------------------------------------------------------------------------

export interface Addresses { usdcMint: PublicKey; collection: PublicKey }
export const addressesFor = (sa: Keypair): Addresses => ({ usdcMint: derivedKeypair(sa, 'test-usdc-mint').publicKey, collection: derivedKeypair(sa, 'vault-collection').publicKey });

/** The test USDC mint: 6 decimals, mint authority FAUCET_MINT_AUTHORITY, no freeze authority. Created once. */
export async function ensureUsdcMint(io: Io, k: RoleKeys): Promise<{ mint: PublicKey; created: boolean }> {
  const mintKp = derivedKeypair(k.sa, 'test-usdc-mint');
  if (await io.exists(mintKp.publicKey)) return { mint: mintKp.publicKey, created: false };
  await io.send([
    SystemProgram.createAccount({ fromPubkey: k.sa.publicKey, newAccountPubkey: mintKp.publicKey, lamports: Number(await io.rentExempt(MINT_SIZE)), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    initializeMint2Ix(mintKp.publicKey, 6, k.faucet.publicKey, null),
  ], k.sa, [mintKp], 'create test USDC mint');
  return { mint: mintKp.publicKey, created: true };
}

/**
 * The "Hammerprice Devnet Vault" Core collection, shaped like Collector Crypt's: Royalties 200 bps to the fee wallet with
 * ruleSet None (royalty not enforced on chain, any wallet or program may receive the card).
 * DELIBERATELY ABSENT: CC's PermanentTransferDelegate, PermanentBurnDelegate and PermanentFreezeDelegate. The platform must hold no
 * authority over any asset; SA is only the collection's update authority (metadata), which cannot move, freeze or burn a card.
 */
export async function ensureCollection(io: Io, k: RoleKeys, publicUrl = PUBLIC_URL()): Promise<{ collection: PublicKey; created: boolean }> {
  const coll = derivedKeypair(k.sa, 'vault-collection');
  if (await io.exists(coll.publicKey)) return { collection: coll.publicKey, created: false };
  const u = umiFor(k.sa.publicKey);
  await io.send(toIxs(createCollection(u, {
    collection: createSignerFromKeypair(u, fromWeb3JsKeypair(coll)), name: 'Hammerprice Devnet Vault', uri: `${publicUrl}/api/devnet/metadata/collection`,
    plugins: [{ type: 'Royalties', basisPoints: 200, creators: [{ address: umiPk(k.feeWallet.toBase58()), percentage: 100 }], ruleSet: ruleSet('None') }],
  }) as never), k.sa, [coll], 'create Core collection');
  return { collection: coll.publicKey, created: true };
}

export interface ReplicaSource {
  /** The real Collector Crypt asset this replica copies. */
  replicaOf: string;
  name: string;
  imageUrl: string | null;
  grade: string | null;
  gradingCompany: string | null;
  gradingId: string | null;
  vault: string | null;
  set: string | null;
  category: string | null;
  insuredValueUsd: number | null;
}

export { REPLICA_LABEL };

export function replicaAttributes(s: ReplicaSource): Record<string, string> {
  const a: Record<string, string> = { label: REPLICA_LABEL, replica: 'true', replica_of: s.replicaOf };
  for (const [k2, v] of Object.entries({ grade: s.grade, grading_company: s.gradingCompany, grading_id: s.gradingId, vault: s.vault, set: s.set, category: s.category, insured_value_usd: s.insuredValueUsd })) if (v !== null && v !== undefined) a[k2] = String(v);
  return a;
}

/** Mints ONE replica to HOUSE_SELLER (payer SA). The metadata URI points at our own route, so no storage account is needed. */
export async function mintReplica(io: Io, k: RoleKeys, collection: PublicKey, s: ReplicaSource, publicUrl = PUBLIC_URL()): Promise<{ mint: PublicKey; name: string; attributes: Record<string, string>; signature: string }> {
  const asset = Keypair.generate();
  const name = `${s.name.slice(0, 44)} (devnet replica)`;
  const attributes = replicaAttributes(s);
  const u = umiFor(k.sa.publicKey);
  const signature = await io.send(toIxs(create(u, {
    asset: createSignerFromKeypair(u, fromWeb3JsKeypair(asset)), name, uri: `${publicUrl}/api/devnet/metadata/${asset.publicKey.toBase58()}`, owner: umiPk(k.house.publicKey.toBase58()),
    collection: { publicKey: umiPk(collection.toBase58()) } as never, plugins: [{ type: 'Attributes', attributeList: normalizeTraits(attributes).map((t) => ({ key: t.trait_type, value: String(t.value) })) }], // the same trait names as the /sell test card (src/lib/chain/devnet.ts)
  }) as never), k.sa, [asset], 'mint house replica');
  return { mint: asset.publicKey, name, attributes, signature };
}

/** Lamports SA needs for the pieces still missing (existence is read from the chain, so a re-run asks for less). */
export async function neededLamports(io: Io, k: RoleKeys, opts: { cards: number; smoke?: boolean }): Promise<bigint> {
  const a = addressesFor(k.sa);
  let n = COST.cushion;
  if (!(await io.exists(a.usdcMint))) n += (await io.rentExempt(MINT_SIZE)) + 3n * COST.signature;
  if (!(await io.exists(a.collection))) n += COST.collection + 2n * COST.signature;
  n += BigInt(opts.cards) * COST.card;
  if (opts.smoke) n += 3n * COST.ata + COST.card + 10n * COST.signature;
  return n;
}

// ---- the smoke: one real settlement, buyer + house seller + SA ---------------------------------------------------------------

export interface SmokeResult { signature: string; explorerUrl: string; asset: string; gross: string; ownerAfter: string | null; verified: boolean }

/**
 * Settles one house card to `buyer` through the production modules: expected -> builder -> both parties sign the same message ->
 * SA last -> simulate -> send -> read the confirmed transaction back and verify deltas, memo and the new owner.
 * The buyer gets test USDC first (FAUCET_MINT_AUTHORITY mints, SA pays the account rent). No database involved.
 */
export async function runSmoke(io: Io, chain: ChainPort, k: RoleKeys, buyer: Keypair, o: { asset: PublicKey; collection: PublicKey; usdcMint: PublicKey; grossUsdc?: number; log?: (s: string) => void }): Promise<SmokeResult> {
  const log = o.log ?? (() => undefined);
  const gross = BigInt(Math.round((o.grossUsdc ?? 12) * 1_000_000)), fee = (gross * 250n) / 10_000n;
  const buyerAta = ataAddress(o.usdcMint, buyer.publicKey);
  const have = await chain.getUsdcBalance(buyer.publicKey.toBase58());
  if (have < gross) {
    await io.send([createAtaIdempotentIx(k.sa.publicKey, buyerAta, buyer.publicKey, o.usdcMint), mintToIx(o.usdcMint, buyerAta, k.faucet.publicKey, gross * 2n)], k.sa, [k.faucet], 'fund the test buyer with test USDC');
    log(`minted ${(Number(gross * 2n) / 1e6).toFixed(2)} test USDC to the buyer`);
  }
  const id = crypto.randomUUID(), bidLogHash = createHash('sha256').update(`smoke|${id}`).digest('hex');
  const expected: ExpectedSettlement = buildExpected({
    settlementId: id, cluster: 'devnet', buyer: buyer.publicKey.toBase58(), seller: k.house.publicKey.toBase58(), asset: o.asset.toBase58(), collection: o.collection.toBase58(),
    usdcMint: o.usdcMint.toBase58(), gross, platformFee: fee, royalty: 0n, royaltyRecipient: null, feeWallet: k.feeWallet.toBase58(), feePayer: k.sa.publicKey.toBase58(), bidLogHash,
  });
  if (expected.memo !== settlementMemo(id, bidLogHash)) throw new Error('memo mismatch');
  const { blockhash } = await chain.getLatestBlockhash();
  const { txBytes } = buildSettlementTx(expected, blockhash);
  const sellerSig = extractPartySignature(signAs(txBytes, k.house), txBytes, expected, 'seller'); // the server signs the house seller's leg
  const buyerSig = extractPartySignature(signAs(txBytes, buyer), txBytes, expected, 'buyer'); // the judge's single wallet signature
  const { wire, signature } = assembleSettlementTx(txBytes, expected, { buyer: buyerSig, seller: sellerSig }, k.sa);
  const wire64 = Buffer.from(wire).toString('base64');
  const sim = await chain.simulate(wire64);
  if (sim.err) throw new Error(`simulation failed: ${JSON.stringify(sim.err)}\n${sim.logs.slice(-6).join('\n')}`);
  const tSend = Date.now();
  const sent = await chain.send(wire64);
  if (sent !== signature) throw new Error('the node returned a different signature');
  let parsed = null;
  for (let i = 0; i < 40 && !parsed; i++) {
    const st = await chain.getSignatureStatus(signature);
    if (st?.confirmed) parsed = await chain.getTransaction(signature);
    if (!parsed) await new Promise((r) => setTimeout(r, 1000));
  }
  log(`transaction ${wire.length} bytes; sent to confirmed in ${Date.now() - tSend} ms`);
  const ownerAfter = (await chain.readAsset(o.asset.toBase58()))?.owner ?? null;
  const verdict = verifySettled(parsed, expected, ownerAfter);
  if (!verdict.ok) throw new Error(`the settlement landed but did not verify: ${verdict.code}: ${verdict.detail}`);
  return { signature, explorerUrl: explorerTxUrl(signature, 'devnet'), asset: o.asset.toBase58(), gross: gross.toString(), ownerAfter, verified: true };
}
