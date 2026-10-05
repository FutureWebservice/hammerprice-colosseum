/**
 * The settlement service on a REAL Postgres 18 (embedded) and the REAL Core program (LiteSVM). Every row here is created by
 * the test (ENGINE's closeDueLot writes them in production); nothing touches Neon or a network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { Transaction } from '@solana/web3.js';
import { createNoopSigner, publicKey as umiPk } from '@metaplex-foundation/umi';
import { transferV1 } from '@metaplex-foundation/mpl-core';
import * as schema from '@/db/schema';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ApiError, settlementMemo, type SettlementService } from '@/contracts';
import { mintToIx } from '@/lib/chain/ix';
import { buildUnsignedSettlementTx } from '@/lib/chain/settlement-tx';
import { partySigns, createWorld, BIDS, type World } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import { atFault, createSettlementService, type SettlementDeps } from '../service';

type Db = SettlementDeps['db'];
let t: TestPg | undefined, skipReason: string | undefined, db: Db, w: World, port: SvmPort, svc: SettlementService;
const T0 = new Date('2026-10-01T12:00:00.000Z');
let clock = T0;
const advance = (s: number) => { clock = new Date(clock.getTime() + s * 1000); };

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  db = drizzle(t.pool, { schema }) as unknown as Db;
  w = createWorld();
  port = createSvmPort(w);
  svc = createSettlementService({
    db, chainFor: () => port, sa: w.sa, houseSeller: w.houseSeller, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(),
    defaultCluster: 'devnet', now: () => clock, sleep: async () => { advance(1); }, assertCluster: () => undefined,
  });
}, 120_000);
afterAll(async () => {
  // The sponsorship-budget test imports a fresh module graph whose `@/db` opens its own pool on this server: close it first, or the server's shutdown is an uncaught FATAL.
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
beforeEach(() => { clock = T0; if (port) port.height = 1_000; });
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

// ---- fixtures -----------------------------------------------------------------------------------------------------------
const profile = async (wallet: string, o: Partial<typeof schema.profiles.$inferInsert> = {}) =>
  (await db.insert(schema.profiles).values({ walletAddress: wallet, ...o }).returning())[0]!;
let n = 0;
const uuid = () => `cccccccc-0000-4000-8000-${String(++n).padStart(12, '0')}`;

async function world() {
  const buyer = await profile(w.buyer.publicKey.toBase58()).catch(async () => (await db.select().from(schema.profiles).where(eq(schema.profiles.walletAddress, w.buyer.publicKey.toBase58())))[0]!);
  return { buyer };
}

/** A sold lot with its awaiting_payment settlement, as ENGINE's closeDueLot would leave it. */
async function sale(o: { seller?: Keypair; buyerProfile?: typeof schema.profiles.$inferSelect; sellerProfile?: typeof schema.profiles.$inferSelect; gross?: bigint; standard?: string; dueInS?: number; cluster?: string; asset?: string } = {}) {
  const sellerKp = o.seller ?? w.seller;
  const buyerProfile = o.buyerProfile ?? (await profile(Keypair.generate().publicKey.toBase58())); // a fresh profile per sale so strikes do not leak between tests
  const sellerProfile = o.sellerProfile ?? (await profile(sellerKp.publicKey.toBase58()).catch(async () => (await db.select().from(schema.profiles).where(eq(schema.profiles.walletAddress, sellerKp.publicKey.toBase58())))[0]!));
  const asset = o.asset ?? w.consign('Lot ' + ++n, sellerKp).toBase58();
  const [show] = await db.insert(schema.shows).values({ sellerId: sellerProfile.id, title: 'Test show', cluster: o.cluster ?? 'devnet', settlementMode: 'onchain' }).returning();
  const [lot] = await db.insert(schema.lots).values({ showId: show!.id, sellerId: sellerProfile.id, lotNumber: 1, mintAddress: asset, nftStandard: o.standard ?? 'core', name: 'Card', increment: 1_000_000n, openingPrice: 1_000_000n, state: 'sold' }).returning();
  const gross = o.gross ?? 120_000_000n, fee = (gross * 250n) / 10_000n, id = uuid();
  const [row] = await db.insert(schema.settlements).values({
    id, lotId: lot!.id, buyerId: buyerProfile.id, sellerId: sellerProfile.id, grossAmount: gross, platformFee: fee, sellerAmount: gross - fee, status: 'awaiting_payment', rail: 'cosign', cluster: o.cluster ?? 'devnet',
    mintAddress: asset, dueAt: new Date(T0.getTime() + (o.dueInS ?? 900) * 1000), bidLogHash: BIDS, memo: settlementMemo(id, BIDS),
  }).returning();
  return { row: row!, buyerProfile, sellerProfile, lot: lot!, show: show!, asset, id };
}
const reload = async (id: string) => (await db.select().from(schema.settlements).where(eq(schema.settlements.id, id)))[0]!;
const strikes = async (profileId: string) => (await db.select().from(schema.profiles).where(eq(schema.profiles.id, profileId)))[0]!;
const events = async (showId: string) => (await db.select().from(schema.showEvents).where(eq(schema.showEvents.showId, showId))).map((e) => e.kind);
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const signedBy = (prepared: { txBase64: string }, kp: Keypair) => Buffer.from(partySigns(bytes(prepared.txBase64), kp)).toString('base64');
const buyerKp = () => w.buyer;

