/**
 * Everything the settlement service needs from a chain, as one small interface, so the service is tested against
 * LiteSVM (real Core program) and mocks, and run against RPC in production.
 */
import type { AssetInfo, Cluster } from '@/contracts';
import { ApiError } from '@/contracts';
import { getUsdcBalance } from './funds';
import { readAsset } from './asset';
import { ChainError } from './errors';
import { getBlockHeight, getLatestBlockhash, getParsedTransaction, getSignatureStatus, makeRpc, RpcError, sendTransaction, simulateTransaction, type RpcCall } from './rpc';
import type { ParsedTx } from './verify-settled';

export interface ChainPort {
  readonly cluster: Cluster;
  getUsdcBalance(wallet: string): Promise<bigint>;
  readAsset(mint: string): Promise<AssetInfo | null>;
  getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight(): Promise<number>;
  simulate(txBase64: string): Promise<{ err: unknown | null; logs: string[] }>;
  /** Returns the signature. Throws ChainError('blockhash_expired' | 'simulation_failed' | 'rpc_unavailable'). */
  send(txBase64: string): Promise<string>;
  /** `finalized` (additive): the transaction can no longer be rolled back. Pay-first packs draw only after the payment is finalized. */
  getSignatureStatus(signature: string): Promise<{ err: unknown | null; confirmed: boolean; finalized?: boolean } | null>;
  getTransaction(signature: string): Promise<ParsedTx | null>;
}

/** Maps what a node says about a rejected transaction to our error codes. */
export function classifySendFailure(message: string, logs: string[] = []): ApiError {
  const text = `${message} ${logs.join(' ')}`;
  if (/BlockhashNotFound|Blockhash not found|block height exceeded/i.test(text)) return new ChainError('blockhash_expired', 'the signing round ended before the transaction was sent');
  if (/AlreadyProcessed|already been processed/i.test(text)) return new ChainError('wrong_state', 'this transaction was already processed');
  console.warn('send rejected by the node', text.slice(0, 600)); // program logs can carry balances (SA's too): they stay in our log, not in the answer
  return new ChainError('simulation_failed', `the network rejected the transaction: ${message.slice(0, 160)}`);
}

export function createRpcPort(cluster: Cluster, call: RpcCall = makeRpc(cluster)): ChainPort {
  return {
    cluster,
    getUsdcBalance: (w) => getUsdcBalance(w, cluster, { call }),
    readAsset: (m) => readAsset(m, cluster, call),
    getLatestBlockhash: () => getLatestBlockhash(call),
    getBlockHeight: () => getBlockHeight(call),
    simulate: (tx) => simulateTransaction(call, tx),
    async send(tx) {
      try {
        return await sendTransaction(call, tx);
      } catch (e) {
        if (e instanceof RpcError) throw classifySendFailure(e.message, ((e.data as { logs?: string[] } | undefined)?.logs) ?? []);
        throw e;
      }
    },
    async getSignatureStatus(sig) {
      const s = await getSignatureStatus(call, sig);
      return s ? { err: s.err, confirmed: s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized', finalized: s.confirmationStatus === 'finalized' } : null;
    },
    getTransaction: async (sig) => (await getParsedTransaction(call, sig)) as ParsedTx | null,
  };
}
