/**
 * The credit purchase transaction: built, validated, signed, sent on LiteSVM (real token programs, no network) and verified, for BOTH cluster
 * configs: the devnet test mint, and the real mainnet USDC address created as a mint inside the SVM (mainnet itself is never contacted).
 * Plus the red team: every tampered variant must be rejected.
 */
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { MAINNET_USDC_MINT } from '../config';
import { assertCreditTx, buildCreditInstructions, buildUnsignedCreditTx, creditMemo, ExpectedCredit } from '../credit-tx';
import { assembleCreditTx, extractBuyerSignature } from '../credit-sign';
import { verifyCreditPaid } from '../credit-verify';
import { ataAddress, MEMO_PROGRAM_ID, transferCheckedIx } from '../ix';
import { WALLET_GUARD_PROGRAMS } from '../settlement-tx';
import { createCreditWorld, walletSigns } from '@/server/credits/__tests__/credit-world';

const ID = 'cccccccc-0000-4000-8000-000000000001';
const rejects = (fn: () => void) => { try { fn(); } catch (e) { expect((e as { code?: string }).code).toMatch(/tx_mismatch|bad_signature/); return; } throw new Error('expected a rejection'); };
const toBytes = (ixs: TransactionInstruction[], payer: PublicKey, blockhash: string, signers: Keypair[] = []) => {
  const t = new Transaction({ feePayer: payer, recentBlockhash: blockhash });
  t.add(...ixs);
  if (signers.length) t.partialSign(...signers);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
};

describe.each([
  ['devnet (test mint)', { cluster: 'devnet' as const, mint: undefined }],
  ['mainnet-beta (real USDC address, created inside LiteSVM)', { cluster: 'mainnet-beta' as const, mint: new PublicKey(MAINNET_USDC_MINT) }],
])('credit purchase on %s', (_name, cfg) => {
  const mk = () => createCreditWorld({ mint: cfg.mint, cluster: cfg.cluster });
  const prep = (w: ReturnType<typeof mk>, e = w.expected(ID)) => ({ e, bytes: buildUnsignedCreditTx(e, w.svm.latestBlockhash()) });

  it('uses the mint of the cluster, and the buyer with 0 SOL pays 1 USDC to the fee wallet while SA pays the fee and the account rent', () => {
    const w = mk();
    expect(w.usdc.toBase58()).toBe(cfg.cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : w.usdc.toBase58());
    const { e, bytes } = prep(w);
    expect(e.cluster).toBe(cfg.cluster);
    expect(e.usdcMint).toBe(w.usdc.toBase58());
    assertCreditTx(bytes, e); // the browser pre-check
    const sig = extractBuyerSignature(walletSigns(bytes, w.buyer), bytes, e);
    const { wire } = assembleCreditTx(bytes, e, sig, w.sa);
    expect(wire.length).toBeLessThanOrEqual(1232);
    const buyer0 = w.usdcOf(w.buyer), sa0 = w.sol(w.sa);
    expect(w.sol(w.buyer)).toBe(0n);
    expect(w.usdcOf(w.feeWallet)).toBe(0n); // the fee wallet had no token account yet: SA creates it
    expect(w.submit(wire)).toEqual({ ok: true, err: null });
    expect(buyer0 - w.usdcOf(w.buyer)).toBe(1_000_000n);
    expect(w.usdcOf(w.feeWallet)).toBe(1_000_000n);
    expect(w.sol(w.buyer)).toBe(0n);
    expect(sa0 - w.sol(w.sa)).toBeGreaterThan(0n);
  });

  it('a second purchase to an existing fee wallet account lands too (the idempotent create is a no-op)', () => {
    const w = mk();
    for (const id of [ID, 'cccccccc-0000-4000-8000-000000000002']) {
      const { e, bytes } = prep(w, w.expected(id));
      const { wire } = assembleCreditTx(bytes, e, extractBuyerSignature(walletSigns(bytes, w.buyer), bytes, e), w.sa);
      expect(w.submit(wire).ok).toBe(true);
    }
    expect(w.usdcOf(w.feeWallet)).toBe(2_000_000n);
  });

  it('a transaction built for the OTHER cluster mint is rejected', () => {
    const w = mk();
    const { e, bytes } = prep(w);
    const other = cfg.cluster === 'mainnet-beta' ? Keypair.generate().publicKey.toBase58() : MAINNET_USDC_MINT;
    rejects(() => assertCreditTx(bytes, { ...e, usdcMint: other }));
  });

  it('the on-chain verification accepts the real outcome and rejects tampered ones', async () => {
    const w = mk();
    const { e, bytes } = prep(w);
    const { wire } = assembleCreditTx(bytes, e, extractBuyerSignature(walletSigns(bytes, w.buyer), bytes, e), w.sa);
    const sig = await w.port.send(Buffer.from(wire).toString('base64'));
    const tx = (await w.port.getTransaction(sig))!;
    expect(verifyCreditPaid(tx, e)).toEqual({ ok: true });
    const clone = (f: (t: typeof tx) => void) => { const t = structuredClone(tx); f(t); return t; };
    expect(verifyCreditPaid(null, e)).toMatchObject({ ok: false, code: 'tx_failed' });
    expect(verifyCreditPaid(clone((t) => { t.meta!.err = { InstructionError: [0, 'x'] }; }), e)).toMatchObject({ code: 'tx_failed' });
    expect(verifyCreditPaid(tx, { ...e, amount: '2000000' })).toMatchObject({ code: 'delta_mismatch' });
    expect(verifyCreditPaid(tx, { ...e, feeWallet: w.other.publicKey.toBase58() })).toMatchObject({ code: 'delta_mismatch' });
    expect(verifyCreditPaid(tx, { ...e, usdcMint: Keypair.generate().publicKey.toBase58() })).toMatchObject({ code: 'delta_mismatch' }); // other mint: no deltas at all
    expect(verifyCreditPaid(clone((t) => { t.transaction.message.instructions!.push({ program: 'spl-memo', parsed: e.memo }); }), e)).toMatchObject({ code: 'memo_mismatch' }); // a second memo
    expect(verifyCreditPaid(clone((t) => { t.transaction.message.instructions = t.transaction.message.instructions!.filter((i) => i.program !== 'spl-memo'); }), e)).toMatchObject({ code: 'memo_mismatch' });
    expect(verifyCreditPaid(clone((t) => { t.meta!.postTokenBalances!.find((b) => b.owner === w.other.publicKey.toBase58())!.uiTokenAmount.amount = '5'; }), e)).toMatchObject({ code: 'delta_mismatch' }); // a third party gained
  });
});

