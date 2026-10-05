/**
 * Shared test world: LiteSVM with the REAL mpl-core binary (committed fixture), a test USDC mint, a Core collection,
 * cards owned by a seller, and a buyer. Buyer, seller, house seller and the fee wallet hold 0 SOL: SA pays everything.
 * Not a test file (no .test.ts), imported by the settlement-tx, e2e and service tests.
 */
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { createNoopSigner, createSignerFromKeypair, publicKey as umiPk, signerIdentity } from '@metaplex-foundation/umi';
import { create, createCollection, mplCore } from '@metaplex-foundation/mpl-core';
import { fromWeb3JsKeypair, toWeb3JsInstruction } from '@metaplex-foundation/umi-web3js-adapters';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExpectedSettlement } from '@/contracts';
import { settlementMemo } from '@/contracts';
import { ataAddress, createAtaIdempotentIx, initializeMint2Ix, mintToIx, MINT_SIZE, TOKEN_PROGRAM_ID, tokenAccountAmount } from '../ix';

export const CORE_SO = path.resolve(__dirname, 'fixtures/mpl_core.so');
export const SETTLEMENT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
export const bidLogHash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex');
export const BIDS = bidLogHash(['bid-1 msg|sig', 'bid-2 msg|sig', 'bid-3 msg|sig']);

const FIELDLESS: Record<number, string> = { 4: 'InsufficientFundsForFee', 6: 'AlreadyProcessed', 7: 'BlockhashNotFound' };
const errText = (r: FailedTransactionMetadata) => { const e = r.err(); return typeof e === 'number' ? (FIELDLESS[e] ?? `error ${e}`) : r.toString(); };

export function createWorld() {
  const svm = new LiteSVM();
  svm.addProgramFromFile('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d' as never, CORE_SO);
  const kit = (tx: Transaction) => getTransactionDecoder().decode(tx.serialize());
  const [sa, seller, houseSeller, buyer, feeWallet, mintAuth, mintKp, attacker, other, collKp] = Array.from({ length: 10 }, () => Keypair.generate());
  for (const k of [sa!, mintAuth!]) svm.airdrop(k.publicKey.toBase58() as never, 10_000_000_000n as never);
  const usdc = mintKp!.publicKey;
  const umiFor = (payer: PublicKey) => { const u = createUmi('http://127.0.0.1:9').use(mplCore()); u.use(signerIdentity(createNoopSigner(umiPk(payer.toBase58())))); return u; };
  const ixs = (b: { getInstructions(): never[] }) => b.getInstructions().map(toWeb3JsInstruction as never) as TransactionInstruction[];

  function send(instructions: TransactionInstruction[], payer: Keypair, extra: Keypair[] = []) {
    const tx = new Transaction(); tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = payer.publicKey; tx.add(...instructions); tx.sign(payer, ...extra);
    const r = svm.sendTransaction(kit(tx));
    if (r instanceof FailedTransactionMetadata) throw new Error('setup tx failed: ' + String(r.err()));
    return r;
  }

  // test USDC (6 dp) minted to the buyer; SA pays all account creation
  const buyerAta = ataAddress(usdc, buyer!.publicKey);
  send([
    SystemProgram.createAccount({ fromPubkey: sa!.publicKey, newAccountPubkey: usdc, lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    initializeMint2Ix(usdc, 6, mintAuth!.publicKey, null),
    createAtaIdempotentIx(sa!.publicKey, buyerAta, buyer!.publicKey, usdc),
    mintToIx(usdc, buyerAta, mintAuth!.publicKey, 1_000_000_000n),
  ], sa!, [mintKp!, mintAuth!]);

  {
    const u = umiFor(sa!.publicKey);
    send(ixs(createCollection(u, { collection: createSignerFromKeypair(u, fromWeb3JsKeypair(collKp!)), name: 'HP devnet vault', uri: 'https://example.com/c.json' }) as never), sa!, [collKp!]);
  }
  /** A Core card in the collection, owned by `owner`, minted with SA as payer. */
  function consign(name: string, owner: Keypair = seller!): PublicKey {
    const asset = Keypair.generate(), u = umiFor(sa!.publicKey);
    send(ixs(create(u, { asset: createSignerFromKeypair(u, fromWeb3JsKeypair(asset)), name, uri: 'https://example.com/a.json', owner: umiPk(owner.publicKey.toBase58()), collection: { publicKey: umiPk(collKp!.publicKey.toBase58()) } as never }) as never), sa!, [asset]);
    return asset.publicKey;
  }

  const usdcOf = (k: PublicKey | Keypair) => { const a = svm.getAccount(ataAddress(usdc, k instanceof Keypair ? k.publicKey : k).toBase58() as never); return a.exists ? tokenAccountAmount(a.data) : 0n; };
  const sol = (k: Keypair) => svm.getBalance(k.publicKey.toBase58() as never) ?? 0n;
  const ownerOf = (asset: PublicKey) => new PublicKey((svm.getAccount(asset.toBase58() as never) as { data: Uint8Array }).data.subarray(1, 33)).toBase58();

  function expected(asset: PublicKey, o: Partial<ExpectedSettlement> = {}): ExpectedSettlement {
    const settlementId = o.settlementId ?? SETTLEMENT_ID, hash = o.bidLogHash ?? BIDS;
    const gross = BigInt(o.gross ?? '120000000'), fee = BigInt(o.platformFee ?? (gross * 250n) / 10_000n);
    return {
      settlementId, cluster: 'devnet', buyer: buyer!.publicKey.toBase58(), seller: seller!.publicKey.toBase58(), asset: asset.toBase58(), collection: collKp!.publicKey.toBase58(),
      usdcMint: usdc.toBase58(), gross: gross.toString(), platformFee: fee.toString(), royalty: '0', royaltyRecipient: null, feeWallet: feeWallet!.publicKey.toBase58(), feePayer: sa!.publicKey.toBase58(),
      bidLogHash: hash, memo: settlementMemo(settlementId, hash), lifetime: 'blockhash', nonceAccount: null, ...o,
    };
  }
  /** Runs a fully signed wire transaction on the SVM. */
  function submit(wire: Uint8Array) {
    const r = svm.sendTransaction(getTransactionDecoder().decode(wire));
    const failed = r instanceof FailedTransactionMetadata;
    return { ok: !failed, err: failed ? errText(r) : null, cu: failed ? null : Number(r.computeUnitsConsumed()), logs: failed ? r.meta().logs() : r.logs() };
  }
  return { svm, sa: sa!, seller: seller!, houseSeller: houseSeller!, buyer: buyer!, feeWallet: feeWallet!, mintAuth: mintAuth!, attacker: attacker!, other: other!, usdc, collection: collKp!.publicKey, buyerAta, send, consign, usdcOf, sol, ownerOf, expected, submit, umiFor, ixs, kit };
}
export type World = ReturnType<typeof createWorld>;

/** What a wallet does: signs the message of `bytes` with `kp`, keeping other signatures. */
export function partySigns(bytes: Uint8Array, kp: Keypair): Uint8Array {
  const t = Transaction.from(bytes); t.partialSign(kp);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
}
