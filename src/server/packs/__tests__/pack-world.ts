/**
 * Test world for the pack payment and service tests: the shared LiteSVM world (real Core program, real token program), optionally with the
 * USDC mint standing at the REAL mainnet USDC address (a copy of the world's test mint account moved to that address, buyer funded in it).
 * No network. Not a test file.
 */
import { PublicKey } from '@solana/web3.js';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { ataAddress, createAtaIdempotentIx, mintToIx, tokenAccountAmount } from '@/lib/chain/ix';
import { createWorld, type World } from '@/lib/chain/__tests__/svm-world';
import type { Cluster, PackExpectedPayment } from '@/contracts';
import { packMemo } from '@/lib/packs/commit';

export type PackWorld = World & { cluster: Cluster };

export function createPackWorld(cluster: Cluster): PackWorld {
  const w = createWorld();
  if (cluster === 'devnet') return { ...w, cluster };
  const main = new PublicKey(MAINNET_USDC_MINT);
  const acc = w.svm.getAccount(w.usdc.toBase58() as never) as unknown as Record<string, unknown>;
  w.svm.setAccount({ ...acc, address: MAINNET_USDC_MINT } as never);
  const ata = ataAddress(main, w.buyer.publicKey);
  w.send([createAtaIdempotentIx(w.sa.publicKey, ata, w.buyer.publicKey, main), mintToIx(main, ata, w.mintAuth.publicKey, 1_000_000_000n)], w.sa, [w.mintAuth]);
  const usdcOf = (k: PublicKey | { publicKey: PublicKey }) => {
    const a = w.svm.getAccount(ataAddress(main, k instanceof PublicKey ? k : k.publicKey).toBase58() as never);
    return a.exists ? tokenAccountAmount(a.data) : 0n;
  };
  return { ...w, usdc: main, usdcOf: usdcOf as World['usdcOf'], cluster };
}

export const DRAW_ID = 'dddddddd-0000-4000-8000-000000000001';
export const POOL_HASH = 'ab'.repeat(32);

/** The expected payment of a pack draw in this world (operator = `w.seller` unless given). */
export function expectedPack(w: PackWorld, asset: PublicKey, o: Partial<PackExpectedPayment> = {}): PackExpectedPayment {
  const drawId = o.drawId ?? DRAW_ID;
  const gross = BigInt(o.gross ?? '10000000');
  const fee = BigInt(o.platformFee ?? (gross * 250n) / 10_000n);
  return {
    drawId, cluster: w.cluster, buyer: w.buyer.publicKey.toBase58(), operator: w.seller.publicKey.toBase58(), asset: asset.toBase58(), collection: w.collection.toBase58(),
    usdcMint: w.usdc.toBase58(), gross: gross.toString(), platformFee: fee.toString(), royalty: '0', royaltyRecipient: null, feeWallet: w.feeWallet.publicKey.toBase58(),
    feePayer: w.sa.publicKey.toBase58(), memo: packMemo(drawId, POOL_HASH), ...o,
  };
}
