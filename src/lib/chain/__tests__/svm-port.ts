/**
 * A ChainPort backed by the LiteSVM world: real Core program, real token program, deterministic, no network.
 * `height` is a test-controlled block height; `expireRound()` makes every outstanding blockhash dead on both the SVM and the height.
 */
import { PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { FailedTransactionMetadata } from 'litesvm';
import { getTransactionDecoder } from '@solana/kit';
import { ChainError } from '../errors';
import { decodeAssetAccount } from '../asset';
import { classifySendFailure, type ChainPort } from '../port';
import type { RawAccount } from '../rpc';
import type { ParsedTx } from '../verify-settled';
import type { World } from './svm-world';

export interface SvmPort extends ChainPort {
  height: number;
  /** Everything sent, in order. */
  sent: string[];
  /** Make the next `send` land on the SVM but throw to the caller, like an RPC that dies after accepting the transaction. */
  dieAfterLanding: boolean;
  /** Replace what getTransaction returns (to exercise verification against a tampered result). */
  tamper?: (tx: ParsedTx) => ParsedTx;
  balanceReads: number;
  /** While true, landed transactions are `confirmed` but not yet `finalized` (to test that nothing happens before finality). */
  holdFinality: boolean;
  expireRound(): void;
}

export function createSvmPort(w: World, watch: () => string[] = () => []): SvmPort {
  const parsed = new Map<string, ParsedTx>();
  const acct = (addr: string): RawAccount | null => {
    const a = w.svm.getAccount(addr as never) as { exists: boolean; programAddress: string; data: Uint8Array };
    return a.exists ? { owner: String(a.programAddress), lamports: 1, data: a.data } : null;
  };
  const snapshot = () => [w.buyer, w.seller, w.houseSeller, w.feeWallet, w.other, w.attacker].map((k) => k.publicKey.toBase58()).concat(watch())
    .map((owner, i) => ({ accountIndex: i, mint: w.usdc.toBase58(), owner, uiTokenAmount: { amount: w.usdcOf(new PublicKey(owner)).toString(), decimals: 6 } }));

  const port: SvmPort = {
    cluster: 'devnet', height: 1_000, sent: [], dieAfterLanding: false, balanceReads: 0, holdFinality: false,
    expireRound() { w.svm.expireBlockhash(); port.height += 500; },
    async getUsdcBalance(wallet) {
      port.balanceReads++;
      return w.usdcOf(new PublicKey(wallet));
    },
    async readAsset(mint) {
      const a = acct(mint);
      const first = decodeAssetAccount(mint, a);
      return first?.collection ? decodeAssetAccount(mint, a, acct(first.collection)) : first;
    },
    async getLatestBlockhash() { return { blockhash: w.svm.latestBlockhash(), lastValidBlockHeight: port.height + 150 }; },
    async getBlockHeight() { return port.height; },
    async simulate(b64) {
      const r = w.svm.simulateTransaction(getTransactionDecoder().decode(Buffer.from(b64, 'base64')));
      return r instanceof FailedTransactionMetadata ? { err: r.toString(), logs: r.meta().logs() } : { err: null, logs: r.meta().logs() };
    },
    async send(b64) {
      const wire = Buffer.from(b64, 'base64');
      const pre = snapshot();
      const r = w.svm.sendTransaction(getTransactionDecoder().decode(wire));
      if (r instanceof FailedTransactionMetadata) throw classifySendFailure(String(r.err() === 7 ? 'BlockhashNotFound' : r.toString()), r.meta().logs());
      const tx = Transaction.from(wire), signature = bs58.encode(tx.signatures[0]!.signature!);
      port.sent.push(signature);
      const memo = tx.instructions.find((i) => i.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      parsed.set(signature, { slot: port.sent.length, meta: { err: null, preTokenBalances: pre, postTokenBalances: snapshot() }, transaction: { message: { instructions: [{ program: 'spl-token' }, { program: 'spl-memo', parsed: memo!.data.toString('utf8') }] } } });
      if (port.dieAfterLanding) { port.dieAfterLanding = false; throw new ChainError('rpc_unavailable', 'connection dropped after the transaction was accepted'); }
      return signature;
    },
    async getSignatureStatus(sig) { return parsed.has(sig) ? { err: null, confirmed: true, finalized: !port.holdFinality } : null; },
    async getTransaction(sig) { const t = parsed.get(sig); return t ? (port.tamper ? port.tamper(t) : t) : null; },
  };
  return port;
}
