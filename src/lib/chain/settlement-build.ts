/**
 * Server side of the settlement builder: turns a settlement row (trusted inputs) into an ExpectedSettlement and the
 * unsigned legacy transaction for one signing round. The instruction list itself lives in settlement-tx.ts so the
 * browser validates against the very same code.
 */
import { ExpectedSettlement, settlementMemo } from '@/contracts';
import { buildUnsignedSettlementTx } from './settlement-tx';

export interface SettlementInputs {
  settlementId: string;
  cluster: ExpectedSettlement['cluster'];
  buyer: string;
  seller: string;
  asset: string;
  collection: string | null;
  usdcMint: string;
  gross: bigint;
  platformFee: bigint;
  royalty: bigint;
  royaltyRecipient: string | null;
  feeWallet: string;
  feePayer: string;
  bidLogHash: string;
  lifetime?: 'blockhash' | 'nonce';
  nonceAccount?: string | null;
}

export function buildExpected(i: SettlementInputs): ExpectedSettlement {
  return ExpectedSettlement.parse({
    settlementId: i.settlementId, cluster: i.cluster, buyer: i.buyer, seller: i.seller, asset: i.asset, collection: i.collection,
    usdcMint: i.usdcMint, gross: i.gross.toString(), platformFee: i.platformFee.toString(), royalty: i.royalty.toString(),
    royaltyRecipient: i.royalty > 0n ? i.royaltyRecipient : null, feeWallet: i.feeWallet, feePayer: i.feePayer, bidLogHash: i.bidLogHash,
    memo: settlementMemo(i.settlementId, i.bidLogHash), lifetime: i.lifetime ?? 'blockhash', nonceAccount: i.lifetime === 'nonce' ? (i.nonceAccount ?? null) : null,
  });
}

/** The unsigned transaction both parties sign. `recentBlockhash` is the nonce value when lifetime is 'nonce'. */
export function buildSettlementTx(expected: ExpectedSettlement, recentBlockhash: string): { txBytes: Uint8Array; txBase64: string } {
  const txBytes = buildUnsignedSettlementTx(expected, recentBlockhash);
  return { txBytes, txBase64: Buffer.from(txBytes).toString('base64') };
}
