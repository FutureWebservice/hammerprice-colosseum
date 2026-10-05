import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import { ApiError, ExpectedSettlement } from '@/contracts';
import fixture from '@/contracts/fixtures/expected-settlement.json';
import { ataAddress, coreTransferV1Ix, CORE_PROGRAM_ID, transferCheckedIx } from '../ix';
import { buildExpected, buildSettlementTx } from '../settlement-build';
import { phantomPrepare } from './phantom-sim';
import { assertSettlementTx, buildSettlementInstructions, buildUnsignedSettlementTx, MAX_TX_BYTES, WALLET_GUARD_PROGRAMS } from '../settlement-tx';

const e: ExpectedSettlement = ExpectedSettlement.parse(fixture);
const BH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi5';
const pk = (s: string) => new PublicKey(s);
const toBytes = (ixs: TransactionInstruction[], payer = pk(e.feePayer)) => {
  const t = new Transaction({ feePayer: payer, recentBlockhash: BH });
  t.add(...ixs);
  return t.serialize({ requireAllSignatures: false, verifySignatures: false });
};
const honest = () => buildSettlementInstructions(e);
const usdc = pk(e.usdcMint), buyer = pk(e.buyer), seller = pk(e.seller), sa = pk(e.feePayer);
const buyerAta = ataAddress(usdc, buyer);
const attacker = Keypair.generate().publicKey;
const CORE_AT = 5;
const coreWith = (o: Partial<{ newOwner: PublicKey; authority: PublicKey; payer: PublicKey }>) =>
  coreTransferV1Ix({ asset: pk(e.asset), collection: pk(e.collection!), payer: o.payer ?? sa, authority: o.authority ?? seller, newOwner: o.newOwner ?? buyer });
const rejected = (bytes: Uint8Array, expected = e, opts?: { tolerated?: string[] }) => {
  try { assertSettlementTx(bytes, expected, opts); } catch (err) { return err instanceof ApiError && err.code === 'tx_mismatch'; }
  return false;
};

describe('assertSettlementTx: honest transaction', () => {
  it('accepts the builder output', () => assertSettlementTx(buildUnsignedSettlementTx(e, BH), e));
  it('accepts it after a wire round trip with signatures attached', () => {
    const t = Transaction.from(buildUnsignedSettlementTx(e, BH));
    t.addSignature(buyer, Buffer.alloc(64, 7));
    assertSettlementTx(t.serialize({ requireAllSignatures: false, verifySignatures: false }), e);
  });
  it('is deterministic and fits the wire limit', () => {
    const a = buildUnsignedSettlementTx(e, BH), b = buildUnsignedSettlementTx(e, BH);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(a.length).toBeLessThanOrEqual(MAX_TX_BYTES);
  });
  it('carries the settlement id and bid log hash in the memo', () => {
    const memo = honest().at(-1)!;
    expect(memo.data.toString('utf8')).toBe(`hp:settle:${e.settlementId}:${e.bidLogHash}`);
  });
  it('builder refuses an expected settlement whose memo is not derived from the id and hash', () => {
    expect(() => assertSettlementTx(buildUnsignedSettlementTx(e, BH), { ...e, memo: 'hp:settle:x' })).toThrow(ApiError);
  });
  it('pays the seller gross - fee - royalty and orders the legs as specified', () => {
    const r = buildExpected({ settlementId: e.settlementId, cluster: 'devnet', buyer: e.buyer, seller: e.seller, asset: e.asset, collection: e.collection, usdcMint: e.usdcMint, gross: 100_000_000n, platformFee: 2_500_000n, royalty: 2_000_000n, royaltyRecipient: Keypair.generate().publicKey.toBase58(), feeWallet: e.feeWallet, feePayer: e.feePayer, bidLogHash: e.bidLogHash });
    const ixs = buildSettlementInstructions(r);
    const amounts = ixs.filter((i) => i.data.length === 10 && i.data[0] === 12).map((i) => i.data.readBigUInt64LE(1));
    expect(amounts).toEqual([95_500_000n, 2_500_000n, 2_000_000n]);
    expect(buildSettlementTx(r, BH).txBytes.length).toBeLessThanOrEqual(MAX_TX_BYTES);
  });
});

