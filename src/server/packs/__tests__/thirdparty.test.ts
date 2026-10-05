/**
 * A14: the chance pack of a THIRD-PARTY operator. The buyer pays the OPERATOR directly (nothing is received by a platform wallet), the draw runs only after that
 * payment is finalized, and the OPERATOR signs the delivery of the drawn card before a deadline. The platform holds no money, so it never refunds: a draw that is
 * not delivered is `undelivered`, strikes the operator and pauses the pack.
 *
 * Runs on a REAL Postgres 18 (embedded), the REAL Core and token programs (LiteSVM) and the REAL ECVRF library, for BOTH clusters (a test USDC mint on devnet, the
 * real mainnet USDC address on mainnet). No network, no Neon, no real key, no transaction on any cluster.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, eq, sql } from 'drizzle-orm';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha2';
import * as schema from '@/db/schema';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ApiError, PackCreateRequest, PackDrawView, PackOpenResponse, type Cluster, type PackPayExpected } from '@/contracts';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { ChainError } from '@/lib/chain/errors';
import { ataAddress, createAtaIdempotentIx, mintToIx, TOKEN_PROGRAM_ID } from '@/lib/chain/ix';
import { buildUnsignedPayTx } from '@/lib/chain/pack-pay-tx';
import { partySigns } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import { generateVrfKey } from '@/lib/vrf/key';
import { isPackProven, verifyPackDraw, type EarlierDraw, type ProofDraw, type ProofPool } from '@/lib/packs';
import type { VrfRpc } from '@/lib/vrf';
import { createPackService, type PackDeps, type PackService } from '../service';
import { createPackWorld, type PackWorld } from './pack-world';

type Db = PackDeps['db'];
let t: TestPg | undefined, skipReason: string | undefined, db: Db;
const T0 = new Date('2026-11-05T12:00:00.000Z');
let clock = T0;
const advance = (s: number) => { clock = new Date(clock.getTime() + s * 1000); };
const vrf = generateVrfKey().key;
const beaconHash = bs58.encode(sha512(new TextEncoder().encode('anchor-3p')).slice(0, 32));
const hashAt = (slot: number) => bs58.encode(sha512(new TextEncoder().encode(`after3p-${slot}`)).slice(0, 32));
const DEADLINE_S = 3600;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  db = drizzle(t.pool, { schema }) as unknown as Db;
}, 120_000);
afterAll(async () => { await new Promise((r) => setTimeout(r, 200)); await t?.stop(); });
afterEach(() => vi.restoreAllMocks());
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 60_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

let n = 0;
const profile = async (wallet: string, o: Partial<typeof schema.profiles.$inferInsert> = {}) => (await db.insert(schema.profiles).values({ walletAddress: wallet, ...o }).onConflictDoUpdate({ target: schema.profiles.walletAddress, set: { updatedAt: new Date(), ...o } }).returning())[0]!;
const seed = () => (++n).toString(16).padStart(32, 'e');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected the call to fail'); };
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TIERS = [{ tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 7000 }, { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 3000 }];

describe.each([['devnet'], ['mainnet-beta']] as const)('third-party chance packs on %s', (cluster: Cluster) => {
  let w: PackWorld, port: SvmPort, chain: SvmPort, svc: PackService, buyerP: typeof schema.profiles.$inferSelect, opP: typeof schema.profiles.$inferSelect;
  const watched: string[] = [];
  const spend: string[] = [];
  const drawnHook: string[] = [];
  const minted: string[] = []; // the demo copy mint: a third-party draw must never reach it
  const dueHook: string[] = [];
  const ctl = { beaconReady: true, dropSends: false, spendFails: false, readAssetOwnerOverride: null as null | { asset: string; owner: string } };

  beforeAll(async () => {
    if (!t) return;
    w = createPackWorld(cluster);
    port = createSvmPort(w, () => watched);
    chain = {
      ...port,
      async send(b: string) {
        if (ctl.dropSends) return bs58.encode(Transaction.from(Buffer.from(b, 'base64')).signatures[0]!.signature!);
        return port.send(b);
      },
      async readAsset(mint: string) {
        const info = await port.readAsset(mint);
        return info && ctl.readAssetOwnerOverride?.asset === mint ? { ...info, owner: ctl.readAssetOwnerOverride.owner } : info;
      },
    } as SvmPort;
    svc = createPackService({
      db, chainFor: () => chain, sa: w.sa, houseOperator: w.houseSeller, vrfKey: () => vrf, beacon: async () => ({ slot: 424_242_424, blockhash: beaconHash }), usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250,
      defaultCluster: cluster, now: () => clock, sleep: async () => { advance(1); }, assertCluster: () => undefined, deliveryDeadlineS: DEADLINE_S,
      spendGuard: async (k) => { if (ctl.spendFails && k === 'third-party') throw new ApiError('rate_limited', 'the daily sponsorship budget is used up'); spend.push(k); },
      beaconAfter: async (_c, slot) => (ctl.beaconReady ? { slot: slot + 1, blockhash: hashAt(slot + 1) } : null),
      onDrawn: (id) => { drawnHook.push(id); }, onDeliveryDue: (id) => { dueHook.push(id); },
      mintDemoCopy: async (i) => { minted.push(i.source); return null; },
    });
    buyerP = await profile(w.buyer.publicKey.toBase58());
    opP = await profile(w.seller.publicKey.toBase58(), { isSeller: true });
  }, 60_000);

  const actor = (p: { id: string; walletAddress: string }) => ({ id: p.id, wallet: p.walletAddress });
  const topUp = (kp: Keypair, amount: bigint) => {
    const ata = ataAddress(w.usdc, kp.publicKey);
    w.send([createAtaIdempotentIx(w.sa.publicKey, ata, kp.publicKey, w.usdc), mintToIx(w.usdc, ata, w.mintAuth.publicKey, amount + BigInt(++n))], w.sa, [w.mintAuth]);
  };
  async function fundedWallet(amount = 100_000_000n) {
    const k = Keypair.generate();
    topUp(k, amount);
    watched.push(k.publicKey.toBase58());
    return { k, p: await profile(k.publicKey.toBase58()) };
  }
  /** A fresh operator (own wallet, own profile, own record) so strikes and records of one test never touch another. */
  async function freshOperator() {
    const k = Keypair.generate();
    watched.push(k.publicKey.toBase58());
    return { k, p: await profile(k.publicKey.toBase58(), { isSeller: true }) };
  }
  /** A live third-party chance pack of `count` real Core cards owned by the operator (two tiers from 3 cards on). */
  async function pack(count = 6, o: { cap?: number; price?: string; op?: { k: Keypair; p: typeof schema.profiles.$inferSelect } } = {}) {
    const k = o.op?.k ?? w.seller, p = o.op?.p ?? opP;
    const assets = Array.from({ length: count }, (_, i) => w.consign(`3P card ${++n}-${i}`, k));
    const view = await svc.create(actor(p), PackCreateRequest.parse({
      name: { de: 'Betreiberpack', en: 'Operator pack' }, mode: 'chance', price: o.price ?? '10000000', perWalletDailyCap: o.cap ?? 5, odds: count < 3 ? [{ ...TIERS[0]!, bps: 10000 }] : TIERS,
      cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: count >= 3 && i % 3 === 2 ? 'rare' : 'common', name: `Card ${i + 1}`, listedValue: String(25_000_000 + i * 1_000_000) })),
    }));
    const live = await svc.control(view.id, p.id, 'publish');
    return { id: live.id, assets, view: live, k, p };
  }
  const open = (packId: string, p = buyerP) => svc.open(actor(p), packId, { clientSeed: seed(), ageConfirmed: true });
  const pay = (o: PackOpenResponse, p = buyerP, k: Keypair = w.buyer) => svc.signDraw(o.draw.id, p.id, { role: 'buyer', signedTxBase64: b64(partySigns(bytes(o.payment.txBase64), k)) });
  /** What the operator's manage page does: asks for the delivery to sign, signs it in the wallet, posts the signature. */
  const deliver = async (id: string, op: { k: Keypair; p: typeof schema.profiles.$inferSelect } = { k: w.seller, p: opP }) => {
    const prep = await svc.prepareDraw(id, op.p.id);
    return svc.signDraw(id, op.p.id, { role: 'seller', signedTxBase64: b64(partySigns(bytes(prep.txBase64), op.k)) });
  };
  const rowOf = async (id: string) => (await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, id)))[0]!;
  const actions = async (id: string) => (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.target, id)).orderBy(asc(schema.auditLogs.createdAt))).map((a) => a.action.replace('pack.draw.', ''));
  const profileOf = async (id: string) => (await db.select().from(schema.profiles).where(eq(schema.profiles.id, id)))[0]!;
  const packRow = async (id: string) => (await db.select().from(schema.packDefinitions).where(eq(schema.packDefinitions.id, id)))[0]!;
  const cardRows = async (packId: string) => db.select().from(schema.packPoolCards).where(eq(schema.packPoolCards.packId, packId));
  const owner = (asset: string) => w.ownerOf(new PublicKey(asset));
  /** The operator sends the card away (a real Core transfer by the owner). */
  async function moveAway(asset: string, from: Keypair = w.seller) {
    const { transferV1 } = await import('@metaplex-foundation/mpl-core');
    const { createNoopSigner, publicKey: umiPk } = await import('@metaplex-foundation/umi');
    const u = w.umiFor(w.sa.publicKey);
    const ix = w.ixs(transferV1(u, { asset: { publicKey: umiPk(asset) } as never, collection: { publicKey: umiPk(w.collection.toBase58()) } as never, authority: createNoopSigner(umiPk(from.publicKey.toBase58())), newOwner: umiPk(w.attacker.publicKey.toBase58()) }) as never);
    w.send(ix, w.sa, [from]);
  }
  const rpcFor = (row: typeof schema.packDraws.$inferSelect): VrfRpc => ({
    getTx: async () => ({ slot: row.paymentSlot!, blockTime: null, failed: false, signers: [row.buyerWallet], memos: [row.settlementRef!] }),
    getBlocks: async (a, b) => (a <= b ? [a] : []),
    getBlockhash: async (slot) => hashAt(slot),
    getSignatures: async () => [],
  });
  async function proofOf(drawId: string, rpc?: VrfRpc) {
    const view = await svc.getDraw(drawId);
    const detail = await svc.detail(view.packId, null);
    const log = await svc.listDraws(view.packId, { limit: 100 });
    const pool: ProofPool = { mode: detail.pack.mode, cluster, price: detail.pack.price, operator: detail.pack.operator.wallet, odds: detail.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })), cards: detail.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })), poolHash: detail.pack.commitment.poolHash!, removed: detail.cards.filter((c) => c.status === 'removed').map((c) => c.position) };
    const draw: ProofDraw = { id: view.id, packId: view.packId, drawIndex: view.drawIndex, flow: view.flow, buyer: view.buyer, clientSeed: view.clientSeed, poolHash: view.poolHash, status: view.status, tier: view.tier, cardAsset: view.card?.asset ?? null, vrf: { requestId: view.vrf.requestId, input: view.vrf.input, proofHex: view.vrf.proofHex, outputHex: view.vrf.outputHex, params: view.vrf.params ?? null, paramsHash: view.vrf.paramsHash ?? null, beacon: view.vrf.beacon ?? null, publicKey: view.vrf.publicKey ?? null } };
    const earlier: EarlierDraw[] = log.draws.filter((d) => d.drawIndex !== null && view.drawIndex !== null && d.drawIndex < view.drawIndex).map((d) => ({ drawIndex: d.drawIndex!, status: d.status, cardAsset: d.card?.asset ?? null, paymentSlot: d.paymentSlot ?? null, paymentSignature: d.txSignature }));
    return { view, pool, draw, checks: await verifyPackDraw(pool, draw, { earlier, ...(rpc ? { rpc } : {}) }) };
  }

  it_('PAY FIRST to the OPERATOR: the platform receives nothing but its fee leg; every destination of every instruction is the operator or the fee wallet; the card is drawn after, hidden, and delivered by the operator', async () => {
    const p = await pack(6);
    const bal = () => ({ buyer: w.usdcOf(w.buyer), op: w.usdcOf(w.seller), fee: w.usdcOf(w.feeWallet), house: w.usdcOf(w.houseSeller), sa: w.usdcOf(w.sa) });
    const b0 = bal(), sent0 = port.sent.length;
    const opened = await open(p.id);
    expect(PackOpenResponse.parse(opened).draw).toMatchObject({ status: 'awaiting_payment', flow: 'pay_first', drawIndex: null, revealed: false, tier: null, card: null, operator: { wallet: w.seller.publicKey.toBase58(), isHouse: false } });
    const exp = opened.payment.expected as PackPayExpected;
    expect(exp).toMatchObject({ cluster, operator: w.seller.publicKey.toBase58(), buyer: w.buyer.publicKey.toBase58(), usdcMint: cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : w.usdc.toBase58(), gross: '10000000', platformFee: '250000', feeWallet: w.feeWallet.publicKey.toBase58(), feePayer: w.sa.publicKey.toBase58() });
    expect(exp.memo).toBe(`hp:pack:${opened.draw.id}:${p.view.commitment.poolHash}`);
    expect(bal()).toEqual(b0); // nothing moved yet

    // every instruction of the payment, decoded: where can the money go?
    const tx = Transaction.from(bytes(opened.payment.txBase64));
    const operatorAta = ataAddress(w.usdc, w.seller.publicKey).toBase58(), feeAta = ataAddress(w.usdc, w.feeWallet.publicKey).toBase58(), buyerAta = ataAddress(w.usdc, w.buyer.publicKey).toBase58();
    const TOKEN = TOKEN_PROGRAM_ID.toBase58();
    const transfers = tx.instructions.filter((i) => i.programId.toBase58() === TOKEN);
    expect(transfers).toHaveLength(2); // the operator's share and the fee leg, nothing else
    const destinations = transfers.map((i) => i.keys[2]!.pubkey.toBase58()).sort();
    expect(destinations).toEqual([operatorAta, feeAta].sort());
    for (const i of transfers) { expect(i.keys[0]!.pubkey.toBase58()).toBe(buyerAta); expect(i.keys[3]!.pubkey.toBase58()).toBe(w.buyer.publicKey.toBase58()); } // only the buyer pays, from their own account
    const creates = tx.instructions.filter((i) => i.programId.toBase58() === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    for (const c of creates) expect([w.seller.publicKey.toBase58(), w.feeWallet.publicKey.toBase58()]).toContain(c.keys[2]!.pubkey.toBase58()); // only the operator's and the fee wallet's accounts are created
    const everyKey = new Set(tx.compileMessage().accountKeys.map(String));
    for (const platform of [w.houseSeller, w.sa]) expect(everyKey.has(ataAddress(w.usdc, platform.publicKey).toBase58()), `the platform account ${platform.publicKey.toBase58()} appears`).toBe(false);
    expect(everyKey.has(w.houseSeller.publicKey.toBase58())).toBe(false);
    expect(tx.instructions.some((i) => i.programId.toBase58() === CORE)).toBe(false); // no card in it
    expect(tx.compileMessage().header.numRequiredSignatures).toBe(2); // fee payer and the buyer only: the operator does not even sign the payment

    const r = await pay(opened);
    expect(r.step).toBe('submitted'); // paid and drawn; now it waits for the operator
    const view = PackDrawView.parse(r.draw);
    expect(view).toMatchObject({ status: 'drawn', flow: 'pay_first', revealed: false, card: null, tier: null, drawIndex: 0 });
    expect(view.deliverBy).toBe(new Date(clock.getTime() + DEADLINE_S * 1000).toISOString());
    expect(view.vrf).toMatchObject({ requestId: null, input: null, proofHex: null }); // hidden until the card is delivered
    const b1 = bal();
    expect(b0.buyer - b1.buyer).toBe(10_000_000n);
    expect(b1.op - b0.op).toBe(9_750_000n); // the operator is paid the price less the fee, directly
    expect(b1.fee - b0.fee).toBe(250_000n);
    expect(b1.house).toBe(b0.house); // the platform's own wallets received nothing
    expect(b1.sa).toBe(b0.sa);
    expect(port.sent.slice(sent0)).toHaveLength(1); // ONE transaction: the payment. Nothing else the platform could send for the operator
    expect(drawnHook).toContain(opened.draw.id); // the operator is notified
    const row = await rowOf(opened.draw.id);
    expect(row).toMatchObject({ status: 'drawn', deliverySignature: null, serverTx: null });
    expect(await actions(opened.draw.id)).toEqual(['awaiting_payment', 'confirming', 'paid', 'drawn']);
    // the card is still the operator's and reserved; the buyer's page does not know it
    expect(owner(row.asset!)).toBe(w.seller.publicKey.toBase58());
    expect((await svc.listDraws(p.id)).draws[0]).toMatchObject({ id: opened.draw.id, card: null, tier: null, revealed: false });
    // the operator delivers: THEIR signature, the platform only pays the fee
    const done = await deliver(opened.draw.id);
    expect(done.step).toBe('settled');
    expect(owner(row.asset!)).toBe(w.buyer.publicKey.toBase58());
    expect(spend).toContain('third-party');
    const after = PackDrawView.parse(done.draw);
    expect(after).toMatchObject({ status: 'settled', revealed: true, drawIndex: 0 });
    expect(after.card!.asset).toBe(row.asset);
    expect(port.sent.slice(sent0)).toHaveLength(2);
    expect(bal().house).toBe(b0.house); // still nothing for the platform
    expect(await actions(opened.draw.id)).toEqual(['awaiting_payment', 'confirming', 'paid', 'drawn', 'delivering', 'settled']);
    const { checks } = await proofOf(opened.draw.id, rpcFor(await rowOf(opened.draw.id)));
    expect(Object.fromEntries(checks.map((c) => [c.id, c.status])), JSON.stringify(checks)).toMatchObject({ pool_hash: 'pass', params: 'pass', alpha: 'pass', proof: 'pass', output: 'pass', result: 'pass', taken: 'pass', beacon: 'pass', payment: 'pass', order: 'pass' });
    expect(isPackProven(checks)).toBe(true);
    // the operator's public record
    const rec = (await svc.detail(p.id, null)).pack.operatorRecord!;
    expect(rec).toMatchObject({ delivered: 1, late: 0, undelivered: 0 });
    expect(rec.medianDeliverySeconds).toBeGreaterThanOrEqual(0);
  });

  it_('NO CARD before the payment is final: api, transaction bytes, vrf rows, audit rows and logs carry no card; a confirmed payment is not enough', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const p = await pack(6);
    const assets = p.assets.map(String);
    const opened = await open(p.id);
    const again = await svc.prepareDraw(opened.draw.id, buyerP.id);
    const text = JSON.stringify({ opened, again, got: await svc.getDraw(opened.draw.id), log: await svc.listDraws(p.id), detail: await svc.detail(p.id, null) }).replace(/"asset":"[^"]+"/g, '"asset":"pool"');
    // the public pool lists the assets by design (it is committed before the first sale); what must not appear is a link to THIS purchase
    expect((await svc.getDraw(opened.draw.id))).toMatchObject({ status: 'awaiting_payment', revealed: false, card: null, tier: null, drawIndex: null });
    expect(text).not.toContain(opened.draw.id + '"card"');
    const row0 = await rowOf(opened.draw.id);
    expect(row0).toMatchObject({ cardId: null, asset: null, tier: null, vrfRequestId: null, drawIndex: null, paymentSlot: null });
    expect(await db.select().from(schema.vrfRequests).where(eq(schema.vrfRequests.subjectId, opened.draw.id))).toEqual([]);
    expect((await cardRows(p.id)).every((c) => c.status === 'available')).toBe(true); // an unpaid attempt reserves nothing
    const txBytes = Buffer.from(opened.payment.txBase64, 'base64');
    for (const a of assets) expect(txBytes.includes(new PublicKey(a).toBuffer())).toBe(false);
    // confirmed but not finalized: nothing is drawn
    port.holdFinality = true;
    const r = await pay(opened);
    expect(r.draw).toMatchObject({ status: 'confirming', card: null, tier: null });
    expect(await rowOf(opened.draw.id)).toMatchObject({ status: 'confirming', cardId: null, asset: null, vrfRequestId: null, drawIndex: null });
    for (let i = 0; i < 3; i++) expect((await svc.getDraw(opened.draw.id)).status).toBe('confirming');
    port.holdFinality = false;
    expect((await svc.getDraw(opened.draw.id)).status).toBe('drawn');
    // the audit rows and the logs of the unpaid phase never named a card
    const audit = JSON.stringify((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.target, opened.draw.id))).filter((a) => ['awaiting_payment', 'confirming', 'paid'].some((s) => a.action === `pack.draw.${s}`)));
    for (const a of assets) { expect(audit).not.toContain(a); expect(logs.join('\n')).not.toContain(a); }
    await deliver(opened.draw.id);
  });

  it_('the draw waits for the first block after the payment, and for any payment of the pack that is still confirming (the order of the draws is the order of the payments, not of the polls)', async () => {
    const p = await pack(5);
    const b = await fundedWallet();
    const oa = await open(p.id), ob = await open(p.id, b.p);
    // B's payment is swallowed by the node: confirming
    ctl.dropSends = true;
    expect((await pay(ob, b.p, b.k)).draw.status).toBe('confirming');
    ctl.dropSends = false;
    // A's payment lands, but no beacon yet: paid, not drawn
    ctl.beaconReady = false;
    expect((await pay(oa)).draw.status).toBe('paid');
    ctl.beaconReady = true;
    advance(10);
    // the beacon is there, but B (earlier, unknown slot) is still confirming: A is NOT drawn yet
    expect((await svc.getDraw(oa.draw.id)).status).toBe('paid');
    expect(await rowOf(oa.draw.id)).toMatchObject({ drawIndex: null, cardId: null });
    // B's transaction can no longer land: it reopens, and A is drawn
    port.expireRound();
    expect((await svc.getDraw(ob.draw.id)).status).toBe('awaiting_payment');
    advance(10);
    const a = await svc.getDraw(oa.draw.id);
    expect(a).toMatchObject({ status: 'drawn', drawIndex: 0 });
    const row = await rowOf(oa.draw.id);
    expect(row.paymentSlot).toBeGreaterThan(0);
    await deliver(oa.draw.id);
    const { view } = await proofOf(oa.draw.id);
    expect(view.vrf.beacon!.slot).toBe(row.paymentSlot! + 1); // the first block after the payment
  });

  it_('DEADLINE passes: undelivered, ONE strike, the pack pauses, nobody else can buy, the buyer sees the operator, the payment and the proof; resume only after the open sale is delivered (late delivery works and is on the record)', async () => {
    const op = await freshOperator();
    const p = await pack(5, { op });
    const opened = await open(p.id);
    const paid = await pay(opened);
    expect(paid.draw.status).toBe('drawn');
    const bal = w.usdcOf(op.k);
    // the operator is reminded when the deadline is close, once per read
    advance(DEADLINE_S - 600);
    await svc.getDraw(opened.draw.id);
    expect(dueHook).toContain(opened.draw.id);
    advance(700);
    const v = await svc.getDraw(opened.draw.id);
    expect(v).toMatchObject({ status: 'undelivered', undeliveredReason: 'deadline', revealed: true, operator: { wallet: op.k.publicKey.toBase58(), isHouse: false } });
    expect(v.undeliveredAt).not.toBeNull();
    expect(v.txSignature).toBe((await rowOf(opened.draw.id)).txSignature); // the payment signature
    expect(v.card).not.toBeNull(); // the draw is proven and shown so the buyer can claim against the operator
    expect(v.vrf.proofHex).toMatch(/^[0-9a-f]{160}$/);
    expect(w.usdcOf(op.k)).toBe(bal); // and it moved none
    expect((await profileOf(op.p.id)).strikes).toBe(1);
    expect((await packRow(p.id)).status).toBe('paused');
    expect((await svc.detail(p.id, null)).pack.operatorRecord).toMatchObject({ delivered: 0, undelivered: 1 });
    expect(await actions(opened.draw.id)).toEqual(expect.arrayContaining(['undelivered']));
    // paused: nobody can buy; the operator's OTHER packs are blocked too while a sale is overdue
    expect((await err(open(p.id, (await fundedWallet()).p))).code).toBe('wrong_state');
    const other = await pack(4, { op });
    await svc.control(other.id, op.p.id, 'pause').catch(() => undefined);
    expect((await err(svc.control(other.id, op.p.id, 'resume'))).code).toBe('wrong_state');
    expect((await err(svc.control(p.id, op.p.id, 'resume'))).code).toBe('wrong_state'); // not before the open sale is delivered
    // the buyer cannot deliver, and a stranger neither
    expect((await err(svc.prepareDraw(opened.draw.id, buyerP.id))).code).toBe('wrong_state');
    // the operator delivers LATE: it still works
    const late = await deliver(opened.draw.id, op);
    expect(late.step).toBe('settled');
    expect(owner((await rowOf(opened.draw.id)).asset!)).toBe(w.buyer.publicKey.toBase58());
    expect(await svc.getDraw(opened.draw.id)).toMatchObject({ status: 'settled', undeliveredReason: 'deadline' });
    expect((await svc.detail(p.id, null)).pack.operatorRecord).toMatchObject({ delivered: 1, late: 1, undelivered: 0 });
    expect((await profileOf(op.p.id)).strikes).toBe(1); // the strike stays
    expect((await svc.control(p.id, op.p.id, 'resume')).status).toBe('live');
    expect((await svc.control(other.id, op.p.id, 'resume')).status).toBe('live');
  });

  it_('one incident is one strike: several sales overdue at once cost the operator one strike, and the 20th strike bans', async () => {
    const op = await freshOperator();
    const p = await pack(6, { op, cap: 5 });
    const a = await fundedWallet(), b = await fundedWallet();
    const oa = await open(p.id, a.p), ob = await open(p.id, b.p);
    await pay(oa, a.p, a.k); await pay(ob, b.p, b.k);
    advance(DEADLINE_S + 5);
    await svc.sweep(clock);
    expect((await svc.getDraw(oa.draw.id)).status).toBe('undelivered');
    expect((await svc.getDraw(ob.draw.id)).status).toBe('undelivered');
    expect((await profileOf(op.p.id)).strikes).toBe(1);
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'pack.strike.skipped'))).length).toBeGreaterThanOrEqual(1);
    // a later incident, outside the window: another strike; 19 strikes already on file make the 20th a ban
    await db.update(schema.profiles).set({ strikes: 19 }).where(eq(schema.profiles.id, op.p.id));
    await deliver(oa.draw.id, op); await deliver(ob.draw.id, op);
    await svc.control(p.id, op.p.id, 'resume');
    advance(DEADLINE_S + 5);
    const c = await fundedWallet();
    const oc = await open(p.id, c.p);
    await pay(oc, c.p, c.k);
    advance(DEADLINE_S + 5);
    expect((await svc.getDraw(oc.draw.id)).status).toBe('undelivered');
    const banned = await profileOf(op.p.id);
    expect(banned).toMatchObject({ strikes: 20, isBanned: true });
    // a banned operator sells nothing
    await db.update(schema.packDefinitions).set({ status: 'live' }).where(eq(schema.packDefinitions.id, p.id));
    await deliver(oc.draw.id, op).catch(() => undefined);
    expect((await err(open(p.id, (await fundedWallet()).p))).code).toBe('paused');
  });

  it_('an honest operator is not struck for the platform\'s failure: if the platform could not send the delivery they signed, the deadline marks it undelivered but costs no strike', async () => {
    const op = await freshOperator();
    const p = await pack(4, { op });
    const opened = await open(p.id);
    await pay(opened);
    ctl.spendFails = true; // the daily sponsorship budget is used up: the platform cannot pay the fee
    const prep = await svc.prepareDraw(opened.draw.id, op.p.id);
    expect((await err(svc.signDraw(opened.draw.id, op.p.id, { role: 'seller', signedTxBase64: b64(partySigns(bytes(prep.txBase64), op.k)) }))).code).toBe('rate_limited');
    ctl.spendFails = false;
    expect(await rowOf(opened.draw.id)).toMatchObject({ status: 'drawn', failureCode: 'delivery_platform_fault' });
    advance(DEADLINE_S + 5);
    expect((await svc.getDraw(opened.draw.id)).status).toBe('undelivered'); // the buyer must see it is not delivered
    expect((await profileOf(op.p.id)).strikes).toBe(0);
    expect((await deliver(opened.draw.id, op)).step).toBe('settled');
  });

  it_('the operator VOIDS a draw by moving the card away: undelivered at once, a strike, the card leaves the pool, the pack pauses, it can not be delivered, and the draw still proves', async () => {
    const op = await freshOperator();
    const p = await pack(4, { op });
    const opened = await open(p.id);
    await pay(opened);
    const row = await rowOf(opened.draw.id);
    await moveAway(row.asset!, op.k);
    advance(WATCH_ADVANCE);
    const v = await svc.getDraw(opened.draw.id);
    expect(v).toMatchObject({ status: 'undelivered', undeliveredReason: 'asset_moved', revealed: true });
    expect((await profileOf(op.p.id)).strikes).toBe(1);
    expect((await packRow(p.id)).status).toBe('paused');
    expect((await cardRows(p.id)).find((c) => c.asset === row.asset)!.status).toBe('removed');
    expect((await svc.detail(p.id, null)).pack.operatorRecord).toMatchObject({ undelivered: 1, delivered: 0 });
    expect((await err(svc.prepareDraw(opened.draw.id, op.p.id))).code).toBe('wrong_state');
    expect(w.usdcOf(w.houseSeller)).toBe(0n);
    // nothing in the draw was re-rolled: it recomputes and the removed card is excluded without evidence
    const { checks } = await proofOf(opened.draw.id, rpcFor(await rowOf(opened.draw.id)));
    expect(isPackProven(checks), JSON.stringify(checks)).toBe(true);
    // nothing deliverable is open, so the operator may resume (the strike is the price); the pack keeps selling the cards that are left
    expect((await svc.control(p.id, op.p.id, 'resume')).status).toBe('live');
  });

  it_('a card moved away between the delivery request and the signature voids the draw too, and the platform sends nothing', async () => {
    const op = await freshOperator();
    const p = await pack(4, { op });
    const opened = await open(p.id);
    await pay(opened);
    const prep = await svc.prepareDraw(opened.draw.id, op.p.id);
    const asset = (await rowOf(opened.draw.id)).asset!;
    await moveAway(asset, op.k);
    const sent = port.sent.length;
    expect((await err(svc.signDraw(opened.draw.id, op.p.id, { role: 'seller', signedTxBase64: b64(partySigns(bytes(prep.txBase64), op.k)) }))).code).toBe('asset_not_ready');
    expect(port.sent.length).toBe(sent);
    expect(await rowOf(opened.draw.id)).toMatchObject({ status: 'undelivered', undeliveredReason: 'asset_moved' });
    expect((await profileOf(op.p.id)).strikes).toBe(1);
  });

  it_('only the operator delivers, only the drawn card, only to the buyer: another wallet, the buyer, a changed card or recipient are refused', async () => {
    const op = await freshOperator();
    const p = await pack(4, { op });
    const opened = await open(p.id);
    await pay(opened);
    const prep = await svc.prepareDraw(opened.draw.id, op.p.id);
    const signed = b64(partySigns(bytes(prep.txBase64), op.k));
    const stranger = await fundedWallet();
    expect((await err(svc.prepareDraw(opened.draw.id, stranger.p.id))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, stranger.p.id, { role: 'seller', signedTxBase64: signed }))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'seller', signedTxBase64: signed }))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, op.p.id, { role: 'buyer', signedTxBase64: signed }))).code).toBe('not_party');
    // a transaction that moves ANOTHER card of the operator, or the drawn card to another wallet, is not the delivery
    const { buildUnsignedServerTx } = await import('@/lib/chain/pack-pay-tx');
    const exp = prep.expected as { kind: 'delivery'; drawId: string; operator: string; buyer: string; asset: string; collection: string | null; feePayer: string; memo: string };
    const bh = Transaction.from(bytes(prep.txBase64)).recentBlockhash!;
    const { kind: _k, cluster: _c, ...e } = exp as typeof exp & { cluster: string };
    const otherCard = p.assets.map(String).find((a) => a !== exp.asset)!;
    for (const bad of [{ ...e, asset: otherCard }, { ...e, buyer: w.attacker.publicKey.toBase58() }]) {
      const tx = buildUnsignedServerTx({ kind: 'delivery', e: bad }, bh);
      expect((await err(svc.signDraw(opened.draw.id, op.p.id, { role: 'seller', signedTxBase64: b64(partySigns(tx, op.k)) }))).code).toBe('tx_mismatch');
    }
    // the right one still works, once: a second signature of the same round does not deliver twice
    const done = await svc.signDraw(opened.draw.id, op.p.id, { role: 'seller', signedTxBase64: signed });
    expect(done.step).toBe('settled');
    const sent = port.sent.length;
    expect((await svc.signDraw(opened.draw.id, op.p.id, { role: 'seller', signedTxBase64: signed })).step).toBe('settled');
    expect(port.sent.length).toBe(sent);
    // a round that ran out is refused (a delivery needs a fresh blockhash)
  });

  it_('an operator delivering outside the platform (the card reaches the buyer) settles the purchase; the platform never sends a second one', async () => {
    const op = await freshOperator();
    const p = await pack(4, { op });
    const opened = await open(p.id);
    await pay(opened);
    const asset = (await rowOf(opened.draw.id)).asset!;
    const { transferV1 } = await import('@metaplex-foundation/mpl-core');
    const { createNoopSigner, publicKey: umiPk } = await import('@metaplex-foundation/umi');
    const u = w.umiFor(w.sa.publicKey);
    w.send(w.ixs(transferV1(u, { asset: { publicKey: umiPk(asset) } as never, collection: { publicKey: umiPk(w.collection.toBase58()) } as never, authority: createNoopSigner(umiPk(op.k.publicKey.toBase58())), newOwner: umiPk(w.buyer.publicKey.toBase58()) }) as never), w.sa, [op.k]);
    advance(WATCH_ADVANCE);
    expect(await svc.getDraw(opened.draw.id)).toMatchObject({ status: 'settled' });
    expect((await profileOf(op.p.id)).strikes).toBe(0);
  });

  it_('a finalized delivery that does not verify is held for review, never sent again', async () => {
    const op = await freshOperator();
    const p = await pack(4, { op });
    const opened = await open(p.id);
    await pay(opened);
    const asset = (await rowOf(opened.draw.id)).asset!;
    port.holdFinality = true;
    await deliver(opened.draw.id, op);
    const sent = port.sent.length;
    ctl.readAssetOwnerOverride = { asset, owner: w.attacker.publicKey.toBase58() }; // what the verification reads is not the buyer
    port.holdFinality = false;
    advance(5);
    await svc.getDraw(opened.draw.id);
    expect((await rowOf(opened.draw.id)).status).toBe('delivering');
    for (let i = 0; i < 3; i++) { advance(400); await svc.getDraw(opened.draw.id); }
    expect(port.sent.length).toBe(sent); // no second transaction
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'pack.delivery.mismatch'))).length).toBeGreaterThanOrEqual(1);
    ctl.readAssetOwnerOverride = null;
    advance(400);
    expect((await svc.getDraw(opened.draw.id)).status).toBe('settled'); // the chain agrees now
  });

  it_('wrong amount, mint, destination or fee wallet: refused before anything is stored, nothing is charged, also when the destination is a platform wallet', async () => {
    const p = await pack(4);
    const opened = await open(p.id);
    const exp = opened.payment.expected as PackPayExpected;
    const bh = Transaction.from(bytes(opened.payment.txBase64)).recentBlockhash!;
    const buyer0 = w.usdcOf(w.buyer);
    const wrong: Partial<PackPayExpected>[] = [
      { gross: '99000000' }, { gross: '1000000', platformFee: '0' }, { usdcMint: w.attacker.publicKey.toBase58() }, { operator: w.attacker.publicKey.toBase58() },
      { operator: w.houseSeller.publicKey.toBase58() }, { operator: w.sa.publicKey.toBase58() }, { feeWallet: w.attacker.publicKey.toBase58() }, { platformFee: '9750000' },
    ];
    for (const patch of wrong) {
      const tx = buildUnsignedPayTx({ ...exp, ...patch }, bh);
      expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: b64(partySigns(tx, w.buyer)) }))).code, JSON.stringify(patch)).toBe('tx_mismatch');
    }
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
    expect((await rowOf(opened.draw.id)).buyerSignature).toBeNull();
    expect((await pay(opened)).draw.status).toBe('drawn'); // the right one still works
    await deliver(opened.draw.id);
  });

  it_('a payment can not be replayed for a second draw: one transaction id belongs to one purchase, the memo names the draw', async () => {
    const p = await pack(6);
    const a = await open(p.id);
    const signedA = b64(partySigns(bytes(a.payment.txBase64), w.buyer));
    expect((await svc.signDraw(a.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: signedA })).draw.status).toBe('drawn');
    await deliver(a.draw.id);
    const b = await open(p.id);
    expect((await err(svc.signDraw(b.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: signedA }))).code).toBe('tx_mismatch');
    const sent = port.sent.length;
    expect((await svc.signDraw(a.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: signedA })).step).toBe('settled'); // asking again changes nothing
    expect(port.sent.length).toBe(sent);
    const rowA = await rowOf(a.draw.id);
    await expect(db.update(schema.packDraws).set({ txSignature: rowA.txSignature }).where(eq(schema.packDraws.id, b.draw.id))).rejects.toThrow();
    await expect(db.update(schema.packDraws).set({ deliverySignature: rowA.deliverySignature }).where(eq(schema.packDraws.id, b.draw.id))).rejects.toThrow();
    await expect(db.update(schema.packDraws).set({ status: 'undelivered', cardId: rowA.cardId }).where(eq(schema.packDraws.id, b.draw.id))).rejects.toThrow(); // a card is held by one draw, also an undelivered one
  });

  it_('ownership is checked at create, publish and open; a platform wallet is never an operator; an operator who left with a card cannot publish it', async () => {
    const op = await freshOperator();
    const foreign = w.consign(`Foreign3 ${++n}`, w.attacker);
    expect((await err(svc.create(actor(op.p), PackCreateRequest.parse({ name: { de: 'x', en: 'x' }, mode: 'chance', price: '1000000', odds: [{ ...TIERS[0]!, bps: 10000 }], cards: [{ asset: foreign.toBase58(), tier: 'common', name: 'F' }] })))).code).toBe('asset_not_ready');
    // a draft whose card the operator then sends away is not published
    const assets = Array.from({ length: 3 }, (_, i) => w.consign(`Own3 ${++n}-${i}`, op.k));
    const draft = await svc.create(actor(op.p), PackCreateRequest.parse({ name: { de: 'x', en: 'x' }, mode: 'chance', price: '1000000', odds: [{ ...TIERS[0]!, bps: 10000 }], cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: 'common', name: `O${i}` })) }));
    await moveAway(assets[1]!.toBase58(), op.k);
    expect((await err(svc.control(draft.id, op.p.id, 'publish'))).code).toBe('asset_not_ready');
    // a stored third-party pack whose operator wallet is a platform wallet is not sold
    for (const wallet of [w.houseSeller, w.feeWallet, w.sa]) {
      const prof = await profile(wallet.publicKey.toBase58(), { isSeller: true });
      const [row] = await db.insert(schema.packDefinitions).values({ operatorProfileId: prof.id, operatorWallet: wallet.publicKey.toBase58(), isHouse: false, name: { de: 'a', en: 'a' }, mode: 'chance', cluster, price: 1_000_000n, odds: [], status: 'live', poolHash: 'ab'.repeat(32), oddsHash: 'cd'.repeat(32), committedAt: new Date() }).returning();
      const e = await err(open(row!.id));
      expect(e.code).toBe('paused');
      expect(e.message).toMatch(/platform wallet/);
    }
  });

  it_('the last card is sold once: two buyers pay at the same time, one payment is sent, the other is turned away BEFORE any money moves (no refund exists for a third-party pack)', async () => {
    const p = await pack(1, { cap: 3 });
    const b = await fundedWallet();
    const oa = await open(p.id), ob = await open(p.id, b.p);
    const before = { a: w.usdcOf(w.buyer), b: w.usdcOf(b.k) };
    const results = await Promise.allSettled([pay(oa), pay(ob, b.p, b.k)]);
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0]!.reason as ApiError).code).toBe('wrong_state');
    const paidA = w.usdcOf(w.buyer) < before.a, paidB = w.usdcOf(b.k) < before.b;
    expect([paidA, paidB].filter(Boolean)).toHaveLength(1); // exactly one buyer paid
    const rows = await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, p.id));
    expect(rows.filter((r) => r.status === 'drawn')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'awaiting_payment')).toHaveLength(1); // the loser still waits for a signature, charged nothing
    await deliver(rows.find((r) => r.status === 'drawn')!.id);
  });

  it_('parallel buyers of a bigger pack: each card to one buyer, draw indexes gapless in the order of the payments, every draw proves (also with deliveries still open)', async () => {
    const p = await pack(8, { cap: 3 });
    const ws = await Promise.all(Array.from({ length: 5 }, () => fundedWallet(30_000_000n)));
    const opened = await Promise.all(ws.map((x) => open(p.id, x.p)));
    await Promise.all(ws.map((x, i) => pay(opened[i]!, x.p, x.k)));
    // the buyers' screens keep reading: a draw waits while another payment of the pack is still being confirmed
    for (let round = 0; round < 6; round++) { advance(10); for (const o of opened) await svc.getDraw(o.draw.id); }
    const rows = (await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, p.id))).sort((a, b) => a.drawIndex! - b.drawIndex!);
    expect(rows.map((r) => r.drawIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(rows.map((r) => r.cardId)).size).toBe(5);
    for (let i = 1; i < rows.length; i++) expect([rows[i - 1]!.paymentSlot!, rows[i - 1]!.txSignature!] <= [rows[i]!.paymentSlot!, rows[i]!.txSignature!] || rows[i - 1]!.paymentSlot! < rows[i]!.paymentSlot!).toBe(true);
    // deliver two of them out of order; the others stay open for now
    await deliver(rows[3]!.id); await deliver(rows[1]!.id);
    for (const r of rows) {
      const { checks } = await proofOf(r.id, rpcFor(r));
      const by = Object.fromEntries(checks.map((c) => [c.id, c.status]));
      if (r.id === rows[3]!.id || r.id === rows[1]!.id) expect(by, `draw ${r.drawIndex}`).toMatchObject({ pool_hash: 'pass', params: 'pass', alpha: 'pass', proof: 'pass', output: 'pass', result: 'pass', beacon: 'pass', payment: 'pass', order: 'pass' });
      if (r.id === rows[3]!.id) expect(by.taken, 'cards of earlier draws that are not delivered are not public yet: unverifiable, never a false failure').not.toBe('fail');
    }
    for (const r of rows) if (r.id !== rows[3]!.id && r.id !== rows[1]!.id) await deliver(r.id);
  });

  it_('the pack stays honest on both networks: the payment uses the network\'s USDC mint, the explorer link and the VRF input name the network', async () => {
    const p = await pack(3);
    const opened = await open(p.id);
    expect((opened.payment.expected as PackPayExpected).usdcMint).toBe(cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : w.usdc.toBase58());
    await pay(opened);
    expect((await rowOf(opened.draw.id)).vrfInput).toContain(`cluster: ${cluster}`);
    await deliver(opened.draw.id);
  });

  it_('the daily cap and one purchase in progress per wallet and pack hold for a pack that waits for its operator', async () => {
    const p = await pack(6, { cap: 2 });
    const a = await open(p.id);
    await pay(a);
    expect((await err(open(p.id))).code).toBe('wrong_state'); // paid and not delivered yet: one purchase in progress
    await deliver(a.draw.id);
    const b = await open(p.id);
    await pay(b);
    await deliver(b.draw.id);
    expect((await err(open(p.id))).code).toBe('rate_limited'); // two per day
    // two opens at the same moment of one wallet: one purchase only
    const q = await pack(4, { cap: 5 });
    const w2 = await fundedWallet();
    const both = await Promise.allSettled([open(q.id, w2.p), open(q.id, w2.p)]);
    const rowsOf = await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, q.id));
    expect(rowsOf.length).toBe(1);
    expect(both.some((r) => r.status === 'fulfilled')).toBe(true);
  });

  it_('NO code path of a third-party pack refunds or signs for the operator: a third-party draw never reaches a refund state, and the platform never signs a refund, whatever happens', async () => {
    const op = await freshOperator();
    const p = await pack(1, { op, cap: 5 });
    const a = await open(p.id);
    const sent0 = port.sent.length;
    await pay(a);
    // the pool is empty for everyone else; the operator moves the only card away
    await moveAway((await rowOf(a.draw.id)).asset!, op.k);
    advance(WATCH_ADVANCE);
    await svc.getDraw(a.draw.id);
    await svc.sweep(clock);
    advance(DEADLINE_S * 3);
    await svc.sweep(clock);
    const statuses = (await db.select().from(schema.packDraws)).filter((d) => d.packId === p.id).map((d) => d.status);
    expect(statuses.every((s) => !/refund/.test(s))).toBe(true);
    expect(port.sent.length - sent0).toBe(1); // only the buyer's payment was ever sent
  });

  it_('the house demo is not a way to take money for a third party: the house wallet signs nothing for a third-party draw, and a house pack is refused here unless this is the demo network', async () => {
    const p = await pack(3);
    const opened = await open(p.id);
    await pay(opened);
    const sent = port.sent.length;
    for (let i = 0; i < 4; i++) { advance(400); await svc.sweep(clock); }
    expect(port.sent.length).toBe(sent); // the sweep sent nothing for the operator
    expect((await rowOf(opened.draw.id)).status).toBe('drawn'); // until the deadline it waits for the operator
    await deliver(opened.draw.id);
    expect(minted).toEqual([]); // no demo copy was minted for any third-party draw of this file
  });
});

/** More than the minute between two looks at a drawn card (the platform asks the chain at most once a minute per card). */
const WATCH_ADVANCE = 90;
void sql;
void ChainError;
