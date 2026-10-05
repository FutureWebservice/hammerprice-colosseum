/**
 * The three transactions of PAY FIRST, DRAW AFTER against the REAL Core program and the REAL token program (LiteSVM), on BOTH clusters' USDC mints
 * (a test mint for devnet, the mainnet USDC address for mainnet; nothing here talks to a network):
 *   1. the payment (buyer -> house wallet and fee wallet, SA pays): it contains NO card and no asset address,
 *   2. the delivery (the card, house -> buyer, signed by the house and SA only),
 *   3. the refund (USDC, house -> buyer, signed by the house and SA only).
 */
import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { ApiError, type PackPayExpected } from '@/contracts';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { packDeliveryMemo, packMemo } from '@/lib/packs/commit';
import { partySigns } from './svm-world';
import { createPackWorld, DRAW_ID, POOL_HASH, type PackWorld } from '@/server/packs/__tests__/pack-world';
import {
  assemblePayTx, assertPayTx, assertServerTx, buildUnsignedPayTx, buildUnsignedServerTx, extractPaySignature, signServerTx, verifyDelivered, verifyPackPaid,
  type PackDeliveryExpected, type PackServerTx,
} from '../pack-pay-tx';
import { ataAddress, transferCheckedIx } from '../ix';
import type { ParsedTx } from '../verify-settled';

const mismatch = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof ApiError && e.code === 'tx_mismatch' ? 'tx_mismatch' : String(e); } return 'accepted'; };
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

