/**
 * The co-sign rail end to end on LiteSVM with the REAL mpl-core binary (no network, no SOL): both signing orders, the house
 * case, atomic failures, signature hygiene, expired rounds, replay, durable nonce and the royalty leg.
 * Port of the original LiteSVM spike script onto the production modules.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { createNoopSigner, publicKey as umiPk } from '@metaplex-foundation/umi';
import { transferV1 } from '@metaplex-foundation/mpl-core';
import type { ExpectedSettlement } from '@/contracts';
import { buildUnsignedSettlementTx } from '../settlement-tx';
import { assembleSettlementTx, extractPartySignature } from '../settlement-sign';
import { createWorld, partySigns, type World } from './svm-world';

let w: World;
beforeAll(() => { w = createWorld(); });

let n = 0;
const sid = () => `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const prepare = (e: ExpectedSettlement, blockhash: string = w.svm.latestBlockhash()) => buildUnsignedSettlementTx(e, blockhash);
const kp = (role: 'buyer' | 'seller') => (role === 'buyer' ? w.buyer : w.seller);

/** A full round: each party signs the prepared bytes, the server extracts and stores, then assembles with SA last and submits. */
function round(e: ExpectedSettlement, order: ('buyer' | 'seller')[] = ['buyer', 'seller'], o: { prepared?: Uint8Array; seller?: Keypair } = {}) {
  const prepared = o.prepared ?? prepare(e);
  const sigs: Record<string, Uint8Array> = {};
  for (const role of order) sigs[role] = extractPartySignature(partySigns(prepared, role === 'seller' && o.seller ? o.seller : kp(role)), prepared, e, role);
  const { wire, signature } = assembleSettlementTx(prepared, e, sigs as { buyer: Uint8Array; seller: Uint8Array }, w.sa);
  return { ...w.submit(wire), wire, signature };
}

