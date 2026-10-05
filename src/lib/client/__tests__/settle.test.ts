import { describe, it, expect, vi } from 'vitest';
import {
  Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, SystemProgram,
} from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { settlementMemo, type ExpectedSettlement, type PreparedSettlement, type SettlementView, type SignResult } from '@/contracts';
import { toBase64 } from '../bidder';
import {
  SettleError, ataOf, decodeSettlementTx, explorerTxUrl, isTerminal, payStep, reviewSettlement, roundState, signRound,
} from '../settle';

const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const COMPUTE = new PublicKey('ComputeBudget111111111111111111111111111111');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const sa = Keypair.generate(), buyer = Keypair.generate(), seller = Keypair.generate();
const feeWallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
const asset = Keypair.generate().publicKey, collection = Keypair.generate().publicKey;
const SID = 'e2a8d5c1-3f97-4b60-9c2d-6e1a7f4b8d15';
const HASH = 'e52e5f8a3dd8059fccdffa2abd1c347b5792390fef57b1ae78854b947e0881a8';

const expected = (over: Partial<ExpectedSettlement> = {}): ExpectedSettlement => ({
  settlementId: SID, cluster: 'devnet', buyer: buyer.publicKey.toBase58(), seller: seller.publicKey.toBase58(), asset: asset.toBase58(),
  collection: collection.toBase58(), usdcMint: mint.toBase58(), gross: '120000000', platformFee: '3000000', royalty: '0', royaltyRecipient: null,
  feeWallet: feeWallet.toBase58(), feePayer: sa.publicKey.toBase58(), bidLogHash: HASH, memo: settlementMemo(SID, HASH), lifetime: 'blockhash', nonceAccount: null, ...over,
});

interface Build { sellerAmount?: bigint; feeAmount?: bigint; toSellerAta?: PublicKey; newOwner?: PublicKey; memo?: string; extra?: TransactionInstruction[]; authority?: PublicKey }
function buildTx(b: Build = {}): Uint8Array {
  const ata = (owner: PublicKey) => new PublicKey(ataOf(owner.toBase58(), mint.toBase58()));
  const buyerAta = ata(buyer.publicKey);
  const tx = new Transaction({ feePayer: sa.publicKey, recentBlockhash: '11111111111111111111111111111111' });
  tx.add(new TransactionInstruction({ programId: COMPUTE, keys: [], data: Buffer.from([2, 0x30, 0x57, 0x02, 0x00]) }));
  tx.add(createTransferCheckedInstruction(buyerAta, mint, b.toSellerAta ?? ata(seller.publicKey), buyer.publicKey, b.sellerAmount ?? 117_000_000n, 6));
  tx.add(createTransferCheckedInstruction(buyerAta, mint, ata(feeWallet), buyer.publicKey, b.feeAmount ?? 3_000_000n, 6));
  tx.add(new TransactionInstruction({
    programId: CORE, data: Buffer.from([14, 0]),
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true }, { pubkey: collection, isSigner: false, isWritable: false },
      { pubkey: sa.publicKey, isSigner: true, isWritable: true }, { pubkey: b.authority ?? seller.publicKey, isSigner: true, isWritable: false },
      { pubkey: b.newOwner ?? buyer.publicKey, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: CORE, isSigner: false, isWritable: false },
    ],
  }));
  tx.add(new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(b.memo ?? settlementMemo(SID, HASH)) }));
  for (const x of b.extra ?? []) tx.add(x);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

const ctx = (over: Record<string, unknown> = {}) => ({ expected: expected(), role: 'buyer' as const, myWallet: buyer.publicKey.toBase58(), cluster: 'devnet', agreedGross: '120000000', ...over });