/** The buyer of these rows is the world's funded buyer wallet. */
async function fundedSale(o: Parameters<typeof sale>[0] = {}) {
  const { buyer } = await world();
  return sale({ ...o, buyerProfile: buyer });
}

describe('happy path on Postgres and the real Core program', () => {
  it_('prepare, buyer signs, seller signs: the second signature adds SA, sends and settles', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    expect(p).toMatchObject({ attempt: 1, buyerSigned: false, sellerSigned: false });
    expect(p.expected.feePayer).toBe(w.sa.publicKey.toBase58());
    expect(p.expected.memo).toBe(settlementMemo(s.id, BIDS));
    expect(new Date(p.roundExpiresAt).getTime()).toBe(T0.getTime() + 60_000);

    const r1 = await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    expect(r1.step).toBe('awaiting_counterparty');
    expect(r1.settlement).toMatchObject({ buyerSigned: true, sellerSigned: false, role: 'buyer', status: 'awaiting_payment' });
    const seller0 = w.usdcOf(w.seller), fee0 = w.usdcOf(w.feeWallet), buyer0 = w.usdcOf(w.buyer);
    const r2 = await svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) });
    expect(r2.step).toBe('settled');
    expect(r2.settlement).toMatchObject({ status: 'settled', buyerSigned: true, sellerSigned: true, role: 'seller' });
    expect(r2.settlement.explorerUrl).toMatch(/explorer\.solana\.com\/tx\/.+\?cluster=devnet/);

    const row = await reload(s.id);
    expect(row).toMatchObject({ status: 'settled', buyerSignature: null, sellerSignature: null, failureCode: null });
    expect(row.txSignature).toBe(port.sent[0]);
    expect(row.settledAt).toEqual(clock);
    expect(row.usdValueAtTime).toBe('120.00');
    expect(w.ownerOf(new (await import('@solana/web3.js')).PublicKey(s.asset))).toBe(w.buyer.publicKey.toBase58());
    expect(w.usdcOf(w.seller) - seller0).toBe(117_000_000n);
    expect(w.usdcOf(w.feeWallet) - fee0).toBe(3_000_000n);
    expect(buyer0 - w.usdcOf(w.buyer)).toBe(120_000_000n);
    expect(await events(s.show.id)).toEqual(['settlement.submitted', 'settlement.settled']);
    expect(JSON.stringify(row.railState)).not.toMatch(/ignature/); // rail_state never holds signatures
  });

  it_('either signing order settles (seller first)', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.sellerProfile.id);
    expect((await svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) })).step).toBe('awaiting_counterparty');
    expect((await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) })).step).toBe('settled');
  });

  it_('house show: the server signs the seller leg at prepare; the buyer signs once', async () => {
    const houseProfile = await profile(w.houseSeller.publicKey.toBase58());
    const asset = w.consign('House lot', w.houseSeller).toBase58();
    const s = await fundedSale({ seller: w.houseSeller, sellerProfile: houseProfile, asset });
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    expect(p).toMatchObject({ buyerSigned: false, sellerSigned: true });
    const r = await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    expect(r.step).toBe('settled');
    expect(w.ownerOf(new (await import('@solana/web3.js')).PublicKey(asset))).toBe(w.buyer.publicKey.toBase58());
  });

  it_('prepare is idempotent inside a live round and the sweep (actor null) may call it', async () => {
    const s = await fundedSale();
    const a = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    advance(10);
    const b = await svc.prepareSettlement(s.id, null);
    const c = await svc.prepareSettlement(s.id, s.sellerProfile.id);
    expect(b.txBase64).toBe(a.txBase64);
    expect(c.txBase64).toBe(a.txBase64);
    expect(c.attempt).toBe(1);
  });

  it_('two signers racing: exactly one transaction is sent and the settlement settles once', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    const sent0 = port.sent.length;
    const [a, b] = await Promise.all([
      svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) }),
      svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) }),
    ]);
    expect([a.step, b.step].every((x) => x === 'settled' || x === 'submitted' || x === 'awaiting_counterparty')).toBe(true);
    expect(port.sent.length - sent0).toBe(1);
    expect((await svc.finalizeSettlement(s.id)).status).toBe('settled');
    const again = await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    expect(again.step).toBe('settled'); // idempotent after the fact, nothing re-sent
    expect(port.sent.length - sent0).toBe(1);
  });
});

