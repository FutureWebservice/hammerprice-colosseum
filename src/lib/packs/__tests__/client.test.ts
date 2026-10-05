/**
 * What a wallet is asked to sign for a pack, checked from the transaction bytes on BOTH clusters: the honest payment passes, every tampering is
 * stopped before the wallet opens, and a wallet that changes the message is caught after it signed.
 */
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { PackPayment } from '@/contracts';
import { buildUnsignedPackTx } from '@/lib/chain/pack-tx';
import { fromBase64, toBase64 } from '@/lib/client/bidder';
import { SettleError } from '@/lib/client/settle';
import { createPackWorld, expectedPack } from '@/server/packs/__tests__/pack-world';
import { signPackPayment, toProof } from '../client';
import { poolHashOf } from '../commit';

describe.each([['devnet'], ['mainnet-beta']] as const)('signPackPayment on %s', (cluster) => {
  const w = createPackWorld(cluster);
  const asset = w.consign('Client card', w.seller);
  const e = expectedPack(w, asset);
  const payment = (over: Partial<PackPayment> = {}, bytes = buildUnsignedPackTx(e, w.svm.latestBlockhash())): PackPayment => ({
    txBase64: toBase64(bytes), expected: e, lastValidBlockHeight: 1, roundExpiresAt: '2026-10-05T12:01:00.000Z', buyerSigned: false, operatorSigned: false, ...over,
  });
  const wallet = (kp: Keypair, tweak?: (tx: VersionedTransaction) => VersionedTransaction) => async (tx: VersionedTransaction) => {
    tx.sign([kp]);
    return tweak ? tweak(tx) : tx;
  };
  const base = { cluster, myWallet: w.buyer.publicKey.toBase58(), role: 'buyer' as const, agreedGross: '10000000' };

  it('decodes price, fee, parties and card from the bytes, and returns the wallet\'s signed transaction', async () => {
    const r = await signPackPayment(payment(), { ...base, signTransaction: wallet(w.buyer) });
    expect(r.review).toMatchObject({ ok: true, problems: [], gross: 10_000_000n, toSeller: 9_750_000n, toFeeWallet: 250_000n, asset: asset.toBase58(), buyer: w.buyer.publicKey.toBase58(), seller: w.seller.publicKey.toBase58(), memo: e.memo });
    const signed = VersionedTransaction.deserialize(fromBase64(r.signedTxBase64));
    expect(signed.signatures.some((s) => s.some((b) => b !== 0))).toBe(true);
  });

  it('the operator signs the same message with role seller and needs no agreed price', async () => {
    const r = await signPackPayment(payment(), { cluster, myWallet: w.seller.publicKey.toBase58(), role: 'seller', signTransaction: wallet(w.seller) });
    expect(r.review.ok).toBe(true);
  });

  it('stops before the wallet opens when the transaction asks for another price, goes to another card owner, or belongs to another network', async () => {
    let asked = 0;
    const counting = async (tx: VersionedTransaction) => { asked++; return tx; };
    const greedy = payment({}, buildUnsignedPackTx({ ...e, gross: '99000000', platformFee: '2475000' }, w.svm.latestBlockhash()));
    await expect(signPackPayment(greedy, { ...base, signTransaction: counting })).rejects.toMatchObject({ kind: 'review' });
    const thief = payment({ expected: e }, buildUnsignedPackTx({ ...e, buyer: w.attacker.publicKey.toBase58() }, w.svm.latestBlockhash()));
    await expect(signPackPayment(thief, { ...base, signTransaction: counting })).rejects.toBeInstanceOf(SettleError);
    await expect(signPackPayment(payment(), { ...base, cluster: cluster === 'devnet' ? 'mainnet-beta' : 'devnet', signTransaction: counting })).rejects.toMatchObject({ kind: 'review', detail: { problems: expect.arrayContaining(['cluster']) } });
    await expect(signPackPayment(payment(), { ...base, myWallet: w.attacker.publicKey.toBase58(), signTransaction: counting })).rejects.toMatchObject({ kind: 'review' });
    await expect(signPackPayment(payment(), { ...base, agreedGross: '1', signTransaction: counting })).rejects.toMatchObject({ kind: 'review' }); // not the price on the page
    expect(asked).toBe(0);
  });

  it('a transaction that differs from the expected payment in any other way is refused by the byte-exact validator', async () => {
    const t = Transaction.from(buildUnsignedPackTx(e, w.svm.latestBlockhash()));
    t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }));
    const extra = payment({}, t.serialize({ requireAllSignatures: false, verifySignatures: false }));
    await expect(signPackPayment(extra, { ...base, signTransaction: wallet(w.buyer) })).rejects.toBeInstanceOf(SettleError);
  });

  it('a wallet that returns another message than it was given is caught', async () => {
    const swapped = wallet(w.buyer, () => VersionedTransaction.deserialize(buildUnsignedPackTx({ ...e, gross: '10000001' }, w.svm.latestBlockhash())));
    await expect(signPackPayment(payment(), { ...base, signTransaction: swapped })).rejects.toMatchObject({ kind: 'wallet_modified' });
    await expect(signPackPayment(payment(), { ...base, signTransaction: async () => { throw Object.assign(new Error('User rejected the request'), { code: 4001 }); } })).rejects.toMatchObject({ kind: 'wallet' });
  });
});

describe('toProof', () => {
  it('maps a public pack and draw to the verifier input, with the cards in committed order', () => {
    const cards = [0, 1, 2].map((i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, position: 2 - i, asset: Keypair.generate().publicKey.toBase58(), tier: 'common', name: `c${i}`, imageUrl: null, listedValue: null, status: i === 0 ? 'removed' as const : 'available' as const }));
    const pack = { id: '00000000-0000-4000-8000-0000000000aa', mode: 'chance', cluster: 'devnet', price: '1', operator: { wallet: Keypair.generate().publicKey.toBase58(), isHouse: false }, odds: [{ tier: 'common', label: { de: 'a', en: 'a' }, bps: 10000, remaining: 3, total: 3 }], commitment: { poolHash: 'ab'.repeat(32) } };
    const draw = { id: 'd', packId: pack.id, drawIndex: 0, buyer: 'b', clientSeed: 'c', poolHash: 'ab'.repeat(32), status: 'settled', tier: 'common', card: { asset: cards[1]!.asset }, vrf: { requestId: null, input: null, proofHex: null, outputHex: null } };
    const { pool, proofDraw } = toProof({ pack, cards } as never, draw as never);
    expect(pool.cards.map((c) => c.asset)).toEqual([cards[2]!.asset, cards[1]!.asset, cards[0]!.asset]);
    expect(pool.removed).toEqual([2]);
    expect(proofDraw.cardAsset).toBe(cards[1]!.asset);
    expect(poolHashOf).toBeTypeOf('function');
    void PublicKey;
  });
});