describe('co-sign settlement on the real Core program', () => {
  for (const order of [['buyer', 'seller'], ['seller', 'buyer']] as const) {
    it(`settles when the ${order[0]} signs first; nobody but SA holds SOL`, () => {
      const asset = w.consign('Lot ' + order[0]), e = w.expected(asset, { settlementId: sid() });
      const seller0 = w.usdcOf(w.seller), fee0 = w.usdcOf(w.feeWallet), buyer0 = w.usdcOf(w.buyer), sa0 = w.sol(w.sa);
      const r = round(e, [...order]);
      expect(r.err).toBeNull();
      expect(w.ownerOf(asset)).toBe(w.buyer.publicKey.toBase58());
      expect(w.usdcOf(w.seller) - seller0).toBe(117_000_000n);
      expect(w.usdcOf(w.feeWallet) - fee0).toBe(3_000_000n);
      expect(buyer0 - w.usdcOf(w.buyer)).toBe(120_000_000n);
      expect(w.sol(w.buyer)).toBe(0n);
      expect(w.sol(w.seller)).toBe(0n);
      expect(sa0 - w.sol(w.sa)).toBeGreaterThan(0n);
      expect(r.wire.length).toBeLessThanOrEqual(1232);
      expect(r.cu!).toBeLessThan(150_000);
    });
  }

  it('house show: the server signs the seller leg (house key), the buyer signs once', () => {
    const asset = w.consign('House lot', w.houseSeller), e = w.expected(asset, { settlementId: sid(), seller: w.houseSeller.publicKey.toBase58() });
    const prepared = prepare(e);
    const sellerSig = extractPartySignature(partySigns(prepared, w.houseSeller), prepared, e, 'seller'); // at prepare, server side
    const buyerSig = extractPartySignature(partySigns(prepared, w.buyer), prepared, e, 'buyer'); // the judge's only wallet prompt
    const { wire } = assembleSettlementTx(prepared, e, { buyer: buyerSig, seller: sellerSig }, w.sa);
    expect(w.submit(wire).err).toBeNull();
    expect(w.ownerOf(asset)).toBe(w.buyer.publicKey.toBase58());
  });

  it('underfunded buyer: fails atomically, then the same card settles at an affordable price', () => {
    const asset = w.consign('Lot poor'), e = w.expected(asset, { settlementId: sid(), gross: '5000000000', platformFee: '125000000' });
    const before = { buyer: w.usdcOf(w.buyer), seller: w.usdcOf(w.seller) };
    const r = round(e);
    expect(r.ok).toBe(false);
    expect(w.ownerOf(asset)).toBe(w.seller.publicKey.toBase58());
    expect({ buyer: w.usdcOf(w.buyer), seller: w.usdcOf(w.seller) }).toEqual(before);
    expect(round(w.expected(asset, { settlementId: sid() })).err).toBeNull();
  });

  it('the seller moves the card after the hammer: atomic failure at the Core instruction, the buyer keeps the USDC', () => {
    const asset = w.consign('Lot moved'), e = w.expected(asset, { settlementId: sid() });
    const prepared = prepare(e);
    const sigs = { buyer: extractPartySignature(partySigns(prepared, w.buyer), prepared, e, 'buyer'), seller: extractPartySignature(partySigns(prepared, w.seller), prepared, e, 'seller') };
    const u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(transferV1(u, { asset: umiPk(asset.toBase58()), collection: umiPk(w.collection.toBase58()), newOwner: umiPk(w.other.publicKey.toBase58()), authority: createNoopSigner(umiPk(w.seller.publicKey.toBase58())) }) as never), w.sa, [w.seller]);
    const buyer0 = w.usdcOf(w.buyer);
    const r = w.submit(assembleSettlementTx(prepared, e, sigs, w.sa).wire);
    expect(r.ok).toBe(false);
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
    expect(w.ownerOf(asset)).toBe(w.other.publicKey.toBase58());
  });

  describe('signature hygiene at storeSignature', () => {
    it('refuses a signature over a different amount, from the wrong key, and on a stale message', () => {
      const asset = w.consign('Lot hygiene'), e = w.expected(asset, { settlementId: sid() }), prepared = prepare(e);
      const other = prepare(w.expected(asset, { settlementId: e.settlementId, gross: '119000000', platformFee: '2975000' }));
      expect(() => extractPartySignature(partySigns(other, w.seller), prepared, e, 'seller')).toThrow(/tx_mismatch|differs/);
      const t = Transaction.from(prepared);
      t.addSignature(w.seller.publicKey, Buffer.from(nacl.sign.detached(t.serializeMessage(), w.attacker.secretKey)));
      expect(() => extractPartySignature(t.serialize({ requireAllSignatures: false, verifySignatures: false }), prepared, e, 'seller')).toThrow(/seller signature is missing or does not match/);
      const stale = prepare(e);
      w.svm.expireBlockhash();
      expect(() => extractPartySignature(partySigns(stale, w.buyer), prepare(e), e, 'buyer')).toThrow(/stale or altered/);
    });
    it('a party cannot pass off the other role: the buyer key has no seller signature', () => {
      const asset = w.consign('Lot roles'), e = w.expected(asset, { settlementId: sid() }), prepared = prepare(e);
      expect(() => extractPartySignature(partySigns(prepared, w.buyer), prepared, e, 'seller')).toThrow(/seller signature is missing or does not match/);
    });
  });

  it('an expired round cannot be sent; attempt 2 with a fresh message settles; replay is refused', () => {
    const asset = w.consign('Lot expiry'), e = w.expected(asset, { settlementId: sid() });
    const first = prepare(e);
    const sigs = { buyer: extractPartySignature(partySigns(first, w.buyer), first, e, 'buyer'), seller: extractPartySignature(partySigns(first, w.seller), first, e, 'seller') };
    w.svm.expireBlockhash();
    const late = w.submit(assembleSettlementTx(first, e, sigs, w.sa).wire);
    expect(late.ok).toBe(false);
    expect(late.err).toMatch(/Blockhash/i);
    const ok = round(e); // attempt 2: fresh blockhash, old signatures dropped
    expect(ok.err).toBeNull();
    const buyer0 = w.usdcOf(w.buyer);
    expect(w.submit(ok.wire).ok).toBe(false); // the very same bytes again
    w.svm.expireBlockhash();
    expect(round(e).ok).toBe(false); // a fresh rebuild: the owner changed, so the Core instruction fails
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
  });

  it('carries a royalty leg to its recipient', () => {
    const asset = w.consign('Lot royalty'), recipient = Keypair.generate().publicKey;
    const e = w.expected(asset, { settlementId: sid(), royalty: '6000000', royaltyRecipient: recipient.toBase58() });
    expect(round(e).err).toBeNull();
    expect(w.usdcOf(recipient)).toBe(6_000_000n);
  });

  describe('P1 durable nonce lifetime', () => {
    const makeNonce = () => {
      const nonce = Keypair.generate();
      w.send(SystemProgram.createNonceAccount({ fromPubkey: w.sa.publicKey, noncePubkey: nonce.publicKey, authorizedPubkey: w.sa.publicKey, lamports: Number(w.svm.minimumBalanceForRentExemption(BigInt(NONCE_ACCOUNT_LENGTH))) }).instructions, w.sa, [nonce]);
      w.svm.expireBlockhash(); // a nonce can only be advanced once the blockhash moved on
      const value = () => new PublicKey((w.svm.getAccount(nonce.publicKey.toBase58() as never) as { data: Uint8Array }).data.subarray(40, 72)).toBase58();
      return { nonce, value };
    };
    it('signatures stay valid after the blockhash window; a competing attempt on the same nonce is refused', () => {
      const { nonce, value } = makeNonce();
      const a1 = w.consign('Lot nonce 1'), a2 = w.consign('Lot nonce 2');
      const e1 = w.expected(a1, { settlementId: sid(), lifetime: 'nonce', nonceAccount: nonce.publicKey.toBase58() });
      const e2 = w.expected(a2, { settlementId: sid(), lifetime: 'nonce', nonceAccount: nonce.publicKey.toBase58() });
      const v0 = value();
      const p1 = prepare(e1, v0), p2 = prepare(e2, v0);
      const s1 = { buyer: extractPartySignature(partySigns(p1, w.buyer), p1, e1, 'buyer'), seller: extractPartySignature(partySigns(p1, w.seller), p1, e1, 'seller') };
      const s2 = { buyer: extractPartySignature(partySigns(p2, w.buyer), p2, e2, 'buyer'), seller: extractPartySignature(partySigns(p2, w.seller), p2, e2, 'seller') };
      for (let i = 0; i < 5; i++) w.svm.expireBlockhash(); // minutes pass: an ordinary blockhash would be long dead
      const r1 = w.submit(assembleSettlementTx(p1, e1, s1, w.sa).wire);
      expect(r1.err).toBeNull();
      expect(value()).not.toBe(v0);
      expect(w.ownerOf(a1)).toBe(w.buyer.publicKey.toBase58());
      expect(w.submit(assembleSettlementTx(p2, e2, s2, w.sa).wire).ok).toBe(false);
      expect(w.ownerOf(a2)).toBe(w.seller.publicKey.toBase58());
    });
    it('worst case (nonce, royalty leg, every ATA new) still fits 1,232 bytes', () => {
      const { nonce, value } = makeNonce();
      const newSeller = Keypair.generate(), newFee = Keypair.generate(), royaltyTo = Keypair.generate().publicKey;
      const asset = w.consign('Lot worst', newSeller);
      const e = w.expected(asset, { settlementId: sid(), seller: newSeller.publicKey.toBase58(), feeWallet: newFee.publicKey.toBase58(), royalty: '6000000', royaltyRecipient: royaltyTo.toBase58(), lifetime: 'nonce', nonceAccount: nonce.publicKey.toBase58() });
      const r = round(e, ['buyer', 'seller'], { prepared: prepare(e, value()), seller: newSeller });
      expect(r.err).toBeNull();
      expect(r.wire.length).toBeLessThanOrEqual(1232);
      expect(w.usdcOf(royaltyTo)).toBe(6_000_000n);
    });
  });
});