describe('who may do what', () => {
  it_('a stranger gets not_party on prepare and sign; a party cannot sign as the other role', async () => {
    const s = await fundedSale();
    const stranger = await profile(Keypair.generate().publicKey.toBase58());
    await expect(svc.prepareSettlement(s.id, stranger.id)).rejects.toMatchObject({ code: 'not_party', status: 403 });
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await expect(svc.signSettlement(s.id, stranger.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) })).rejects.toMatchObject({ code: 'not_party' });
    await expect(svc.signSettlement(s.id, s.buyerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) })).rejects.toMatchObject({ code: 'not_party' });
    expect((await reload(s.id)).sellerSignature).toBeNull();
  });
  it_('unknown settlement is not_found', async () => {
    await expect(svc.prepareSettlement(uuid(), null)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('signature hygiene at signSettlement: nothing bad is stored', () => {
  it_('refuses a signature over a different amount, from the wrong key, and on a stale message', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    const other = buildUnsignedSettlementTx({ ...p.expected, gross: '119000000', platformFee: '2975000' }, w.svm.latestBlockhash());
    const otherAmount = Buffer.from(partySigns(other, w.seller)).toString('base64');
    await expect(svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: otherAmount })).rejects.toMatchObject({ code: 'tx_mismatch' });

    const t0 = Transaction.from(bytes(p.txBase64));
    t0.addSignature(w.seller.publicKey, Buffer.from(nacl.sign.detached(t0.serializeMessage(), w.attacker.secretKey)));
    const wrongKey = t0.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    await expect(svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: wrongKey })).rejects.toMatchObject({ code: 'bad_signature' });

    const stale = Buffer.from(partySigns(buildUnsignedSettlementTx(p.expected, '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi5'), w.seller)).toString('base64');
    await expect(svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: stale })).rejects.toMatchObject({ code: 'tx_mismatch' });

    const row = await reload(s.id);
    expect(row.sellerSignature).toBeNull();
    expect(row.buyerSignature).toBeNull();
  });
});

