/**
 * A tiny LiteSVM world for the AI credit purchase (no Core program needed): the real SPL Token and Associated Token programs, a USDC mint
 * AT ANY ADDRESS (the devnet test mint, or the real mainnet USDC address as a mint created inside the SVM: mainnet is never contacted),
 * a buyer holding 0 SOL, a fee wallet, and SA paying everything. Also a ChainPort over it. Not a test file.
 */
import { LiteSVM, FailedTransactionMetadata } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Cluster } from '@/contracts';
import { ChainError } from '@/lib/chain/errors';
import { ataAddress, createAtaIdempotentIx, mintToIx, TOKEN_PROGRAM_ID, tokenAccountAmount } from '@/lib/chain/ix';
import { classifySendFailure, type ChainPort } from '@/lib/chain/port';
import type { ParsedTx } from '@/lib/chain/verify-settled';
import { buildExpectedCredit } from '../service';

const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export interface CreditPort extends ChainPort {
  height: number;
  sent: string[];
  /** The next `send` lands on the SVM but throws to the caller, like an RPC that dies after accepting the transaction. */
  dieAfterLanding: boolean;
  tamper?: (tx: ParsedTx) => ParsedTx;
  expireRound(): void;
}

export function createCreditWorld(o: { mint?: PublicKey; cluster?: Cluster } = {}) {
  const svm = new LiteSVM();
  const kit = (tx: Transaction) => getTransactionDecoder().decode(tx.serialize());
  const [sa, buyer, feeWallet, mintAuth, other, attacker, mintKp] = Array.from({ length: 7 }, () => Keypair.generate());
  const usdc = o.mint ?? mintKp!.publicKey;
  svm.airdrop(sa!.publicKey.toBase58() as never, 10_000_000_000n as never);

  // The USDC mint at its address: 82 bytes of SPL mint state written directly (mint authority = mintAuth, 6 decimals, initialized).
  const mint = Buffer.alloc(82);
  mint.writeUInt32LE(1, 0); mintAuth!.publicKey.toBuffer().copy(mint, 4); mint.writeBigUInt64LE(0n, 36); mint[44] = 6; mint[45] = 1;
  svm.setAccount({ address: usdc.toBase58(), data: mint, executable: false, lamports: 1_461_600n, programAddress: TOKEN_PROGRAM_ID.toBase58(), space: 82n } as never);

  function send(instructions: TransactionInstruction[], payer: Keypair, extra: Keypair[] = []) {
    const tx = new Transaction(); tx.recentBlockhash = svm.latestBlockhash(); tx.feePayer = payer.publicKey; tx.add(...instructions); tx.sign(payer, ...extra);
    const r = svm.sendTransaction(kit(tx));
    if (r instanceof FailedTransactionMetadata) throw new Error('setup tx failed: ' + String(r.err()));
  }
  /** Gives `who` this many USDC base units (SA pays the account rent). */
  const fund = (who: PublicKey, amount: bigint) => send([createAtaIdempotentIx(sa!.publicKey, ataAddress(usdc, who), who, usdc), mintToIx(usdc, ataAddress(usdc, who), mintAuth!.publicKey, amount)], sa!, [mintAuth!]);
  fund(buyer!.publicKey, 50_000_000n);

  const usdcOf = (k: PublicKey | Keypair) => { const a = svm.getAccount(ataAddress(usdc, k instanceof Keypair ? k.publicKey : k).toBase58() as never); return a.exists ? tokenAccountAmount(a.data) : 0n; };
  const sol = (k: Keypair) => svm.getBalance(k.publicKey.toBase58() as never) ?? 0n;
  const submit = (wire: Uint8Array) => {
    const r = svm.sendTransaction(getTransactionDecoder().decode(wire));
    return r instanceof FailedTransactionMetadata ? { ok: false, err: r.toString() } : { ok: true, err: null };
  };

  const watched = [buyer!, feeWallet!, other!, attacker!].map((k) => k.publicKey.toBase58());
  const snapshot = () => watched.map((owner, i) => ({ accountIndex: i, mint: usdc.toBase58(), owner, uiTokenAmount: { amount: usdcOf(new PublicKey(owner)).toString(), decimals: 6 } }));
  const parsed = new Map<string, ParsedTx>();
  const port: CreditPort = {
    cluster: o.cluster ?? 'devnet', height: 1_000, sent: [], dieAfterLanding: false,
    expireRound() { svm.expireBlockhash(); port.height += 500; },
    async getUsdcBalance(wallet) { return usdcOf(new PublicKey(wallet)); },
    async readAsset() { return null; },
    async getLatestBlockhash() { return { blockhash: svm.latestBlockhash(), lastValidBlockHeight: port.height + 150 }; },
    async getBlockHeight() { return port.height; },
    async simulate(b64) {
      const r = svm.simulateTransaction(getTransactionDecoder().decode(Buffer.from(b64, 'base64')));
      return r instanceof FailedTransactionMetadata ? { err: r.toString(), logs: r.meta().logs() } : { err: null, logs: r.meta().logs() };
    },
    async send(b64) {
      const wire = Buffer.from(b64, 'base64');
      const pre = snapshot();
      const r = svm.sendTransaction(getTransactionDecoder().decode(wire));
      if (r instanceof FailedTransactionMetadata) throw classifySendFailure(String(r.err() === 7 ? 'BlockhashNotFound' : r.toString()), r.meta().logs());
      const tx = Transaction.from(wire), signature = bs58.encode(tx.signatures[0]!.signature!);
      port.sent.push(signature);
      const memos = tx.instructions.filter((i) => i.programId.toBase58() === MEMO).map((i) => ({ program: 'spl-memo', parsed: i.data.toString('utf8') }));
      parsed.set(signature, { slot: port.sent.length, meta: { err: null, preTokenBalances: pre, postTokenBalances: snapshot() }, transaction: { message: { instructions: [{ program: 'spl-token' }, ...memos] } } });
      if (port.dieAfterLanding) { port.dieAfterLanding = false; throw new ChainError('rpc_unavailable', 'connection dropped after the transaction was accepted'); }
      return signature;
    },
    async getSignatureStatus(sig) { return parsed.has(sig) ? { err: null, confirmed: true } : null; },
    async getTransaction(sig) { const t = parsed.get(sig); return t ? (port.tamper ? port.tamper(t) : t) : null; },
  };
  const expected = (purchaseId: string, patch: Partial<ReturnType<typeof buildExpectedCredit>> = {}) =>
    ({ ...buildExpectedCredit({ purchaseId, cluster: o.cluster ?? 'devnet', buyer: buyer!.publicKey.toBase58(), feePayer: sa!.publicKey.toBase58(), feeWallet: feeWallet!.publicKey.toBase58(), usdcMint: usdc.toBase58(), amount: 1_000_000n }), ...patch });
  /** Adds a wallet to the ones whose USDC the fake `getTransaction` reports (the port lists balances per owner). */
  const watch = (k: PublicKey) => { if (!watched.includes(k.toBase58())) watched.push(k.toBase58()); };
  return { watch, svm, sa: sa!, buyer: buyer!, feeWallet: feeWallet!, other: other!, attacker: attacker!, usdc, port, fund, usdcOf, sol, submit, send, expected };
}
export type CreditWorld = ReturnType<typeof createCreditWorld>;

/** What a wallet does: signs the message of `bytes` with `kp`, keeping other signatures. */
export function walletSigns(bytes: Uint8Array, kp: Keypair): Uint8Array {
  const t = Transaction.from(bytes); t.partialSign(kp);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
}