// Regression (found by the browser e2e): the client's copy of the associated-token program id was a wrong address, so every real
// settlement failed the buyer's review ("foreign instruction", unknown destinations) and the wallet was never asked to sign.
// The unit tests above passed because they derive their destinations with the same module.
describe('program ids and ATA derivation match the real ones', () => {
  it('ataOf equals the canonical associated token address', () => {
    expect(ataOf(buyer.publicKey.toBase58(), mint.toBase58())).toBe(getAssociatedTokenAddressSync(mint, buyer.publicKey).toBase58());
  });
  it('an associated-token-account instruction built with the real program id is not foreign', () => {
    const real = new TransactionInstruction({ programId: ASSOCIATED_TOKEN_PROGRAM_ID, keys: [], data: Buffer.from([1]) });
    const tx = new Transaction({ feePayer: sa.publicKey, recentBlockhash: '11111111111111111111111111111111' }).add(real);
    expect(decodeSettlementTx(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).foreign).toEqual([]);
    expect(TOKEN.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe('decodeSettlementTx', () => {
  it('reads legs, the card transfer and the memo from the bytes', () => {
    const d = decodeSettlementTx(buildTx());
    expect(d.feePayer).toBe(sa.publicKey.toBase58());
    expect(d.signers.sort()).toEqual([sa.publicKey, buyer.publicKey, seller.publicKey].map((k) => k.toBase58()).sort());
    expect(d.legs.map((l) => l.amount)).toEqual([117_000_000n, 3_000_000n]);
    expect(d.legs.every((l) => l.mint === mint.toBase58() && l.decimals === 6 && l.authority === buyer.publicKey.toBase58())).toBe(true);
    expect(d.coreTransfers).toEqual([{ asset: asset.toBase58(), payer: sa.publicKey.toBase58(), authority: seller.publicKey.toBase58(), newOwner: buyer.publicKey.toBase58() }]);
    expect(d.memos).toEqual([settlementMemo(SID, HASH)]);
    expect(d.foreign).toEqual([]);
    expect(d.advancesNonce).toBe(false);
  });
});

describe('reviewSettlement', () => {
  it('accepts the honest transaction and reports figures taken from the bytes', () => {
    const r = reviewSettlement(decodeSettlementTx(buildTx()), ctx());
    expect(r.problems).toEqual([]);
    expect(r).toMatchObject({ ok: true, gross: 120_000_000n, toSeller: 117_000_000n, toFeeWallet: 3_000_000n, bidLogHash: HASH });
    expect(r.asset).toBe(asset.toBase58());
    expect(r.buyer).toBe(buyer.publicKey.toBase58());
  });

  it.each([
    ['price above what the buyer agreed', { sellerAmount: 118_000_000n }, {}, 'price_mismatch'],
    ['price above the JSON', { sellerAmount: 118_000_000n }, { agreedGross: null }, 'leg_amounts'],
    ['fee changed', { feeAmount: 4_000_000n }, {}, 'leg_amounts'],
    ['payout redirected to an attacker account', { toSellerAta: new PublicKey(ataOf(Keypair.generate().publicKey.toBase58(), mint.toBase58())) }, {}, 'leg_destination'],
    ['card sent to an attacker', { newOwner: Keypair.generate().publicKey }, {}, 'card'],
    ['card authority is not the seller (delegate style)', { authority: sa.publicKey }, {}, 'card'],
    ['memo for another settlement', { memo: settlementMemo('00000000-0000-4000-8000-000000000000', HASH) }, {}, 'memo'],
    ['extra system transfer', { extra: [SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })] }, {}, 'foreign_program'],
    ['token approve hidden in the transaction', { extra: [new TransactionInstruction({ programId: TOKEN, keys: [], data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]) })] }, {}, 'foreign_program'],
    ['unknown program', { extra: [new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })] }, {}, 'foreign_program'],
  ] as const)('refuses: %s', (_name, build, over, problem) => {
    const r = reviewSettlement(decodeSettlementTx(buildTx(build as Build)), ctx(over));
    expect(r.ok).toBe(false);
    expect(r.problems).toContain(problem);
  });

  it('refuses the wrong wallet for the role, the wrong cluster and a different fee payer', () => {
    const d = decodeSettlementTx(buildTx());
    expect(reviewSettlement(d, ctx({ myWallet: Keypair.generate().publicKey.toBase58() })).problems).toContain('not_your_role');
    expect(reviewSettlement(d, ctx({ cluster: 'mainnet-beta' })).problems).toContain('cluster');
    expect(reviewSettlement(d, ctx({ expected: expected({ feePayer: Keypair.generate().publicKey.toBase58() }) })).problems).toContain('fee_payer');
    // the seller reviews the same bytes with their own wallet and no agreed price
    expect(reviewSettlement(d, ctx({ role: 'seller', myWallet: seller.publicKey.toBase58(), agreedGross: null })).ok).toBe(true);
  });
});