describe('funds and asset checks at prepare', () => {
  it_('an underfunded buyer gets insufficient_usdc and nothing changes', async () => {
    const s = await fundedSale({ gross: 5_000_000_000n });
    await expect(svc.prepareSettlement(s.id, s.buyerProfile.id)).rejects.toMatchObject({ code: 'insufficient_usdc', status: 409 });
    expect(await reload(s.id)).toMatchObject({ status: 'awaiting_payment', preparedMessage: null, attempt: 1 });
  });
  it_('balance RPC down: the error is balance_unavailable (503) and nothing changes', async () => {
    const s = await fundedSale();
    const real = port.getUsdcBalance;
    port.getUsdcBalance = async () => { throw new ApiError('balance_unavailable', 'try again'); };
    try { await expect(svc.prepareSettlement(s.id, null)).rejects.toMatchObject({ code: 'balance_unavailable', status: 503 }); } finally { port.getUsdcBalance = real; }
    expect((await reload(s.id)).status).toBe('awaiting_payment');
  });
  it_('the seller moved the card after the hammer: settlement failed, asset_not_ready, seller struck, bidders lose nothing', async () => {
    const s = await fundedSale();
    const u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(transferV1(u, { asset: umiPk(s.asset), collection: umiPk(w.collection.toBase58()), newOwner: umiPk(w.other.publicKey.toBase58()), authority: createNoopSigner(umiPk(w.seller.publicKey.toBase58())) }) as never), w.sa, [w.seller]);
    const buyer0 = w.usdcOf(w.buyer);
    await expect(svc.prepareSettlement(s.id, s.buyerProfile.id)).rejects.toMatchObject({ code: 'asset_not_ready' });
    expect(await reload(s.id)).toMatchObject({ status: 'failed', failureCode: 'asset_not_ready' });
    expect((await strikes(s.sellerProfile.id)).strikes).toBeGreaterThan(0);
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
  });
  it_('a moved card after both signed fails atomically on chain: simulation_failed, USDC untouched, the round stays recoverable', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    const u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(transferV1(u, { asset: umiPk(s.asset), collection: umiPk(w.collection.toBase58()), newOwner: umiPk(w.other.publicKey.toBase58()), authority: createNoopSigner(umiPk(w.seller.publicKey.toBase58())) }) as never), w.sa, [w.seller]);
    const buyer0 = w.usdcOf(w.buyer), sent0 = port.sent.length;
    const refused = await svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) }).catch((e) => e);
    expect(refused).toMatchObject({ code: 'simulation_failed' });
    expect(String(refused.message)).not.toMatch(/Program (log|[1-9A-HJ-NP-Za-km-z]{32,44} invoke)|lamports/i); // SEC: program logs (balances) stay in our log
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
    expect(port.sent.length).toBe(sent0);
    expect((await reload(s.id)).status).toBe('awaiting_payment');
    advance(61); // the round ends; the next prepare sees the card is gone
    await expect(svc.prepareSettlement(s.id, null)).rejects.toMatchObject({ code: 'asset_not_ready' });
    expect((await reload(s.id)).status).toBe('failed');
  });
  it_('a lot whose standard is not Core is rejected as unsupported_standard', async () => {
    const s = await fundedSale({ standard: 'pnft' });
    await expect(svc.prepareSettlement(s.id, null)).rejects.toMatchObject({ code: 'asset_not_ready' });
    expect(await reload(s.id)).toMatchObject({ status: 'failed', failureDetail: 'unsupported_standard' });
  });
});

describe('rounds', () => {
  it_('a round that ended unsigned drops the signature; attempt 2 starts with a fresh message and settles', async () => {
    const s = await fundedSale();
    const p1 = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p1, buyerKp()) });
    advance(61);
    // too late for the seller: the round has ended
    await expect(svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p1, w.seller) })).rejects.toMatchObject({ code: 'round_expired', status: 409 });
    port.expireRound();
    const p2 = await svc.prepareSettlement(s.id, s.sellerProfile.id);
    expect(p2.attempt).toBe(2);
    expect(p2.txBase64).not.toBe(p1.txBase64);
    expect(p2).toMatchObject({ buyerSigned: false, sellerSigned: false }); // the old buyer signature is gone
    expect((await reload(s.id)).buyerSignature).toBeNull();
    await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p2, buyerKp()) });
    expect((await svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p2, w.seller) })).step).toBe('settled');
    expect((await reload(s.id)).attempt).toBe(2);
  });
  it_('the chain height, not our clock, decides at send time: a dead blockhash is round_expired and is never sent', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    port.height += 1_000; // the chain moved on although our clock says the round is live
    const sent0 = port.sent.length;
    await expect(svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) })).rejects.toMatchObject({ code: 'round_expired' });
    expect(port.sent.length).toBe(sent0);
    expect(await reload(s.id)).toMatchObject({ status: 'awaiting_payment', buyerSignature: null, sellerSignature: null, failureCode: 'round_expired' });
    const p2 = await svc.prepareSettlement(s.id, null); // attempt 2 works
    expect(p2.attempt).toBe(2);
  });
  it_('the round length is min(60 s, blockhash validity)', async () => {
    const s = await fundedSale();
    const real = port.getLatestBlockhash;
    port.getLatestBlockhash = async () => ({ blockhash: w.svm.latestBlockhash(), lastValidBlockHeight: port.height + 50 }); // 50 blocks = 20 s
    try {
      const p = await svc.prepareSettlement(s.id, null);
      expect(new Date(p.roundExpiresAt).getTime() - T0.getTime()).toBe(20_000);
    } finally { port.getLatestBlockhash = real; }
  });
});