describe.each([['devnet'], ['mainnet-beta']] as const)('pay first transactions on %s', (cluster) => {
  const w: PackWorld = createPackWorld(cluster);
  const pay = (o: Partial<PackPayExpected> = {}): PackPayExpected => {
    const gross = BigInt(o.gross ?? '10000000');
    return {
      drawId: DRAW_ID, cluster, buyer: w.buyer.publicKey.toBase58(), operator: w.houseSeller.publicKey.toBase58(), usdcMint: w.usdc.toBase58(), gross: gross.toString(),
      platformFee: (o.platformFee ?? ((gross * 250n) / 10_000n).toString()), feeWallet: w.feeWallet.publicKey.toBase58(), feePayer: w.sa.publicKey.toBase58(), memo: packMemo(DRAW_ID, POOL_HASH), ...o,
    };
  };
  const parsed = (pre: Map<string, bigint>, post: Map<string, bigint>, memo: string): ParsedTx => ({
    slot: 1, meta: { err: null,
      preTokenBalances: [...pre].map(([owner, amount], i) => ({ accountIndex: i, mint: w.usdc.toBase58(), owner, uiTokenAmount: { amount: amount.toString(), decimals: 6 } })),
      postTokenBalances: [...post].map(([owner, amount], i) => ({ accountIndex: i, mint: w.usdc.toBase58(), owner, uiTokenAmount: { amount: amount.toString(), decimals: 6 } })) },
    transaction: { message: { instructions: [{ program: 'spl-token' }, { program: 'spl-memo', parsed: memo }] } },
  });

  it('uses the USDC mint of the cluster', () => {
    if (cluster === 'mainnet-beta') expect(w.usdc.toBase58()).toBe(MAINNET_USDC_MINT);
    else expect(w.usdc.toBase58()).not.toBe(MAINNET_USDC_MINT);
  });

  it('the PAYMENT: the buyer signs, SA adds its signature, money moves, and there is no card, no asset and no Core instruction in it', () => {
    const e = pay();
    const bytes = buildUnsignedPayTx(e, w.svm.latestBlockhash());
    assertPayTx(bytes, e, { tolerated: [] });
    // no card anywhere in the bytes: no Core program instruction, no asset account
    const tx = Transaction.from(bytes);
    expect(tx.instructions.some((i) => i.programId.toBase58() === CORE)).toBe(false);
    const card = w.consign('Never in the payment', w.houseSeller);
    expect(Buffer.from(bytes).includes(card.toBuffer())).toBe(false);
    const sig = extractPaySignature(partySigns(bytes, w.buyer), bytes, e);
    const { wire, signature } = assemblePayTx(bytes, e, sig, w.sa);
    const buyer0 = w.usdcOf(w.buyer), house0 = w.usdcOf(w.houseSeller), fee0 = w.usdcOf(w.feeWallet), sol0 = w.sol(w.sa);
    const r = w.submit(wire);
    expect(r.err).toBeNull();
    expect(buyer0 - w.usdcOf(w.buyer)).toBe(10_000_000n);
    expect(w.usdcOf(w.houseSeller) - house0).toBe(9_750_000n);
    expect(w.usdcOf(w.feeWallet) - fee0).toBe(250_000n);
    expect(w.sol(w.buyer)).toBe(0n);
    expect(w.sol(w.houseSeller)).toBe(0n);
    expect(sol0 - w.sol(w.sa)).toBeGreaterThan(0n);
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(r.logs.join('\n')).toContain(e.memo);
    expect(bytes.length).toBeLessThanOrEqual(1232);
  });

  it('the buyer cannot be made to sign something else: any change to the payment is a tx_mismatch', () => {
    const e = pay();
    const bh = w.svm.latestBlockhash();
    const other = Keypair.generate().publicKey.toBase58();
    const variants: Record<string, () => Uint8Array> = {
      'a higher price': () => buildUnsignedPayTx({ ...e, gross: '10000001' }, bh),
      'a lower fee': () => buildUnsignedPayTx({ ...e, platformFee: '1' }, bh),
      'another buyer': () => buildUnsignedPayTx({ ...e, buyer: other }, bh),
      'another operator': () => buildUnsignedPayTx({ ...e, operator: other }, bh),
      'another mint': () => buildUnsignedPayTx({ ...e, usdcMint: Keypair.generate().publicKey.toBase58() }, bh),
      'another fee wallet': () => buildUnsignedPayTx({ ...e, feeWallet: other }, bh),
      'another fee payer': () => buildUnsignedPayTx({ ...e, feePayer: other }, bh),
      'another memo': () => buildUnsignedPayTx({ ...e, memo: packMemo(DRAW_ID, 'cd'.repeat(32)) }, bh),
    };
    const txOf = () => Transaction.from(buildUnsignedPayTx(e, bh));
    variants['an extra transfer to the attacker'] = () => { const t = txOf(); t.add(transferCheckedIx(ataAddress(w.usdc, w.buyer.publicKey), w.usdc, ataAddress(w.usdc, w.attacker.publicKey), w.buyer.publicKey, 1n, 6)); return t.serialize({ requireAllSignatures: false, verifySignatures: false }); };
    variants['an extra system transfer'] = () => { const t = txOf(); t.add(SystemProgram.transfer({ fromPubkey: w.sa.publicKey, toPubkey: w.attacker.publicKey, lamports: 1 })); return t.serialize({ requireAllSignatures: false, verifySignatures: false }); };
    variants['a card transfer'] = () => {
      const t = txOf();
      const real = Transaction.from(buildUnsignedServerTx({ kind: 'delivery', e: { drawId: DRAW_ID, operator: e.operator, buyer: e.buyer, asset: w.consign('x', w.houseSeller).toBase58(), collection: w.collection.toBase58(), feePayer: e.feePayer, memo: packDeliveryMemo(DRAW_ID) } }, bh));
      t.add(real.instructions[2]!);
      return t.serialize({ requireAllSignatures: false, verifySignatures: false });
    };
    for (const [name, make] of Object.entries(variants)) expect(mismatch(() => assertPayTx(make(), e, { tolerated: [] })), name).toBe('tx_mismatch');
    // a memo that is not this draw's, a fee above the price, the buyer paying themselves, and an operator signing instead of the buyer
    expect(mismatch(() => assertPayTx(buildUnsignedPayTx(e, bh), { ...e, memo: packMemo('dddddddd-0000-4000-8000-000000000009', POOL_HASH) }))).toBe('tx_mismatch');
    expect(mismatch(() => assertPayTx(buildUnsignedPayTx(e, bh), { ...e, platformFee: '10000001' }))).toBe('tx_mismatch');
    expect(mismatch(() => assertPayTx(buildUnsignedPayTx(e, bh), { ...e, operator: e.buyer }))).toBe('tx_mismatch');
    const bytes = buildUnsignedPayTx(e, bh);
    const forged = Transaction.from(partySigns(bytes, w.buyer));
    forged.signatures.find((x) => x.publicKey.equals(w.buyer.publicKey))!.signature = Buffer.alloc(64, 9);
    expect(() => extractPaySignature(forged.serialize({ requireAllSignatures: false, verifySignatures: false }), bytes, e)).toThrow(/signature/i); // a signature that is not the buyer's over this message
    expect(() => extractPaySignature(bytes, bytes, e)).toThrow(/signature/i); // no signature at all
    expect(() => extractPaySignature(partySigns(buildUnsignedPayTx(e, w.svm.latestBlockhash()), w.buyer), bytes, { ...e })).not.toThrow(); // the same blockhash in this world: same message
    // the signer set is exactly {SA, buyer}
    const real = Transaction.from(bytes).compileMessage();
    expect(real.accountKeys.slice(0, real.header.numRequiredSignatures).map(String).sort()).toEqual([e.feePayer, e.buyer].sort());
  });

  it('the landed payment is checked on the money and the memo: other amounts, another memo or a failed transaction are not "paid"', () => {
    const e = pay();
    const b = e.buyer, o = e.operator, f = e.feeWallet;
    const ok = parsed(new Map([[b, 50_000_000n], [o, 0n], [f, 0n]]), new Map([[b, 40_000_000n], [o, 9_750_000n], [f, 250_000n]]), e.memo);
    expect(verifyPackPaid(ok, e)).toEqual({ ok: true });
    expect(verifyPackPaid(parsed(new Map([[b, 50_000_000n], [o, 0n], [f, 0n]]), new Map([[b, 40_000_000n], [o, 9_000_000n], [f, 250_000n]]), e.memo), e)).toMatchObject({ ok: false, code: 'delta_mismatch' });
    expect(verifyPackPaid(parsed(new Map([[b, 50_000_000n], [o, 0n], [f, 0n]]), new Map([[b, 40_000_000n], [o, 9_750_000n], [f, 250_000n], [w.attacker.publicKey.toBase58(), 1n]]), e.memo), e)).toMatchObject({ ok: false, code: 'delta_mismatch' });
    expect(verifyPackPaid({ ...ok, transaction: { message: { instructions: [{ program: 'spl-memo', parsed: 'hp:pack:other' }] } } }, e)).toMatchObject({ ok: false, code: 'memo_mismatch' });
    expect(verifyPackPaid({ ...ok, meta: { ...ok.meta!, err: { InstructionError: [0, 'x'] } } }, e)).toMatchObject({ ok: false, code: 'tx_failed' });
    expect(verifyPackPaid(null, e)).toMatchObject({ ok: false, code: 'tx_failed' });
  });

  it('the DELIVERY: the house moves the card to the buyer, signed by the house and SA only; the card is verified on the buyer afterwards', () => {
    const asset = w.consign('Delivered card', w.houseSeller);
    const e: PackDeliveryExpected = { drawId: DRAW_ID, operator: w.houseSeller.publicKey.toBase58(), buyer: w.buyer.publicKey.toBase58(), asset: asset.toBase58(), collection: w.collection.toBase58(), feePayer: w.sa.publicKey.toBase58(), memo: packDeliveryMemo(DRAW_ID) };
    const x: PackServerTx = { kind: 'delivery', e };
    const unsigned = buildUnsignedServerTx(x, w.svm.latestBlockhash());
    assertServerTx(unsigned, x);
    const real = Transaction.from(unsigned).compileMessage();
    expect(real.accountKeys.slice(0, real.header.numRequiredSignatures).map(String).sort()).toEqual([e.feePayer, e.operator].sort());
    const { wire, signature } = signServerTx(unsigned, x, w.sa, w.houseSeller);
    expect(w.ownerOf(asset)).toBe(w.houseSeller.publicKey.toBase58());
    const r = w.submit(wire);
    expect(r.err).toBeNull();
    expect(w.ownerOf(asset)).toBe(w.buyer.publicKey.toBase58());
    expect(w.sol(w.houseSeller)).toBe(0n);
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    const landed = parsed(new Map(), new Map(), e.memo);
    expect(verifyDelivered(landed, e, w.buyer.publicKey.toBase58())).toEqual({ ok: true });
    expect(verifyDelivered(landed, e, w.houseSeller.publicKey.toBase58())).toMatchObject({ ok: false, code: 'owner_mismatch' });
    expect(verifyDelivered(parsed(new Map(), new Map(), 'hp:pack-card:other'), e, e.buyer)).toMatchObject({ ok: false, code: 'memo_mismatch' });
    expect(verifyDelivered({ ...landed, meta: { ...landed.meta!, err: 'x' } }, e, e.buyer)).toMatchObject({ ok: false, code: 'tx_failed' });
    // the wrong key cannot sign it: a card owned by somebody else is not moved by the house
    const foreign = w.consign('Foreign card', w.seller);
    const fx: PackServerTx = { kind: 'delivery', e: { ...e, asset: foreign.toBase58() } };
    const bad = w.submit(signServerTx(buildUnsignedServerTx(fx, w.svm.latestBlockhash()), fx, w.sa, w.houseSeller).wire);
    expect(bad.ok).toBe(false);
    expect(w.ownerOf(foreign)).toBe(w.seller.publicKey.toBase58());
  });
});