describe('roundState', () => {
  const base = (over: Partial<SettlementView>): SettlementView => ({
    id: SID, lotId: SID, status: 'awaiting_payment', rail: 'cosign', cluster: 'devnet', attempt: 1, gross: '120000000', platformFee: '3000000', sellerAmount: '117000000',
    royalty: '0', dueAt: '2026-10-05T18:15:56.000Z', roundExpiresAt: null, buyerSigned: false, sellerSigned: false, role: 'buyer', ...over,
  });
  const T = Date.parse('2026-10-05T18:01:00.000Z');
  it('walks the states both parties see', () => {
    expect(roundState(base({}), T)).toEqual({ kind: 'idle' });
    expect(roundState(base({ roundExpiresAt: '2026-10-05T18:02:00.000Z' }), T)).toEqual({ kind: 'sign_now', secondsLeft: 60 });
    expect(roundState(base({ roundExpiresAt: '2026-10-05T18:02:00.000Z', buyerSigned: true }), T)).toEqual({ kind: 'waiting', on: 'seller', secondsLeft: 60 });
    expect(roundState(base({ role: 'seller', roundExpiresAt: '2026-10-05T18:02:00.000Z', buyerSigned: true }), T)).toEqual({ kind: 'sign_now', secondsLeft: 60 });
    expect(roundState(base({ role: 'seller', roundExpiresAt: '2026-10-05T18:02:00.000Z', sellerSigned: true }), T)).toEqual({ kind: 'waiting', on: 'buyer', secondsLeft: 60 });
    expect(roundState(base({ roundExpiresAt: '2026-10-05T18:00:00.000Z' }), T)).toEqual({ kind: 'idle' }); // round lapsed, next attempt
    expect(roundState(base({ status: 'submitted' }), T)).toEqual({ kind: 'submitted' });
    expect(roundState(base({ status: 'settled' }), T)).toEqual({ kind: 'settled' });
    expect(roundState(base({ status: 'failed' }), T)).toEqual({ kind: 'failed' });
    expect(roundState(base({ status: 'expired' }), T)).toEqual({ kind: 'expired' });
    expect(roundState(base({}), Date.parse('2026-10-05T18:16:00.000Z'))).toEqual({ kind: 'expired' }); // past dueAt, lazily
    expect(isTerminal({ kind: 'settled' })).toBe(true);
    expect(isTerminal({ kind: 'idle' })).toBe(false);
  });
  it('links the explorer for the right cluster', () => {
    expect(explorerTxUrl('SIG', 'devnet')).toBe('https://explorer.solana.com/tx/SIG?cluster=devnet');
    expect(explorerTxUrl('SIG', 'mainnet-beta')).toBe('https://explorer.solana.com/tx/SIG');
  });
  it('never guesses a cluster: an unknown one (null, undefined, empty) adds no query', () => {
    for (const c of [null, undefined, '']) expect(explorerTxUrl('SIG', c)).toBe('https://explorer.solana.com/tx/SIG');
  });
});