describe('finalize', () => {
  it_('an RPC that dies after accepting the transaction leaves it submitted; finalize settles it from the chain', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    port.dieAfterLanding = true;
    const r = await svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) });
    expect(r.step === 'settled' || r.step === 'submitted').toBe(true);
    expect((await svc.finalizeSettlement(s.id)).status).toBe('settled');
    expect((await svc.finalizeSettlement(s.id)).status).toBe('settled'); // idempotent
  });
  it_('a confirmed transaction whose balance changes do not match is failed, never settled', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    port.tamper = (tx) => ({ ...tx, meta: { ...tx.meta!, postTokenBalances: tx.meta!.postTokenBalances!.map((b) => (b.owner === w.feeWallet.publicKey.toBase58() ? { ...b, uiTokenAmount: { ...b.uiTokenAmount, amount: '0' } } : b)) } });
    try {
      await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
      await svc.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) });
    } finally { port.tamper = undefined; }
    expect(await reload(s.id)).toMatchObject({ status: 'failed', failureCode: 'delta_mismatch' });
  });
  it_('a submitted transaction that never landed and whose blockhash died returns to awaiting_payment', async () => {
    const s = await fundedSale();
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await db.update(schema.settlements).set({ status: 'submitted', txSignature: 'S'.repeat(88), buyerSignature: 'x', sellerSignature: 'y' }).where(eq(schema.settlements.id, s.id));
    expect((await svc.finalizeSettlement(s.id)).status).toBe('submitted'); // height not past lastValid yet
    port.height += 1_000;
    const v = await svc.finalizeSettlement(s.id);
    expect(v).toMatchObject({ status: 'awaiting_payment', attempt: p.attempt });
    expect(await reload(s.id)).toMatchObject({ txSignature: null, buyerSignature: null, sellerSignature: null });
  });
  it_('the same tx_signature can never be recorded twice', async () => {
    const a = await fundedSale(), b = await fundedSale();
    const sig = '5'.repeat(87);
    await db.update(schema.settlements).set({ txSignature: sig }).where(eq(schema.settlements.id, a.id));
    await expect(db.update(schema.settlements).set({ txSignature: sig }).where(eq(schema.settlements.id, b.id))).rejects.toThrow();
  });
});

describe('expiry and strikes', () => {
  it_('atFault: the party that was not there', () => {
    const now = new Date().toISOString();
    expect(atFault([])).toBe('buyer');
    expect(atFault([{ attempt: 1 }])).toBe('buyer');
    expect(atFault([{ attempt: 1, buyerSignedAt: now }])).toBe('seller');
    expect(atFault([{ attempt: 1, sellerSignedAt: now }])).toBe('buyer');
    expect(atFault([{ attempt: 1, buyerSignedAt: now }, { attempt: 2 }])).toBe('seller'); // the latest round with a signature decides
    expect(atFault([{ attempt: 1, buyerSignedAt: now, sellerSignedAt: now }, { attempt: 2, sellerSignedAt: now }])).toBe('buyer');
    expect(atFault([{ attempt: 1, buyerSignedAt: now, sellerSignedAt: now }])).toBeNull(); // both signed: nobody to blame
    expect(atFault([{ attempt: 1, buyerSignedAt: now, sellerSignedAt: now, fault: 'buyer' }])).toBe('buyer'); // unless the simulation proved the buyer could not pay
  });
  it_('buyer signed, seller did not: at due_at the settlement expires and the SELLER is struck', async () => {
    const s = await fundedSale({ dueInS: 120 });
    const p = await svc.prepareSettlement(s.id, s.buyerProfile.id);
    await svc.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    advance(121);
    expect(await svc.expireDue()).toBeGreaterThanOrEqual(1);
    expect(await reload(s.id)).toMatchObject({ status: 'expired', failureCode: 'expired', buyerSignature: null });
    expect((await strikes(s.sellerProfile.id)).strikes).toBeGreaterThan(0);
    expect((await strikes(s.buyerProfile.id)).strikes).toBe(0);
    expect(await events(s.show.id)).toContain('settlement.expired');
    expect(await svc.expireDue()).toBe(0); // idempotent
  });
  it_('nobody signed: the BUYER is struck; the 20th strike bans', async () => {
    const buyer = await profile(Keypair.generate().publicKey.toBase58());
    await db.update(schema.profiles).set({ strikes: 17 }).where(eq(schema.profiles.id, buyer.id)); // the three expiries below reach the limit of 20
    for (let i = 0; i < 3; i++) {
      const s = await sale({ buyerProfile: buyer, dueInS: 100 });
      clock = new Date(T0.getTime() + 101_000);
      expect(await svc.expireDue(clock)).toBeGreaterThanOrEqual(1);
      expect((await reload(s.id)).status).toBe('expired');
    }
    expect(await strikes(buyer.id)).toMatchObject({ strikes: 20, isBanned: true });
  });
  it_('the house seller is never struck', async () => {
    const houseProfile = (await db.select().from(schema.profiles).where(eq(schema.profiles.walletAddress, w.houseSeller.publicKey.toBase58())))[0] ?? (await profile(w.houseSeller.publicKey.toBase58()));
    const s = await fundedSale({ seller: w.houseSeller, sellerProfile: houseProfile, dueInS: 100 });
    await svc.prepareSettlement(s.id, s.buyerProfile.id); // house signs, the buyer never does
    // make the house look like the absent party to prove the guard: only the buyer signed would strike the seller
    await db.update(schema.settlements).set({ railState: { v: 1, rounds: [{ attempt: 1, buyerSignedAt: T0.toISOString() }] } }).where(eq(schema.settlements.id, s.id));
    clock = new Date(T0.getTime() + 101_000);
    await svc.expireDue(clock);
    expect((await strikes(houseProfile.id)).strikes).toBe(0);
  });
  it_('reading a settlement past due_at expires it lazily', async () => {
    const s = await fundedSale({ dueInS: 100 });
    clock = new Date(T0.getTime() + 101_000);
    expect((await svc.finalizeSettlement(s.id)).status).toBe('expired');
    await expect(svc.prepareSettlement(s.id, s.buyerProfile.id)).rejects.toMatchObject({ code: 'wrong_state' });
  });
  it_('prepare past due_at refuses and expires', async () => {
    const s = await fundedSale({ dueInS: 100 });
    clock = new Date(T0.getTime() + 101_000);
    await expect(svc.prepareSettlement(s.id, s.buyerProfile.id)).rejects.toMatchObject({ code: 'wrong_state' });
    expect((await reload(s.id)).status).toBe('expired');
  });
});

