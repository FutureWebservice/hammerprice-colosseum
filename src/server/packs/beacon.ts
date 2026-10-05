/**
 * The beacon of a pack: a recent FINALIZED block (slot and blockhash) read from the cluster's RPC when the operator publishes the pack. It goes
 * into the VRF input of every draw of that pack (lib/vrf/alpha.ts). The server picks no draw-time value: the beacon is fixed at publication, the
 * buyer's seed is the buyer's, so after it has seen a seed the platform has nothing left to choose. Read-only RPC calls, no key, no transaction.
 */
import { ChainError } from '@/lib/chain/errors';
import type { RpcCall } from '@/lib/chain/rpc';
import type { Beacon } from '@/lib/vrf/types';

const FINAL = { commitment: 'finalized' } as const;

/**
 * The beacon of a PAY FIRST draw: the FIRST block produced after the payment's slot, once it is finalized. It did not exist when the buyer signed or when
 * the payment landed, and the rule leaves the server no choice (it cannot pick a later, luckier block: the verifier checks that no block lies between
 * the payment slot and the beacon slot). Returns null while that block is not finalized yet; the draw simply waits and is retried.
 */
export async function readBeaconAfter(call: RpcCall, paymentSlot: number): Promise<Beacon | null> {
  const finalized = await call<number>('getSlot', [FINAL]);
  if (finalized <= paymentSlot) return null;
  const blocks = await call<number[]>('getBlocks', [paymentSlot + 1, Math.min(finalized, paymentSlot + 200), FINAL]);
  const first = blocks[0];
  if (first === undefined) return null;
  const block = await call<{ blockhash?: string } | null>('getBlock', [first, { ...FINAL, transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
  if (!block?.blockhash) throw new ChainError('rpc_unavailable', 'could not read the block after the payment');
  return { slot: first, blockhash: block.blockhash };
}

export async function readBeacon(call: RpcCall): Promise<Beacon> {
  const slot = await call<number>('getSlot', [FINAL]);
  const blocks = await call<number[]>('getBlocks', [Math.max(0, slot - 40), slot, FINAL]);
  for (const s of [...blocks].reverse().slice(0, 5)) {
    const block = await call<{ blockhash?: string } | null>('getBlock', [s, { ...FINAL, transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]).catch(() => null);
    if (block?.blockhash && s > 0) return { slot: s, blockhash: block.blockhash };
  }
  throw new ChainError('rpc_unavailable', 'could not read a finalized block for the randomness anchor');
}