describe('signRound', () => {
  const view = { ok: true } as unknown as SignResult;
  function deps(b: Build = {}, over: Record<string, unknown> = {}) {
    const bytes = buildTx(b);
    const prepared: PreparedSettlement = {
      attempt: 1, txBase64: toBase64(bytes), expected: expected(), lastValidBlockHeight: 10, roundExpiresAt: '2026-10-05T18:02:00.000Z',
      dueAt: '2026-10-05T18:15:56.000Z', buyerSigned: false, sellerSigned: true,
    };
    const posted: string[] = [];
    return {
      posted,
      d: {
        prepare: vi.fn(async () => prepared),
        assertTx: vi.fn(),
        signTransaction: vi.fn(async (tx: VersionedTransaction) => { tx.sign([buyer]); return tx; }),
        post: vi.fn(async (s: string) => { posted.push(s); return view; }),
        ...over,
      },
    };
  }
  const c = { role: 'buyer' as const, myWallet: buyer.publicKey.toBase58(), cluster: 'devnet', agreedGross: '120000000' };

  it('reviews, validates, signs, and posts the signed bytes', async () => {
    const { d, posted } = deps();
    const r = await signRound(d, c);
    expect(r.review.ok).toBe(true);
    expect(d.assertTx).toHaveBeenCalledTimes(1);
    expect(d.signTransaction).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(1);
    const back = VersionedTransaction.deserialize(Buffer.from(posted[0]!, 'base64'));
    const buyerIndex = back.message.staticAccountKeys.findIndex((k) => k.equals(buyer.publicKey));
    expect(back.signatures[buyerIndex]!.some((x) => x !== 0)).toBe(true);
  });

  it('does not ask the wallet to sign when the decoded price is not the agreed price', async () => {
    const { d } = deps({ sellerAmount: 118_000_000n });
    await expect(signRound(d, c)).rejects.toMatchObject({ kind: 'review', detail: { problems: expect.arrayContaining(['price_mismatch']) } });
    expect(d.signTransaction).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it('does not sign when the chain validator rejects', async () => {
    const { d } = deps({}, { assertTx: vi.fn(() => { throw new Error('tx_mismatch'); }) });
    await expect(signRound(d, c)).rejects.toMatchObject({ kind: 'validator' });
    expect(d.signTransaction).not.toHaveBeenCalled();
    expect(d.post).not.toHaveBeenCalled();
  });

  it('reports a wallet rejection and posts nothing', async () => {
    const { d } = deps({}, { signTransaction: vi.fn(async () => { throw new Error('User rejected the request.'); }) });
    await expect(signRound(d, c)).rejects.toMatchObject({ kind: 'wallet' });
    expect(d.post).not.toHaveBeenCalled();
  });

  it('refuses a wallet that changed the message it signed', async () => {
    const other = VersionedTransaction.deserialize(buildTx({ sellerAmount: 1n }));
    const { d } = deps({}, { signTransaction: vi.fn(async () => other) });
    await expect(signRound(d, c)).rejects.toMatchObject({ kind: 'wallet_modified' });
    expect(d.post).not.toHaveBeenCalled();
  });

  it('wraps an API failure and keeps the original', async () => {
    const boom = { code: 'round_expired' };
    const { d } = deps({}, { post: vi.fn(async () => { throw boom; }) });
    const err = await signRound(d, c).catch((e) => e);
    expect(err).toBeInstanceOf(SettleError);
    expect(err.kind).toBe('api');
    expect(err.detail.api).toBe(boom);
  });
});

describe('payStep: what the pay sheet offers a person', () => {
  const idle = { kind: 'idle' } as const;
  const open = { kind: 'sign_now', secondsLeft: 40 } as const;
  const step = (state: Parameters<typeof payStep>[0]['state'], o: Partial<Parameters<typeof payStep>[0]> = {}) => payStep({ state, stage: null, failed: false, asked: false, ...o });

  it('opens on a calm summary: nothing runs until the person presses the button', () => {
    expect(step(idle)).toBe('start');
    expect(step(open)).toBe('start'); // a round left open by a reload is not counted down at them either
  });
  it('shows the countdown only while the wallet prompt is open', () => {
    expect(step(idle, { stage: 'preparing' })).toBe('preparing');
    expect(step(open, { stage: 'wallet' })).toBe('confirm');
  });
  it('a round that ends unsigned leaves one Try again, also while a wallet popup is still open', () => {
    expect(step(idle, { asked: true })).toBe('lapsed');
    expect(step(idle, { stage: 'wallet', asked: true })).toBe('lapsed');
  });
  it('a refusal, a cancelled prompt or a changed transaction leaves Try again', () => {
    expect(step(open, { failed: true, asked: true })).toBe('retry');
    expect(step(idle, { failed: true, asked: true })).toBe('retry');
  });
  it('waiting for the other side and the end states offer no button', () => {
    expect(step({ kind: 'waiting', on: 'seller', secondsLeft: 20 }, { asked: true })).toBe('wait');
    expect(step({ kind: 'submitted' })).toBe('wait');
    for (const kind of ['settled', 'expired', 'failed'] as const) expect(step({ kind }, { asked: true })).toBe('done');
    expect(step(null)).toBe('loading');
  });
});