describe('guards', () => {
  it_('every chain write path fails closed: an incomplete mainnet configuration, or a sale of another network, is refused before any chain read', async () => {
    const strict = createSettlementService({
      db, chainFor: () => port, sa: w.sa, houseSeller: null, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), defaultCluster: 'devnet', now: () => clock,
    }); // no assertCluster override: the real guard, reading process.env
    const keys = ['SOLANA_CLUSTER', 'NEXT_PUBLIC_SOLANA_NETWORK', 'SOLANA_RPC_URL', 'SETTLEMENT_AUTHORITY_SECRET_KEY', 'PLATFORM_WALLET_ADDRESS', 'USDC_MINT'] as const;
    const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const reads0 = port.balanceReads;
    const sale = await fundedSale({ cluster: 'mainnet-beta' });
    const devnetSale = await fundedSale();
    try {
      for (const k of keys) delete process.env[k];
      // A mainnet sale on a deployment that serves devnet: another network, refused.
      await expect(strict.prepareSettlement(sale.id, null)).rejects.toMatchObject({ code: 'cluster_config_conflict' });
      await expect(strict.signSettlement(sale.id, sale.buyerProfile.id, { role: 'buyer', signedTxBase64: 'AAAA' })).rejects.toMatchObject({ code: 'cluster_config_conflict' });
      // The same sale on a deployment switched to mainnet but not set up for it: incomplete, refused.
      process.env.SOLANA_CLUSTER = 'mainnet-beta';
      await expect(strict.prepareSettlement(sale.id, null)).rejects.toMatchObject({ code: 'mainnet_config_incomplete' });
      await expect(strict.signSettlement(sale.id, sale.buyerProfile.id, { role: 'buyer', signedTxBase64: 'AAAA' })).rejects.toBeInstanceOf(ApiError);
      // A devnet sale on that mainnet deployment: refused too.
      await expect(strict.prepareSettlement(devnetSale.id, null)).rejects.toMatchObject({ code: 'mainnet_config_incomplete' });
    } finally {
      for (const k of keys) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
    }
    expect(port.balanceReads).toBe(reads0); // refused before any chain read
    expect((await reload(sale.id)).preparedMessage).toBeNull();
    expect((await reload(devnetSale.id)).preparedMessage).toBeNull();
  });
  it_('a settlement without a bid log hash is refused (ENGINE must write one)', async () => {
    const s = await fundedSale();
    await db.update(schema.settlements).set({ bidLogHash: null, memo: null }).where(eq(schema.settlements.id, s.id));
    await expect(svc.prepareSettlement(s.id, null)).rejects.toMatchObject({ code: 'wrong_state' });
  });
});