describe('red team: tampered transactions are rejected (devnet world, same code for mainnet)', () => {
  const w = createCreditWorld();
  const e = w.expected(ID);
  const bh = w.svm.latestBlockhash();
  const good = buildCreditInstructions(e);
  const payer = w.sa.publicKey;
  const buyerAta = ataAddress(w.usdc, w.buyer.publicKey), feeAta = ataAddress(w.usdc, w.feeWallet.publicKey);
  const memoIx = (s: string) => new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(s) });

  it('the honest one passes (control)', () => assertCreditTx(buildUnsignedCreditTx(e, bh), e));

  const variants: [string, () => Uint8Array][] = [
    ['amount one base unit higher', () => toBytes([good[0]!, good[1]!, good[2]!, transferCheckedIx(buyerAta, w.usdc, feeAta, w.buyer.publicKey, 1_000_001n, 6), good[4]!], payer, bh)],
    ['amount lower', () => toBytes([good[0]!, good[1]!, good[2]!, transferCheckedIx(buyerAta, w.usdc, feeAta, w.buyer.publicKey, 1n, 6), good[4]!], payer, bh)],
    ['recipient is the attacker, not the fee wallet', () => toBytes([good[0]!, good[1]!, good[2]!, transferCheckedIx(buyerAta, w.usdc, ataAddress(w.usdc, w.attacker.publicKey), w.buyer.publicKey, 1_000_000n, 6), good[4]!], payer, bh)],
    ['a different mint', () => toBytes([good[0]!, good[1]!, good[2]!, transferCheckedIx(buyerAta, Keypair.generate().publicKey, feeAta, w.buyer.publicKey, 1_000_000n, 6), good[4]!], payer, bh)],
    ['wrong decimals', () => toBytes([good[0]!, good[1]!, good[2]!, transferCheckedIx(buyerAta, w.usdc, feeAta, w.buyer.publicKey, 1_000_000n, 9), good[4]!], payer, bh)],
    ['an extra instruction: SOL from the buyer', () => toBytes([...good, SystemProgram.transfer({ fromPubkey: w.buyer.publicKey, toPubkey: w.attacker.publicKey, lamports: 1 })], payer, bh)],
    ['an extra instruction that makes SA an authority (fee payer inside a transfer)', () => toBytes([...good, transferCheckedIx(ataAddress(w.usdc, payer), w.usdc, ataAddress(w.usdc, w.attacker.publicKey), payer, 1n, 6)], payer, bh)],
    ['a second transfer from the buyer to the attacker', () => toBytes([...good.slice(0, 4), transferCheckedIx(buyerAta, w.usdc, ataAddress(w.usdc, w.attacker.publicKey), w.buyer.publicKey, 5_000_000n, 6), good[4]!], payer, bh)],
    ['the memo is missing', () => toBytes(good.slice(0, 4), payer, bh)],
    ['two memos', () => toBytes([...good, memoIx('hp:credits:other')], payer, bh)],
    ['a different memo', () => toBytes([...good.slice(0, 4), memoIx('hp:credits:' + 'dddddddd-0000-4000-8000-000000000009')], payer, bh)],
    ['the compute price is changed', () => toBytes([good[0]!, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 }), ...good.slice(2)], payer, bh)],
    ['the compute price is missing', () => toBytes([good[0]!, ...good.slice(2)], payer, bh)],
    ['the compute limit is raised', () => toBytes([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...good.slice(1)], payer, bh)],
    ['the instructions are reordered', () => toBytes([good[0]!, good[1]!, good[3]!, good[2]!, good[4]!], payer, bh)],
    ['the fee wallet account creation is missing', () => toBytes([good[0]!, good[1]!, good[3]!, good[4]!], payer, bh)],
    ['the buyer pays the fee instead of SA', () => toBytes(good, w.buyer.publicKey, bh)],
    ['an attacker is the fee payer', () => toBytes(good, w.attacker.publicKey, bh)],
    ['the buyer is another wallet', () => toBytes(buildCreditInstructions({ ...e, buyer: w.other.publicKey.toBase58() }), payer, bh)],
    ['a legacy transaction with trailing bytes', () => Uint8Array.from([...buildUnsignedCreditTx(e, bh), 0, 0, 0])],
    ['a versioned (v0) transaction', () => new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: bh, instructions: good }).compileToV0Message()).serialize()],
    ['too large', () => new Uint8Array(1300)],
    ['garbage', () => Uint8Array.from([1, 2, 3])],
  ];
  it.each(variants)('rejects: %s', (_name, make) => rejects(() => assertCreditTx(make(), e)));

  it('a tolerated wallet-guard instruction passes the browser pre-check but never the server check, and cannot add a signer', () => {
    const guard = new TransactionInstruction({ programId: new PublicKey(WALLET_GUARD_PROGRAMS[0]!), keys: [], data: Buffer.from([1]) });
    const withGuard = toBytes([guard, ...good], payer, bh);
    assertCreditTx(withGuard, e); // default: tolerated
    rejects(() => assertCreditTx(withGuard, e, { tolerated: [] })); // server side
    const sneaky = new TransactionInstruction({ programId: new PublicKey(WALLET_GUARD_PROGRAMS[0]!), keys: [{ pubkey: w.attacker.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([1]) });
    rejects(() => assertCreditTx(toBytes([sneaky, ...good], payer, bh), e));
  });

  it('the buyer signature must be valid over the PREPARED message: a stale message, a missing or a foreign signature fail', () => {
    const prepared = buildUnsignedCreditTx(e, bh);
    const stale = buildUnsignedCreditTx(e, w.svm.latestBlockhash() === bh ? Keypair.generate().publicKey.toBase58() : w.svm.latestBlockhash());
    rejects(() => extractBuyerSignature(walletSigns(stale, w.buyer), prepared, e)); // another blockhash: not the prepared message
    rejects(() => extractBuyerSignature(prepared, prepared, e)); // unsigned
    rejects(() => extractBuyerSignature(walletSigns(prepared, w.sa), prepared, e)); // signed by someone else (the buyer slot stays empty)
    // a signature forged for a different message in the buyer's slot
    const forged = Transaction.from(prepared);
    forged.addSignature(w.buyer.publicKey, Buffer.alloc(64, 7));
    rejects(() => extractBuyerSignature(forged.serialize({ requireAllSignatures: false, verifySignatures: false }), prepared, e));
  });

  it('assembling needs the fee payer key, and the expected object itself is validated', () => {
    const prepared = buildUnsignedCreditTx(e, bh);
    const sig = extractBuyerSignature(walletSigns(prepared, w.buyer), prepared, e);
    rejects(() => assembleCreditTx(prepared, e, sig, Keypair.generate()));
    expect(() => ExpectedCredit.parse({ ...e, memo: 'hp:credits:x' })).toThrow();
    expect(() => ExpectedCredit.parse({ ...e, buyer: e.feeWallet })).toThrow();
    expect(() => ExpectedCredit.parse({ ...e, amount: '0' })).toThrow();
    expect(creditMemo(ID)).toBe('hp:credits:' + ID);
  });
});
