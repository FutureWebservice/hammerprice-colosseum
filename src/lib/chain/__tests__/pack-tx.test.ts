/**
 * The pack payment transaction against the REAL Core program and the REAL token program (LiteSVM), on BOTH clusters' USDC mints (a test mint
 * for devnet, the mainnet USDC address for mainnet; nothing here talks to a network). One transaction moves the price from the buyer to the
 * operator and the fee wallet and the card from the operator to the buyer; the settlement authority only pays.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { ApiError, settlementMemo } from '@/contracts';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { partySigns } from './svm-world';
import { createPackWorld, expectedPack, POOL_HASH, type PackWorld } from '@/server/packs/__tests__/pack-world';
import { assemblePackTx, assertPackTx, asSettlement, buildUnsignedPackTx, extractPackSignature, signPackAs, verifyPackSettled } from '../pack-tx';
import { assertSettlementTx, buildUnsignedSettlementTx } from '../settlement-tx';
import { ataAddress, MEMO_PROGRAM_ID, transferCheckedIx } from '../ix';
import { tokenDeltas, type ParsedTx } from '../verify-settled';

const mismatch = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ApiError && e.code === 'tx_mismatch' ? 'tx_mismatch' : String(e); } return 'accepted'; };

describe.each([['devnet'], ['mainnet-beta']] as const)('pack payment on %s', (cluster) => {
  const w: PackWorld = createPackWorld(cluster);
  const asset = () => w.consign('Pack card ' + Math.random(), w.seller);

  it('uses the USDC mint of the cluster', () => {
    if (cluster === 'mainnet-beta') expect(w.usdc.toBase58()).toBe(MAINNET_USDC_MINT);
    else expect(w.usdc.toBase58()).not.toBe(MAINNET_USDC_MINT);
  });

  it('buyer and operator sign the same message, SA adds its signature last: the card and the money move in ONE transaction', () => {
    const a = asset(), e = expectedPack(w, a);
    const bh = w.svm.latestBlockhash();
    const bytes = buildUnsignedPackTx(e, bh);
    assertPackTx(bytes, e, { tolerated: [] });
    expect(bytes.length).toBeLessThanOrEqual(1232);

    const buyerSigned = partySigns(bytes, w.buyer), operatorSigned = partySigns(bytes, w.seller);
    const sBuyer = extractPackSignature(buyerSigned, bytes, e, 'buyer');
    const sOp = extractPackSignature(operatorSigned, bytes, e, 'seller');
    const { wire, signature } = assemblePackTx(bytes, e, { buyer: sBuyer, operator: sOp }, w.sa);

    const buyer0 = w.usdcOf(w.buyer), op0 = w.usdcOf(w.seller), fee0 = w.usdcOf(w.feeWallet), saSol0 = w.sol(w.sa);
    const r = w.submit(wire);
    expect(r.err).toBeNull();
    expect(r.ok).toBe(true);
    expect(buyer0 - w.usdcOf(w.buyer)).toBe(10_000_000n);
    expect(w.usdcOf(w.seller) - op0).toBe(9_750_000n);
    expect(w.usdcOf(w.feeWallet) - fee0).toBe(250_000n);
    expect(w.ownerOf(a)).toBe(w.buyer.publicKey.toBase58());
    expect(w.sol(w.buyer)).toBe(0n); // the buyer needed no SOL
    expect(w.sol(w.seller)).toBe(0n); // neither did the operator
    expect(saSol0 - w.sol(w.sa)).toBeGreaterThan(0n); // SA paid fee and rent
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(r.logs.join('\n')).toContain(e.memo);
  });

  it('the operator cannot be made to sign something else: any change to the message is a tx_mismatch', () => {
    const a = asset(), e = expectedPack(w, a);
    const bh = w.svm.latestBlockhash();
    const other = Keypair.generate().publicKey.toBase58();
    const variants: Record<string, () => Uint8Array> = {
      'a higher price': () => buildUnsignedPackTx({ ...e, gross: '10000001' }, bh),
      'a lower fee': () => buildUnsignedPackTx({ ...e, platformFee: '1' }, bh),
      'another buyer': () => buildUnsignedPackTx({ ...e, buyer: other }, bh),
      'another operator': () => buildUnsignedPackTx({ ...e, operator: other }, bh),
      'another card': () => buildUnsignedPackTx({ ...e, asset: asset().toBase58() }, bh),
      'another mint': () => buildUnsignedPackTx({ ...e, usdcMint: Keypair.generate().publicKey.toBase58() }, bh),
      'another fee wallet': () => buildUnsignedPackTx({ ...e, feeWallet: other }, bh),
      'another fee payer': () => buildUnsignedPackTx({ ...e, feePayer: other }, bh),
      'another memo': () => buildUnsignedPackTx({ ...e, memo: `hp:pack:${e.drawId}:${'cd'.repeat(32)}` }, bh),
      'a royalty leg': () => buildUnsignedPackTx({ ...e, royalty: '100000', royaltyRecipient: other }, bh),
    };
    const txOf = () => Transaction.from(buildUnsignedPackTx(e, bh));
    variants['an extra transfer to the attacker'] = () => {
      const t = txOf();
      t.add(transferCheckedIx(ataAddress(w.usdc, w.buyer.publicKey), w.usdc, ataAddress(w.usdc, w.attacker.publicKey), w.buyer.publicKey, 1n, 6));
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    variants['an extra system transfer'] = () => {
      const t = txOf();
      t.add(SystemProgram.transfer({ fromPubkey: w.sa.publicKey, toPubkey: w.attacker.publicKey, lamports: 1 }));
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    variants['no memo'] = () => {
      const t = txOf();
      t.instructions.pop();
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    variants['reordered instructions'] = () => {
      const t = txOf();
      t.instructions.reverse();
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    variants['two memos'] = () => {
      const t = txOf();
      t.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from('second') }));
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    variants['an extra required signer'] = () => {
      const t = txOf();
      t.add(new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: w.attacker.publicKey, isSigner: true, isWritable: false }], data: Buffer.from(e.memo) }));
      t.instructions.splice(t.instructions.length - 2, 1); // drop the original memo so the memo count stays one
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    variants['the auction memo instead of the pack memo'] = () => buildUnsignedSettlementTx({ ...asSettlement(e), memo: settlementMemo(e.drawId, POOL_HASH) }, bh);
    expect(Object.keys(variants).length).toBeGreaterThanOrEqual(14);
    for (const [name, make] of Object.entries(variants)) expect(mismatch(() => assertPackTx(make(), e, { tolerated: [] })), name).toBe('tx_mismatch');
    // and the honest bytes still pass
    assertPackTx(buildUnsignedPackTx(e, bh), e, { tolerated: [] });
  });

  it('a pack payment is not an auction settlement and the other way round (no replay across the two rails)', () => {
    const a = asset(), e = expectedPack(w, a), bh = w.svm.latestBlockhash();
    const packBytes = buildUnsignedPackTx(e, bh);
    expect(mismatch(() => assertSettlementTx(packBytes, { ...asSettlement(e), memo: settlementMemo(e.drawId, POOL_HASH), bidLogHash: POOL_HASH }, { tolerated: [] }))).toBe('tx_mismatch');
    const auctionBytes = buildUnsignedSettlementTx({ ...asSettlement(e), memo: settlementMemo(e.drawId, POOL_HASH), bidLogHash: POOL_HASH }, bh);
    expect(mismatch(() => assertPackTx(auctionBytes, e, { tolerated: [] }))).toBe('tx_mismatch');
  });

  it('a malformed expected payment is refused before any bytes are compared', () => {
    const a = asset(), e = expectedPack(w, a), bh = w.svm.latestBlockhash();
    const bytes = buildUnsignedPackTx(e, bh);
    expect(mismatch(() => assertPackTx(bytes, { ...e, memo: `hp:pack:${'00000000-0000-4000-8000-000000000000'}:${POOL_HASH}` }))).toBe('tx_mismatch'); // memo names another draw
    expect(mismatch(() => assertPackTx(bytes, { ...e, memo: 'hello' }))).toBe('tx_mismatch');
    expect(mismatch(() => assertPackTx(bytes, { ...e, platformFee: '99999999999' }))).toBe('tx_mismatch');
    expect(mismatch(() => assertPackTx(bytes, { ...e, royalty: '1' }))).toBe('tx_mismatch');
    expect(mismatch(() => assertPackTx(bytes, { ...e, buyer: 'nope' }))).toBe('tx_mismatch');
    expect(mismatch(() => assertPackTx(new Uint8Array([1, 2, 3]), e))).toBe('tx_mismatch');
  });

  it('a signature by the wrong key, or over a stale message, is refused', () => {
    const a = asset(), e = expectedPack(w, a), bh = w.svm.latestBlockhash();
    const bytes = buildUnsignedPackTx(e, bh);
    // the buyer's slot holds a perfectly valid signature, made by somebody else's key
    const forged = Transaction.from(bytes);
    forged.addSignature(w.buyer.publicKey, Buffer.from(nacl.sign.detached(forged.serializeMessage(), w.attacker.secretKey)));
    expect(() => extractPackSignature(forged.serialize({ requireAllSignatures: false, verifySignatures: false }), bytes, e, 'buyer')).toThrow(/does not match/);
    expect(() => extractPackSignature(bytes, bytes, e, 'seller')).toThrow(ApiError);
    w.svm.expireBlockhash();
    const fresh = buildUnsignedPackTx(e, w.svm.latestBlockhash());
    expect(mismatch(() => extractPackSignature(partySigns(fresh, w.buyer), bytes, e, 'buyer'))).toBe('tx_mismatch');
  });

  it('a transaction without the operator signature does not run on chain: nobody can take a card without its owner', () => {
    const a = asset(), e = expectedPack(w, a), bh = w.svm.latestBlockhash();
    const bytes = buildUnsignedPackTx(e, bh);
    const t = Transaction.from(bytes);
    t.partialSign(w.buyer, w.sa); // the operator never signed: its slot holds a signature of another key
    t.addSignature(w.seller.publicKey, Buffer.from(nacl.sign.detached(t.serializeMessage(), w.attacker.secretKey)));
    const r = w.submit(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
    expect(r.ok).toBe(false);
    expect(w.ownerOf(a)).toBe(w.seller.publicKey.toBase58());
  });

  it('what landed is verified from the transaction itself: token deltas, memo and the new owner', () => {
    const a = asset(), e = expectedPack(w, a), bh = w.svm.latestBlockhash();
    const bytes = buildUnsignedPackTx(e, bh);
    const sigs = { buyer: extractPackSignature(partySigns(bytes, w.buyer), bytes, e, 'buyer'), operator: extractPackSignature(partySigns(bytes, w.seller), bytes, e, 'seller') };
    const { wire } = assemblePackTx(bytes, e, sigs, w.sa);
    const watched = [w.buyer, w.seller, w.feeWallet].map((k) => k.publicKey.toBase58());
    const snap = () => watched.map((owner, i) => ({ accountIndex: i, mint: w.usdc.toBase58(), owner, uiTokenAmount: { amount: w.usdcOf(new PublicKey(owner)).toString(), decimals: 6 } }));
    const pre = snap();
    expect(w.submit(wire).ok).toBe(true);
    const parsed: ParsedTx = { meta: { err: null, preTokenBalances: pre, postTokenBalances: snap() }, transaction: { message: { instructions: [{ program: 'spl-token' }, { program: 'spl-memo', parsed: e.memo }] } } };
    expect(tokenDeltas(parsed.meta!, e.usdcMint).get(e.operator)).toBe(9_750_000n);
    expect(verifyPackSettled(parsed, e, w.ownerOf(a))).toEqual({ ok: true });
    expect(verifyPackSettled(parsed, e, w.seller.publicKey.toBase58())).toMatchObject({ ok: false, code: 'owner_mismatch' });
    expect(verifyPackSettled({ ...parsed, transaction: { message: { instructions: [{ program: 'spl-memo', parsed: 'other' }] } } }, e, w.ownerOf(a))).toMatchObject({ ok: false, code: 'memo_mismatch' });
    expect(verifyPackSettled(parsed, { ...e, gross: '10000001' }, w.ownerOf(a))).toMatchObject({ ok: false, code: 'delta_mismatch' });
    expect(verifyPackSettled(null, e, null)).toMatchObject({ ok: false, code: 'tx_failed' });
  });

  it('a server-held operator key (the house) signs like a wallet does', () => {
    const house = w.houseSeller;
    const a = w.consign('House pack card', house);
    const e = expectedPack(w, a, { operator: house.publicKey.toBase58() });
    const bytes = buildUnsignedPackTx(e, w.svm.latestBlockhash());
    const opSig = extractPackSignature(signPackAs(bytes, house), bytes, e, 'seller');
    const buyerSig = extractPackSignature(partySigns(bytes, w.buyer), bytes, e, 'buyer');
    const { wire } = assemblePackTx(bytes, e, { buyer: buyerSig, operator: opSig }, w.sa);
    expect(w.submit(wire).ok).toBe(true);
    expect(w.ownerOf(a)).toBe(w.buyer.publicKey.toBase58());
  });
});
