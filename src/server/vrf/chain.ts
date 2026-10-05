/**
 * The few chain calls a draw needs, behind one small interface: an RPC implementation for the cluster of the config and an in-memory fake
 * in the tests. Everything here is cluster-agnostic (the cluster comes in as a value); a draw only ever writes memo transactions, one per step.
 *
 * Reads that decide anything (the commit slot, the beacon) use `finalized`, the same commitment the browser verifier uses, so the server
 * and a visitor look at the same blocks.
 */
import { Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { Cluster } from '@/contracts';
import { MEMO_PROGRAM_ID } from '@/lib/chain/ix';
import { getBalanceLamports, getLatestBlockhash, makeRpc, sendTransaction, RpcError, type RpcCall } from '@/lib/chain/rpc';
import { ChainError } from '@/lib/chain/errors';
import { classifySendFailure } from '@/lib/chain/port';
import { MEMO_MAX_BYTES } from '@/lib/vrf';

export interface SigStatus { slot: number; err: unknown | null; level: 'processed' | 'confirmed' | 'finalized' }

export interface VrfChain {
  readonly cluster: Cluster;
  latestBlockhash(): Promise<string>;
  /** Whether a transaction with this recent blockhash can still land. */
  isBlockhashValid(blockhash: string): Promise<boolean>;
  /** Sends the serialized transaction; returns the signature the node reports. Throws ChainError. */
  send(txBase64: string): Promise<string>;
  /** null: the node does not know the signature. */
  status(signature: string): Promise<SigStatus | null>;
  finalizedSlot(): Promise<number>;
  /** Confirmed (finalized) slots in [start, end], ascending. */
  blocks(start: number, end: number): Promise<number[]>;
  blockhashOf(slot: number): Promise<string | null>;
  /** Unix seconds of a slot's block, or null when the node does not have it. */
  blockTime(slot: number): Promise<number | null>;
  lamports(address: string): Promise<bigint>;
}

/** The transaction of one step: fee payer SA, one memo instruction that the VRF key signs (so the memo is attributable to the key). */
export function buildMemoTx(memo: string, feePayer: Keypair, vrf: Keypair, blockhash: string): { base64: string; signature: string } {
  if (!/^[\x20-\x7e]+$/.test(memo) || memo.length > MEMO_MAX_BYTES) throw new Error('not a memo this module may write');
  const tx = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash });
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: vrf.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(memo, 'utf8') }));
  tx.sign(feePayer, vrf);
  return { base64: tx.serialize().toString('base64'), signature: bs58.encode(tx.signatures[0]!.signature!) };
}

/** The recent blockhash of a stored transaction (so a restart can ask whether it can still land). */
export const blockhashOfTx = (base64: string): string => Transaction.from(Buffer.from(base64, 'base64')).recentBlockhash!;

export function createRpcChain(cluster: Cluster, call: RpcCall = makeRpc(cluster)): VrfChain {
  const FIN = { commitment: 'finalized' } as const;
  return {
    cluster,
    latestBlockhash: async () => (await getLatestBlockhash(call)).blockhash,
    async isBlockhashValid(blockhash) {
      return (await call<{ value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'confirmed' }])).value;
    },
    async send(txBase64) {
      try {
        return await sendTransaction(call, txBase64);
      } catch (e) {
        if (e instanceof RpcError) throw classifySendFailure(e.message, ((e.data as { logs?: string[] } | undefined)?.logs) ?? []);
        throw e;
      }
    },
    async status(signature) {
      const r = await call<{ value: ({ slot: number; err: unknown | null; confirmationStatus?: string | null } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
      const s = r.value[0];
      if (!s) return null;
      const level = s.confirmationStatus === 'finalized' ? 'finalized' : s.confirmationStatus === 'confirmed' ? 'confirmed' : 'processed';
      return { slot: s.slot, err: s.err, level };
    },
    finalizedSlot: () => call<number>('getSlot', [FIN]),
    blocks: (start, end) => call<number[]>('getBlocks', [start, end, FIN]),
    async blockhashOf(slot) {
      try {
        const b = await call<{ blockhash: string } | null>('getBlock', [slot, { ...FIN, transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
        return b?.blockhash ?? null;
      } catch (e) {
        if (e instanceof RpcError) return null; // skipped or cleaned up: unknown, not a transport failure
        throw e;
      }
    },
    async blockTime(slot) {
      try { return await call<number | null>('getBlockTime', [slot]); } catch (e) {
        if (e instanceof RpcError) return null;
        throw e;
      }
    },
    lamports: (address) => getBalanceLamports(call, address),
  };
}

export { ChainError };