describe('consign readiness', () => {
  it_('a Core card owned by the seller is ready; once it moves it is rejected; a pNFT lot is rejected; not your lot is not_seller', async () => {
    const s = await fundedSale();
    // a sold lot keeps the flag it was opened with: the answer is given, the row is not changed
    expect(await svc.checkReadiness(s.lot.id, s.sellerProfile.id)).toEqual({ readiness: { eligible: true, reasons: [] }, consign: 'none' });
    expect((await db.select().from(schema.lots).where(eq(schema.lots.id, s.lot.id)))[0]!.consignStatus).toBe('none');
    await db.update(schema.lots).set({ state: 'catalogued' }).where(eq(schema.lots.id, s.lot.id));
    expect(await svc.checkReadiness(s.lot.id, s.sellerProfile.id)).toEqual({ readiness: { eligible: true, reasons: [] }, consign: 'ready' });
    expect((await db.select().from(schema.lots).where(eq(schema.lots.id, s.lot.id)))[0]!.consignStatus).toBe('ready');
    await expect(svc.checkReadiness(s.lot.id, s.buyerProfile.id)).rejects.toMatchObject({ code: 'not_seller' });
    await expect(svc.checkReadiness(uuid(), s.sellerProfile.id)).rejects.toMatchObject({ code: 'not_found' });

    const u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(transferV1(u, { asset: umiPk(s.asset), collection: umiPk(w.collection.toBase58()), newOwner: umiPk(w.other.publicKey.toBase58()), authority: createNoopSigner(umiPk(w.seller.publicKey.toBase58())) }) as never), w.sa, [w.seller]);
    expect(await svc.checkReadiness(s.lot.id, s.sellerProfile.id)).toEqual({ readiness: { eligible: false, reasons: ['not_owner'] }, consign: 'rejected' });

    const p = await fundedSale({ standard: 'pnft' });
    await db.update(schema.lots).set({ state: 'catalogued' }).where(eq(schema.lots.id, p.lot.id));
    expect(await svc.checkReadiness(p.lot.id, p.sellerProfile.id)).toEqual({ readiness: { eligible: false, reasons: ['unsupported_standard'] }, consign: 'rejected' });
  });
});