describe('assertSettlementTx: red team (every variant must be rejected)', () => {
  const variants: Record<string, () => Uint8Array> = {
    'amount +1 base unit': () => toBytes(buildSettlementInstructions({ ...e, gross: String(BigInt(e.gross) + 1n) })),
    'fee wallet swapped for the attacker': () => toBytes(buildSettlementInstructions({ ...e, feeWallet: attacker.toBase58() })),
    'card goes to the attacker, not the buyer': () => { const i = honest(); i[CORE_AT] = coreWith({ newOwner: attacker }); return toBytes(i); },
    'Core authority = platform (delegate style)': () => { const i = honest(); i[CORE_AT] = coreWith({ authority: sa }); return toBytes(i); },
    'payout redirected (seller swapped)': () => toBytes(buildSettlementInstructions({ ...e, seller: attacker.toBase58() })),
    'extra SystemProgram.transfer from the platform': () => toBytes([...honest(), SystemProgram.transfer({ fromPubkey: sa, toPubkey: attacker, lamports: 1_000_000_000 })]),
    'extra SPL transfer from the buyer appended': () => toBytes([...honest(), transferCheckedIx(buyerAta, usdc, ataAddress(usdc, attacker), buyer, 1_000_000n, 6)]),
    'extra required signer added': () => toBytes([...honest(), SystemProgram.transfer({ fromPubkey: attacker, toPubkey: sa, lamports: 1 })]),
    'fee leg dropped': () => { const i = honest(); i.splice(4, 1); return toBytes(i); },
    'instruction order swapped': () => { const i = honest(); [i[3], i[4]] = [i[4]!, i[3]!]; return toBytes(i); },
    'different settlement id in the memo': () => toBytes(buildSettlementInstructions({ ...e, memo: `hp:settle:deadbeef-0000-4000-8000-000000000000:${e.bidLogHash}` })),
    'different bid-log hash in the memo': () => toBytes(buildSettlementInstructions({ ...e, memo: `hp:settle:${e.settlementId}:${'0'.repeat(64)}` })),
    'buyer as fee payer': () => toBytes(honest(), buyer),
    'unknown program injected': () => toBytes([new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) }), ...honest()]),
    'extra ComputeBudget price (platform would overpay fees)': () => { const i = honest(); i.splice(1, 0, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 })); return toBytes(i); },
    'seller flipped to non-signer on the Core instruction': () => { const i = honest(); const c = coreWith({}); c.keys = c.keys.map((k) => (k.pubkey.equals(seller) ? { ...k, isSigner: false } : k)); i[CORE_AT] = c; return toBytes(i); },
    'extra account on the Core instruction': () => { const i = honest(); const c = coreWith({}); c.keys.push({ pubkey: attacker, isSigner: false, isWritable: true }); i[CORE_AT] = c; return toBytes(i); },
    'second signer added to the Core instruction': () => { const i = honest(); const c = coreWith({}); c.keys.push({ pubkey: attacker, isSigner: true, isWritable: false }); i[CORE_AT] = c; return toBytes(i); },
    'changed decimals': () => { const i = honest(); i[3] = transferCheckedIx(buyerAta, usdc, ataAddress(usdc, seller), buyer, BigInt(e.gross) - BigInt(e.platformFee), 9); return toBytes(i); },
    'changed mint': () => toBytes(buildSettlementInstructions({ ...e, usdcMint: attacker.toBase58() })),
    'drops the Core transfer (buyer pays, gets nothing)': () => { const i = honest(); i.splice(CORE_AT, 1); return toBytes(i); },
  };
  for (const [name, make] of Object.entries(variants)) it(`rejects: ${name}`, () => expect(rejected(make())).toBe(true));

  it('tolerated guard instruction with an extra signer is still rejected', () => {
    const guard = pk(WALLET_GUARD_PROGRAMS[0]!);
    const g = new TransactionInstruction({ programId: guard, keys: [{ pubkey: attacker, isSigner: true, isWritable: false }], data: Buffer.from([1]) });
    expect(rejected(toBytes([g, ...honest()]))).toBe(true);
  });
  it('rejects a v0 message, trailing bytes and garbage', () => {
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: sa, recentBlockhash: BH, instructions: honest() }).compileToV0Message()).serialize();
    expect(rejected(v0)).toBe(true);
    expect(rejected(Uint8Array.from([...buildUnsignedSettlementTx(e, BH), 0]))).toBe(true);
    expect(rejected(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(rejected(new Uint8Array(0))).toBe(true);
  });
  it('rejects anything over 1,232 bytes', () => {
    expect(rejected(new Uint8Array(MAX_TX_BYTES + 1))).toBe(true);
  });
});

describe('guard programs', () => {
  const guard = pk(WALLET_GUARD_PROGRAMS[0]!);
  const withGuard = () => toBytes([new TransactionInstruction({ programId: guard, keys: [], data: Buffer.from([1]) }), ...honest()]);
  it('an allow-listed guard instruction is tolerated (browser pre-check default)', () => assertSettlementTx(withGuard(), e));
  it('the same instruction is refused when tolerance is switched off (server, strict)', () => expect(rejected(withGuard(), e, { tolerated: [] })).toBe(true));
  it('an unlisted program is refused even when others are tolerated', () => {
    const other = Keypair.generate().publicKey;
    expect(rejected(toBytes([new TransactionInstruction({ programId: other, keys: [], data: Buffer.from([1]) }), ...honest()]))).toBe(true);
  });
});

describe('Core instruction bytes', () => {
  it('a missing collection uses the program id as the placeholder', () => {
    const ix = coreTransferV1Ix({ asset: pk(e.asset), collection: null, payer: sa, authority: seller, newOwner: buyer });
    expect(ix.keys[1]!.pubkey.equals(CORE_PROGRAM_ID)).toBe(true);
  });
});

describe('wallet-stable canonical message', () => {
  it('carries its own compute unit price, so Phantom does not prepend one and change the message the buyer signs', () => {
    const prices = honest().filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3);
    expect(prices).toHaveLength(1);
  });

  it('refuses a second price instruction, which is exactly what a wallet that was not given one adds', () => {
    const extra = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 374_008 });
    expect(rejected(toBytes([extra, ...honest()]))).toBe(true);
  });
});

describe('a Phantom-like wallet (phantom-sim.ts)', () => {
  it('leaves the builder output alone, because it already carries a compute unit price', () => {
    const bytes = buildUnsignedSettlementTx(e, BH);
    const { bytes: signed, addedPrice } = phantomPrepare(bytes);
    expect(addedPrice).toBe(false); // red if the canonical message loses its price instruction
    expect(Buffer.from(signed).equals(Buffer.from(bytes))).toBe(true);
    assertSettlementTx(signed, e);
  });

  it('would change a canonical message without a price, and the changed message is refused: the real-wallet failure', () => {
    const price = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3;
    const without = toBytes(honest().filter((ix) => !price(ix)));
    const { bytes: signed, addedPrice } = phantomPrepare(without);
    expect(addedPrice).toBe(true);
    expect(Buffer.from(signed).equals(Buffer.from(without))).toBe(false);
    expect(rejected(signed)).toBe(true);
  });
});