// Last on purpose: these two settle for real and spend from the funded buyer the tests above share.
describe('SA sponsorship budget', () => {
  beforeAll(() => { if (t) w.send([mintToIx(w.usdc, w.buyerAta, w.mintAuth.publicKey, 1_000_000_000n)], w.sa, [w.mintAuth]); }); // the shared buyer is nearly spent by now
  it_('SEC: SA sponsors a third-party settlement only inside its budget; a refused budget means SA signs and sends nothing; the house seller has a budget of its own', async () => {
    let calls = 0, open = true; const kinds: string[] = [];
    const guarded = createSettlementService({
      db, chainFor: () => port, sa: w.sa, houseSeller: w.houseSeller, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(),
      defaultCluster: 'devnet', now: () => clock, sleep: async () => { advance(1); }, assertCluster: () => undefined,
      spendGuard: async (kind) => { calls++; kinds.push(kind); if (!open) throw new ApiError('rate_limited', 'daily sponsorship budget used', { retryAfterS: 3600 }); },
    });
    const s = await fundedSale();
    const p = await guarded.prepareSettlement(s.id, s.buyerProfile.id);
    const sentBefore = port.sent.length;
    open = false;
    await guarded.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    await expect(guarded.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(calls).toBe(1);
    expect(port.sent.length).toBe(sentBefore); // nothing reached the chain
    expect((await reload(s.id)).status).toBe('awaiting_payment');
    open = true; // the budget frees up: the very same round now goes through (both signatures were kept)
    expect((await guarded.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) })).step).toBe('settled');

    expect(kinds).toEqual(['third-party', 'third-party']); // the refused attempt and the one that went through
    open = false; calls = 0; kinds.length = 0;
    const houseProfile = (await db.select().from(schema.profiles).where(eq(schema.profiles.walletAddress, w.houseSeller.publicKey.toBase58())))[0] ?? (await profile(w.houseSeller.publicKey.toBase58()));
    const hs = await fundedSale({ seller: w.houseSeller, sellerProfile: houseProfile, asset: w.consign('House budget lot', w.houseSeller).toBase58() });
    const hp = await guarded.prepareSettlement(hs.id, hs.buyerProfile.id);
    await expect(guarded.signSettlement(hs.id, hs.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(hp, buyerKp()) })).rejects.toMatchObject({ code: 'rate_limited' }); // a free pass would let faucet wallets buy the house room's lots until SA is empty
    expect(kinds).toEqual(['house']);
    open = true;
    expect((await guarded.signSettlement(hs.id, hs.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(hp, buyerKp()) })).step).toBe('settled');
  });
  it_('SEC: a transaction that fails simulation spends no sponsorship, and when both signed and nothing could be sent nobody is struck', async () => {
    let calls = 0;
    const guarded = createSettlementService({
      db, chainFor: () => port, sa: w.sa, houseSeller: w.houseSeller, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(),
      defaultCluster: 'devnet', now: () => clock, sleep: async () => { advance(1); }, assertCluster: () => undefined,
      spendGuard: async () => { calls++; },
    });
    const s = await fundedSale({ dueInS: 300 });
    const p = await guarded.prepareSettlement(s.id, s.buyerProfile.id);
    await guarded.signSettlement(s.id, s.buyerProfile.id, { role: 'buyer', signedTxBase64: signedBy(p, buyerKp()) });
    const u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(transferV1(u, { asset: umiPk(s.asset), collection: umiPk(w.collection.toBase58()), newOwner: umiPk(w.other.publicKey.toBase58()), authority: createNoopSigner(umiPk(w.seller.publicKey.toBase58())) }) as never), w.sa, [w.seller]);
    for (let i = 0; i < 3; i++) { // re-posting the signature over and over (what an attacker loop does) never reaches the budget
      await expect(guarded.signSettlement(s.id, s.sellerProfile.id, { role: 'seller', signedTxBase64: signedBy(p, w.seller) })).rejects.toMatchObject({ code: 'simulation_failed' });
    }
    expect(calls).toBe(0);
    advance(301);
    expect(await guarded.expireDue()).toBeGreaterThanOrEqual(1);
    expect(await reload(s.id)).toMatchObject({ status: 'expired' });
    // both signed: the platform or the chain failed, not a party (the shared buyer profile may carry strikes of other tests, so read the audit log of THIS settlement)
    const struck = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'strike'))).filter((a) => (a.detail as { settlementId?: string } | null)?.settlementId === s.id);
    expect(struck).toHaveLength(0);
  });
  it_('SEC: sponsorBudgetGuard reads SA_THIRD_PARTY_SETTLEMENTS_PER_DAY and refuses past it with a 429', async () => {
    const { sponsorBudgetGuard, DEFAULT_THIRD_PARTY_SETTLEMENTS_PER_DAY } = await import('../service');
    expect(DEFAULT_THIRD_PARTY_SETTLEMENTS_PER_DAY).toBeLessThanOrEqual(50);
    expect((await import('../service')).DEFAULT_HOUSE_SETTLEMENTS_PER_DAY).toBeLessThanOrEqual(150);
    const prev = process.env.DATABASE_URL; process.env.DATABASE_URL = t!.url;
    try {
      vi.resetModules();
      const fresh = await import('../service');
      const env = { SA_THIRD_PARTY_SETTLEMENTS_PER_DAY: '2' };
      await fresh.sponsorBudgetGuard(env); await fresh.sponsorBudgetGuard(env);
      await expect(fresh.sponsorBudgetGuard(env)).rejects.toMatchObject({ code: 'rate_limited' });
      await t!.pool.query(`delete from rate_limits where key = 'g:sa-third-party-settlement'`);
      const house = { SA_HOUSE_SETTLEMENTS_PER_DAY: '1' };
      await fresh.sponsorBudgetGuard(house, 'house');
      await expect(fresh.sponsorBudgetGuard(house, 'house')).rejects.toMatchObject({ code: 'rate_limited' });
      await fresh.sponsorBudgetGuard(env, 'third-party').catch(() => undefined); // the two budgets are separate counters
      await t!.pool.query(`delete from rate_limits where key in ('g:sa-house-settlement', 'g:sa-third-party-settlement')`);
    } finally { if (prev === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = prev; }
    void sponsorBudgetGuard;
  });
});
