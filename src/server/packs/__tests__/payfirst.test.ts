/**
 * The devnet HOUSE DEMO pack runs through the SAME pay-first flow as a third-party pack (A14) up to the draw: the buyer pays the operator (here the house wallet,
 * test USDC), the draw runs after the payment is final (ECVRF, first block after the payment). Then it ENDS AS A DEMO: state `demo_revealed`, the pool card stays in the
 * house wallet (the pool never runs down), a COPY of it is minted into the buyer's wallet (best effort, once per draw), no deadline, no strike, no refund anywhere.
 * Real Postgres 18 (embedded), the real Core and token programs (LiteSVM), the real ECVRF library. No network, no Neon, no real key, no transaction on any cluster.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, eq } from 'drizzle-orm';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha2';
import * as schema from '@/db/schema';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ApiError, PackCreateRequest, PackDrawView, PackOpenResponse, type Cluster, type PackPayExpected } from '@/contracts';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { ChainError } from '@/lib/chain/errors';
import { ataAddress, createAtaIdempotentIx, mintToIx } from '@/lib/chain/ix';
import { partySigns } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import { generateVrfKey } from '@/lib/vrf/key';
import { buildAlpha, paramsHashOf, parseAlpha, type VrfRpc } from '@/lib/vrf';
import { drawParams, packDrawSubject } from '@/lib/packs/commit';
import { makeDraw } from '@/lib/packs/draw';
import { isPackProven, verifyPackDraw, type ProofDraw, type ProofPool } from '@/lib/packs';
import { createPackService, type PackDeps, type PackService } from '../service';
import { createPackWorld, type PackWorld } from './pack-world';
import { EXPIRY_MARGIN_BLOCKS, PAY_WINDOW_S } from '../payfirst';

type Db = PackDeps['db'];
let t: TestPg | undefined, skipReason: string | undefined, db: Db;
const T0 = new Date('2026-10-05T12:00:00.000Z');
let clock = T0;
const advance = (s: number) => { clock = new Date(clock.getTime() + s * 1000); };
const vrf = generateVrfKey().key;
const beaconHash = bs58.encode(sha512(new TextEncoder().encode('anchor')).slice(0, 32));
/** The first block after a payment slot: its hash is a pure function of the slot in this world (the fake "network" every check reads). */
const hashAt = (slot: number) => bs58.encode(sha512(new TextEncoder().encode(`after-${slot}`)).slice(0, 32));

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
const profile = async (wallet: string, o: Partial<typeof schema.profiles.$inferInsert> = {}) => (await db.insert(schema.profiles).values({ walletAddress: wallet, ...o }).onConflictDoUpdate({ target: schema.profiles.walletAddress, set: { updatedAt: new Date() } }).returning())[0]!;
const seed = () => (++n).toString(16).padStart(32, 'b');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected the call to fail'); };
const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TIERS = [{ tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 7000 }, { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 3000 }];

describe.each([['devnet']] as const)('house demo, pay first on %s', (cluster: Cluster) => {
  let w: PackWorld, port: SvmPort, chain: SvmPort, svc: PackService, buyerP: typeof schema.profiles.$inferSelect, houseP: typeof schema.profiles.$inferSelect;
  const watched: string[] = [];
  const spend: string[] = [];
  /** What the fake network does to the service's sends: nothing, or something that goes wrong. */
  const ctl = { beaconReady: true, dropSends: false, refuse: 0, dieAfterLandingOnDelivery: false, mint: 'ok' as 'ok' | 'fail' | 'off' };
  /** What the service asked to be minted into a buyer's wallet (the fake mint: no chain, the real one is covered by devnet-routes.integration.test.ts). */
  const copies: { wallet: string; source: string }[] = [];
  const mintSig = (k: number) => bs58.encode(sha512(new TextEncoder().encode(`demo-copy-${k}`)));

  const memoOf = (b: string) => Transaction.from(Buffer.from(b, 'base64')).instructions.find((i) => i.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')?.data.toString('utf8') ?? '';
  beforeAll(async () => {
    if (!t) return;
    w = createPackWorld(cluster);
    port = createSvmPort(w, () => watched);
    // the service talks to the chain through this wrapper, which can drop or refuse a send, or die after accepting one (like an RPC does)
    chain = {
      ...port,
      async send(b: string) {
        if (ctl.dropSends) return bs58.encode(Transaction.from(Buffer.from(b, 'base64')).signatures[0]!.signature!);
        if (ctl.refuse > 0) { ctl.refuse--; throw new ChainError('blockhash_expired', 'refused for the test'); }
        if (ctl.dieAfterLandingOnDelivery && memoOf(b).startsWith('hp:pack-card:')) { ctl.dieAfterLandingOnDelivery = false; port.dieAfterLanding = true; }
        return port.send(b);
      },
    } as SvmPort;
    svc = createPackService({
      db, chainFor: () => chain, sa: w.sa, houseOperator: w.houseSeller, vrfKey: () => vrf, beacon: async () => ({ slot: 424_242_424, blockhash: beaconHash }), usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250,
      defaultCluster: cluster, now: () => clock, sleep: async () => { advance(1); }, assertCluster: () => undefined, spendGuard: async (k) => { spend.push(k); },
      beaconAfter: async (_c, slot) => (ctl.beaconReady ? { slot: slot + 1, blockhash: hashAt(slot + 1) } : null),
      mintDemoCopy: async (i) => {
        copies.push(i);
        if (ctl.mint === 'fail') throw new ChainError('rpc_unavailable', 'the test network is slow');
        return ctl.mint === 'off' ? null : { mint: Keypair.generate().publicKey.toBase58(), signature: mintSig(copies.length) };
      },
    });
    buyerP = await profile(w.buyer.publicKey.toBase58());
    houseP = await profile(w.houseSeller.publicKey.toBase58(), { isSeller: true });
  }, 60_000);

  const actor = (p: { id: string; walletAddress: string }) => ({ id: p.id, wallet: p.walletAddress });
  const topUp = (kp: Keypair, amount: bigint) => {
    const ata = ataAddress(w.usdc, kp.publicKey);
    w.send([createAtaIdempotentIx(w.sa.publicKey, ata, kp.publicKey, w.usdc), mintToIx(w.usdc, ata, w.mintAuth.publicKey, amount + BigInt(++n))], w.sa, [w.mintAuth]); // +n: two identical setup transactions in one block would be "already processed"
    return amount + BigInt(n);
  };
  async function fundedWallet(amount = 100_000_000n) {
    const k = Keypair.generate();
    topUp(k, amount);
    watched.push(k.publicKey.toBase58());
    return { k, p: await profile(k.publicKey.toBase58()) };
  }
  /** A live house chance pack of `count` real Core cards in the house wallet (two tiers from 3 cards on). */
  async function housePack(count = 6, o: { cap?: number; price?: string } = {}) {
    const assets = Array.from({ length: count }, (_, i) => w.consign(`House card ${++n}-${i}`, w.houseSeller));
    const view = await svc.create(actor(houseP), PackCreateRequest.parse({
      name: { de: 'Hauspack', en: 'House pack' }, mode: 'chance', price: o.price ?? '10000000', perWalletDailyCap: o.cap ?? 5, odds: count < 3 ? [{ ...TIERS[0]!, bps: 10000 }] : TIERS,
      cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: count >= 3 && i % 3 === 2 ? 'rare' : 'common', name: `Card ${i + 1}`, listedValue: String(25_000_000 + i * 1_000_000) })),
    }), { isHouse: true });
    const live = await svc.control(view.id, houseP.id, 'publish');
    return { id: live.id, assets, view: live };
  }
  const open = (packId: string, p = buyerP) => svc.open(actor(p), packId, { clientSeed: seed(), ageConfirmed: true });
  const sign = async (o: PackOpenResponse, p = buyerP, k: Keypair = w.buyer) => svc.signDraw(o.draw.id, p.id, { role: 'buyer', signedTxBase64: b64(partySigns(bytes(o.payment.txBase64), k)) });
  /** What the buyer's screen does: read the draw every few seconds until it ends (each read carries the purchase one step further). */
  const drive = async (id: string, max = 6) => {
    let v = await svc.getDraw(id);
    for (let i = 0; i < max && !['settled', 'demo_revealed', 'undelivered', 'expired', 'failed'].includes(v.status); i++) { advance(3); v = await svc.getDraw(id); }
    return v;
  };
  const rowOf = async (id: string) => (await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, id)))[0]!;
  const actions = async (id: string) => (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.target, id)).orderBy(asc(schema.auditLogs.createdAt))).map((a) => a.action.replace('pack.draw.', ''));
  const cardRows = async (packId: string) => db.select().from(schema.packPoolCards).where(eq(schema.packPoolCards.packId, packId));
  const owner = (asset: string) => w.ownerOf(new PublicKey(asset));
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
    const earlier = log.draws.filter((d) => d.drawIndex !== null && view.drawIndex !== null && d.drawIndex < view.drawIndex).map((d) => ({ drawIndex: d.drawIndex!, status: d.status, cardAsset: d.card?.asset ?? null, paymentSlot: (d.vrf.params as { payment?: { slot: number } } | null)?.payment?.slot ?? null }));
    return { view, pool, draw, checks: await verifyPackDraw(pool, draw, { earlier, ...(rpc ? { rpc } : {}) }) };
  }

  it_('PAY FIRST, then draw, then END AS A DEMO: the buyer pays the house (test USDC), the card is drawn after the payment, a copy is minted into the buyer\'s wallet and the pool card does not move', async () => {
    const pack = await housePack(6);
    const buyer0 = w.usdcOf(w.buyer), house0 = w.usdcOf(w.houseSeller), fee0 = w.usdcOf(w.feeWallet), sent0 = port.sent.length, copies0 = copies.length;
    const ownersBefore = pack.assets.map((a) => owner(a.toBase58()));
    const opened = await open(pack.id);
    // nothing is drawn: a purchase waiting for the payment
    expect(PackOpenResponse.parse(opened).draw).toMatchObject({ status: 'awaiting_payment', flow: 'pay_first', drawIndex: null, revealed: false, tier: null, card: null, vrf: { requestId: null, input: null, proofHex: null, outputHex: null } });
    expect(opened.payment).toMatchObject({ buyerSigned: false, operatorSigned: false });
    const exp = opened.payment.expected as PackPayExpected;
    expect(exp).toMatchObject({ cluster, operator: w.houseSeller.publicKey.toBase58(), buyer: w.buyer.publicKey.toBase58(), usdcMint: w.usdc.toBase58(), gross: '10000000', platformFee: '250000', feePayer: w.sa.publicKey.toBase58() });
    expect(exp.memo).toBe(`hp:pack:${opened.draw.id}:${pack.view.commitment.poolHash}`);
    expect('asset' in exp).toBe(false);
    expect(w.usdcOf(w.buyer)).toBe(buyer0); // nothing has moved
    // the signing pays, the platform sends it, it is finalized, then it is drawn; the end is a demo
    const r = await sign(opened);
    expect(r.step).toBe('settled');
    const view = PackDrawView.parse(r.draw);
    expect(view).toMatchObject({ status: 'demo_revealed', flow: 'pay_first', revealed: true, drawIndex: 0, cluster, deliverBy: null, deliverySignature: mintSig(copies.length) });
    expect(view.card).not.toBeNull();
    expect(view.tier).not.toBeNull();
    // the REAL payment trail: test USDC moved on chain, one transaction
    expect(buyer0 - w.usdcOf(w.buyer)).toBe(10_000_000n);
    expect(w.usdcOf(w.houseSeller) - house0).toBe(9_750_000n);
    expect(w.usdcOf(w.feeWallet) - fee0).toBe(250_000n);
    expect(port.sent.slice(sent0)).toHaveLength(1); // the payment only: no transfer of the pool card
    // the card is the buyer's: ONE copy of the drawn replica was minted into the buyer's wallet, and its transaction is the one shown with the result
    expect(copies.slice(copies0)).toEqual([{ wallet: w.buyer.publicKey.toBase58(), source: view.card!.asset }]);
    expect(view.txSignature).toBe(port.sent[sent0]);
    // THE POOL DID NOT MOVE: every pool card is still the house's, the drawn one too (the demo pool never runs down)
    expect(pack.assets.map((a) => owner(a.toBase58()))).toEqual(ownersBefore);
    expect(owner(view.card!.asset)).toBe(w.houseSeller.publicKey.toBase58());
    const row = await rowOf(opened.draw.id);
    expect(row).toMatchObject({ status: 'demo_revealed', flow: 'pay_first', paymentSlot: sent0 + 1, drawIndex: 0, txSignature: port.sent[sent0], deliverySignature: mintSig(copies.length), deliveryAttempts: 1, serverTx: null, deliverBy: null, strikeAt: null, undeliveredAt: null });
    expect(row.paidAt).not.toBeNull();
    expect(row.drawnAt).not.toBeNull();
    // every state was written down, in order: no delivering, no settled; the copy is the last line
    expect(await actions(opened.draw.id)).toEqual(['awaiting_payment', 'confirming', 'paid', 'demo_revealed', 'demo_minted']);
    // the pool is untouched (no card reserved or drawn), the pack stays on sale
    expect((await cardRows(pack.id)).every((c) => c.status === 'available')).toBe(true);
    expect((await svc.detail(pack.id, null)).pack).toMatchObject({ status: 'live', pool: { total: 6, remaining: 6 } });
    // the public view and the VRF row show the result (the draw ended), and the proof passes
    const { checks } = await proofOf(opened.draw.id, rpcFor(row));
    expect(Object.fromEntries(checks.map((c) => [c.id, c.status])), JSON.stringify(checks)).toMatchObject({ pool_hash: 'pass', params: 'pass', alpha: 'pass', proof: 'pass', output: 'pass', result: 'pass', taken: 'pass', beacon: 'pass', payment: 'pass' });
    expect(isPackProven(checks)).toBe(true);
    // nothing waits: no deadline sweep touches it, the house gets no strike, and the draw is terminal
    advance(3 * 86_400); // far past any delivery deadline
    await svc.sweep(clock);
    expect((await svc.getDraw(opened.draw.id)).status).toBe('demo_revealed');
    expect((await db.select().from(schema.profiles).where(eq(schema.profiles.id, houseP.id)))[0]!.strikes).toBe(0);
    expect((await db.select().from(schema.packDefinitions).where(eq(schema.packDefinitions.id, pack.id)))[0]!.status).toBe('live');
  });

  it_('the copy is minted ONCE per draw: three polls at the same moment, later reads and a sweep mint nothing more', async () => {
    const pack = await housePack(5);
    const opened = await open(pack.id);
    ctl.beaconReady = false;
    await sign(opened); // paid, not drawn yet
    ctl.beaconReady = true;
    advance(10);
    const before = copies.length;
    await Promise.all([svc.getDraw(opened.draw.id), svc.getDraw(opened.draw.id), svc.getDraw(opened.draw.id)]); // retried polls that overlap
    expect(copies.length - before).toBe(1);
    for (let i = 0; i < 3; i++) { advance(3); await svc.getDraw(opened.draw.id); }
    advance(86_400);
    await svc.sweep(clock);
    expect(copies.length - before).toBe(1);
    expect(await rowOf(opened.draw.id)).toMatchObject({ status: 'demo_revealed', deliveryAttempts: 1, deliverySignature: mintSig(copies.length) });
    expect((await actions(opened.draw.id)).filter((a) => a === 'demo_minted')).toHaveLength(1);
  });

  it_('a mint that fails or is switched off never fails or blocks the draw or the reveal, and it is not tried again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const mode of ['fail', 'off'] as const) {
      ctl.mint = mode;
      try {
        const pack = await housePack(4);
        const before = copies.length;
        const opened = await open(pack.id);
        const r = await sign(opened);
        expect(r.step).toBe('settled'); // the draw ended and the card is shown
        expect(PackDrawView.parse(r.draw)).toMatchObject({ status: 'demo_revealed', revealed: true, deliverySignature: null });
        expect(r.draw.card).not.toBeNull();
        expect(copies.length - before).toBe(1);
        if (mode === 'fail') expect(warn.mock.calls.flat().join(' ')).toContain('demo card copy was not minted');
        ctl.mint = 'ok'; // the chain is fine again: still no second try (the claim is taken)
        advance(3);
        await svc.getDraw(opened.draw.id);
        await svc.sweep(clock);
        expect(copies.length - before).toBe(1);
        expect(await svc.getDraw(opened.draw.id)).toMatchObject({ status: 'demo_revealed', deliverySignature: null });
        expect(await rowOf(opened.draw.id)).toMatchObject({ deliveryAttempts: 1, deliverySignature: null });
        expect(await actions(opened.draw.id)).toEqual(['awaiting_payment', 'confirming', 'paid', 'demo_revealed']);
      } finally { ctl.mint = 'ok'; }
    }
  });

  it_('NOTHING names a card before the payment is final: api, transaction bytes, vrf rows, audit rows and logs carry no card', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const pack = await housePack(6);
    const pool = (await svc.detail(pack.id, null)).cards;
    const assets = pool.map((c) => c.asset);
    const opened = await open(pack.id);
    const again = await svc.prepareDraw(opened.draw.id, buyerP.id);
    const got = await svc.getDraw(opened.draw.id);
    const log = await svc.listDraws(pack.id);
    const text = JSON.stringify({ opened, again, got, log });
    // (1) the API: no asset address, no card name, no tier of the draw, no result
    for (const a of assets) expect(text, `api names ${a}`).not.toContain(a);
    for (const c of pool) expect(text).not.toContain(`"${c.name}"`);
    expect(got).toMatchObject({ status: 'awaiting_payment', revealed: false, card: null, tier: null, drawIndex: null, vrf: { requestId: null, status: null, input: null, proofHex: null, outputHex: null, params: null, paramsHash: null, beacon: null } });
    expect(log.draws).toEqual([]); // an unpaid purchase is not in the public log
    // (2) the transaction bytes: no pool card address (raw 32 bytes) anywhere
    const tx = Buffer.from(opened.payment.txBase64, 'base64');
    for (const a of assets) expect(tx.includes(new PublicKey(a).toBuffer()), `tx bytes hold ${a}`).toBe(false);
    expect(Transaction.from(tx).instructions.some((i) => i.programId.toBase58() === CORE)).toBe(false); // no card transfer in it at all
    // (3) the database: no vrf row for this draw (by id, by the derived subject), no card, no tier, no proof
    const row = await rowOf(opened.draw.id);
    expect(row).toMatchObject({ cardId: null, asset: null, tier: null, vrfRequestId: null, vrfInput: null, proofHex: null, outputHex: null, drawIndex: null, paymentSlot: null });
    expect(await db.select().from(schema.vrfRequests).where(eq(schema.vrfRequests.subjectId, opened.draw.id))).toEqual([]);
    expect(await db.select().from(schema.vrfRequests).where(eq(schema.vrfRequests.id, packDrawSubject(pack.id, 0)))).toEqual([]);
    expect((await cardRows(pack.id)).every((c) => c.status === 'available')).toBe(true); // nothing reserved: unpaid attempts cannot shape later draws
    // (4) the audit trail and the logs
    const audit = JSON.stringify(await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.target, opened.draw.id)));
    for (const a of assets) { expect(audit).not.toContain(a); expect(logs.join('\n')).not.toContain(a); }
    // the public VRF view of the (not yet existing) draw: the subject is derived from public values, so anybody can ask; there is nothing
    // after it is paid, the row exists but a pack draw that is not at its end shows only a bare shell (views.ts / vrf service hideUnpaidDraw)
    expect(await db.select().from(schema.vrfRequests).where(eq(schema.vrfRequests.purpose, 'pack_draw'))).not.toContainEqual(expect.objectContaining({ subjectId: opened.draw.id }));
  });

  it_('a payment that is only confirmed is not enough: nothing is drawn until it is FINALIZED', async () => {
    const pack = await housePack(5);
    const opened = await open(pack.id);
    port.holdFinality = true;
    const r = await sign(opened);
    expect(r.step).toBe('submitted');
    expect(r.draw).toMatchObject({ status: 'confirming', revealed: false, card: null, tier: null });
    let row = await rowOf(opened.draw.id);
    expect(row).toMatchObject({ status: 'confirming', cardId: null, asset: null, vrfRequestId: null, drawIndex: null });
    expect(await db.select().from(schema.vrfRequests).where(eq(schema.vrfRequests.subjectId, opened.draw.id))).toEqual([]);
    // the buyer's balance is already down (the payment landed), the screen says "confirming", and a read changes nothing
    for (let i = 0; i < 3; i++) expect((await svc.getDraw(opened.draw.id)).status).toBe('confirming');
    expect((await svc.sweep(clock)).delivered).toBe(0);
    port.holdFinality = false;
    expect((await drive(opened.draw.id)).status).toBe('demo_revealed'); // finalized: paid, drawn and ended as a demo within a read or two
    row = await rowOf(opened.draw.id);
    expect(row.drawIndex).toBe(0);
  });

  it_('the draw waits for a block that did not exist at payment time: no beacon yet means paid and not drawn; then it is drawn with the first block after the payment', async () => {
    const pack = await housePack(5);
    const opened = await open(pack.id);
    ctl.beaconReady = false;
    const r = await sign(opened);
    expect(r.draw.status).toBe('paid');
    expect(await rowOf(opened.draw.id)).toMatchObject({ status: 'paid', cardId: null, vrfRequestId: null });
    ctl.beaconReady = true;
    advance(10);
    const done = await drive(opened.draw.id);
    expect(done.status).toBe('demo_revealed');
    const row = await rowOf(opened.draw.id);
    expect(done.vrf.beacon!.slot).toBe(row.paymentSlot! + 1);
    expect(done.vrf.beacon!.blockhash).toBe(hashAt(row.paymentSlot! + 1));
  });

  it_('NON-GRINDABLE: the committed parameters (and so the VRF input) contain the payment signature and slot; changing either changes the input and the output', async () => {
    const pack = await housePack(6);
    const opened = await open(pack.id);
    const r = await sign(opened);
    const row = await rowOf(opened.draw.id);
    const v = PackDrawView.parse(r.draw);
    const params = v.vrf.params as { payment: { signature: string; slot: number }; index: number; buyer: string; seed: string };
    expect(params.payment).toEqual({ signature: row.txSignature, slot: row.paymentSlot });
    expect(params.payment.signature).toBe(v.txSignature);
    expect(parseAlpha(v.vrf.input!).paramsHash).toBe(paramsHashOf(v.vrf.params));
    expect(paramsHashOf({ ...params, payment: { ...params.payment, signature: bs58.encode(new Uint8Array(64).fill(7)) } })).not.toBe(v.vrf.paramsHash);
    expect(v.vrf.beacon!.slot).toBeGreaterThan(params.payment.slot);
    // the same inputs with another payment give another input text and another output
    const detail = await svc.detail(pack.id, null);
    const def = { odds: detail.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })), cards: detail.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })) };
    const base = { cluster, packId: pack.id, poolHash: detail.pack.commitment.poolHash!, def, buyer: params.buyer, seed: params.seed, index: 0, taken: [] as number[], beacon: { slot: 50, blockhash: hashAt(50) }, prove: (a: string) => vrf.prove(a) };
    const sigA = bs58.encode(new Uint8Array(64).fill(1)), sigB = bs58.encode(new Uint8Array(64).fill(2));
    const a = makeDraw({ ...base, payment: { signature: sigA, slot: 40 } }), b = makeDraw({ ...base, payment: { signature: sigB, slot: 40 } }), c = makeDraw({ ...base, payment: { signature: sigA, slot: 41 } });
    expect(new Set([a.alphaText, b.alphaText, c.alphaText]).size).toBe(3);
    expect(new Set([a.proof.outputHex, b.proof.outputHex, c.proof.outputHex]).size).toBe(3);
    // a beacon that is not after the payment is refused when drawing and fails the check when verifying
    expect(() => makeDraw({ ...base, payment: { signature: sigA, slot: 50 } })).toThrow(/after the payment/);
    // the verifier: a tampered payment signature in the parameters, or a beacon at or before the payment slot, is not accepted
    const good = await proofOf(opened.draw.id, rpcFor(row));
    expect(isPackProven(good.checks)).toBe(true);
    const tampered = { ...good.draw, vrf: { ...good.draw.vrf, params: { ...params, payment: { ...params.payment, signature: sigB } } } };
    expect((await verifyPackDraw(good.pool, tampered)).find((x) => x.id === 'params')!.status).toBe('fail');
    const early = drawParams({ buyer: params.buyer, index: 0, pack: pack.id, poolHash: detail.pack.commitment.poolHash!, seed: params.seed, taken: [], payment: { signature: sigA, slot: 60 } });
    const earlyDraw = { ...good.draw, vrf: { ...good.draw.vrf, params: early as unknown as Record<string, unknown>, paramsHash: paramsHashOf(early), beacon: { slot: 60, blockhash: hashAt(60) }, input: buildAlpha({ cluster, purpose: 'pack_pull', subject: packDrawSubject(pack.id, 0), paramsHash: paramsHashOf(early), beacon: { slot: 60, blockhash: hashAt(60) } }) } };
    expect((await verifyPackDraw(good.pool, earlyDraw)).find((x) => x.id === 'params')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/after the payment slot/) });
    // a draw that was not made after a payment cannot pass as pay_first, and the chain checks catch a payment in another slot or another memo
    const wrongSlot = await verifyPackDraw(good.pool, good.draw, { rpc: { ...rpcFor(row), getTx: async () => ({ slot: row.paymentSlot! + 5, blockTime: null, failed: false, signers: [row.buyerWallet], memos: [row.settlementRef!] }) } });
    expect(wrongSlot.find((x) => x.id === 'payment')!.status).toBe('fail');
    const wrongMemo = await verifyPackDraw(good.pool, good.draw, { rpc: { ...rpcFor(row), getTx: async () => ({ slot: row.paymentSlot!, blockTime: null, failed: false, signers: [row.buyerWallet], memos: ['hp:pack:other'] }) } });
    expect(wrongMemo.find((x) => x.id === 'payment')!.status).toBe('fail');
    const skipped = await verifyPackDraw(good.pool, good.draw, { rpc: { ...rpcFor(row), getBlocks: async (s) => [s - 1 + 0, s + 99] } }); // a block lies between the payment and the beacon
    expect(skipped.find((x) => x.id === 'beacon')!.status).toBe('fail');
  });

  it_('a payment that never lands moves no money and ends cleanly: it goes back to waiting for a signature once it can no longer land, and the window ends it', async () => {
    const pack = await housePack(4, { cap: 2 });
    const opened = await open(pack.id);
    const buyer0 = w.usdcOf(w.buyer);
    ctl.dropSends = true; // the node swallows the transaction
    const r = await sign(opened);
    expect(r.draw.status).toBe('confirming');
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
    expect(await rowOf(opened.draw.id)).toMatchObject({ status: 'confirming', cardId: null });
    // while the blockhash is valid it stays confirming (the same bytes are offered again)
    expect((await svc.getDraw(opened.draw.id)).status).toBe('confirming');
    // after it expired (plus the margin) it cannot land any more: waiting for a signature again, nothing charged
    port.expireRound();
    expect(EXPIRY_MARGIN_BLOCKS).toBeLessThan(500);
    expect((await svc.getDraw(opened.draw.id)).status).toBe('awaiting_payment');
    expect(await rowOf(opened.draw.id)).toMatchObject({ txSignature: null, buyerSignature: null, failureCode: 'round_expired' });
    ctl.dropSends = false;
    // the window passes: expired, the count is given back
    advance(PAY_WINDOW_S + 5);
    expect((await svc.sweep(clock)).expired).toBeGreaterThanOrEqual(1);
    expect(await svc.getDraw(opened.draw.id)).toMatchObject({ status: 'expired', revealed: true });
    expect(w.usdcOf(w.buyer)).toBe(buyer0);
    expect((await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, pack.id)))[0]!.count).toBe(0);
    expect((await err(svc.prepareDraw(opened.draw.id, buyerP.id))).code).toBe('wrong_state');
  });

  it_('a payment cannot be replayed for a second draw: the signed bytes of one purchase are refused for another, and one transaction id belongs to one purchase', async () => {
    const pack = await housePack(6);
    const a = await open(pack.id);
    const signedA = b64(partySigns(bytes(a.payment.txBase64), w.buyer));
    expect((await svc.signDraw(a.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: signedA })).step).toBe('settled');
    const b = await open(pack.id);
    // A's signed payment for B: another memo, another message
    expect((await err(svc.signDraw(b.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: signedA }))).code).toBe('tx_mismatch');
    // the same payment sent again for A does nothing: no second transaction, no second card
    const sent = port.sent.length;
    expect((await svc.signDraw(a.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: signedA })).step).toBe('settled');
    expect(port.sent.length).toBe(sent);
    // and the database refuses a second purchase that claims A's transaction id
    const rowA = await rowOf(a.draw.id);
    await expect(db.update(schema.packDraws).set({ txSignature: rowA.txSignature }).where(eq(schema.packDraws.id, b.draw.id))).rejects.toThrow();
  });

  it_('concurrent readers and the sweep drive one purchase together: one payment, one draw, no delivery, no refund', async () => {
    const pack = await housePack(6);
    const opened = await open(pack.id);
    port.holdFinality = true;
    await sign(opened);
    port.holdFinality = false;
    const sent = port.sent.length;
    const results = await Promise.all([...Array(6)].map((_, i) => (i % 2 ? svc.getDraw(opened.draw.id) : svc.sweep(clock).then(() => svc.getDraw(opened.draw.id)))));
    expect(results.every((x) => x.status === 'demo_revealed' || x.status === 'paid')).toBe(true);
    const done = await svc.getDraw(opened.draw.id);
    expect(done.status).toBe('demo_revealed');
    expect(port.sent.length - sent).toBe(0); // no delivery, no transaction at all
    expect((await cardRows(pack.id)).filter((c) => c.status !== 'available')).toHaveLength(0);
    expect(new Set((await db.select({ i: schema.packDraws.drawIndex }).from(schema.packDraws).where(eq(schema.packDraws.packId, pack.id))).map((x) => x.i)).size).toBe(1);
  });

  it_('parallel buyers of the demo: draw indexes are gapless and in payment order, no card is consumed or moved, and every draw recomputes with its payment', async () => {
    const pack = await housePack(10, { cap: 5 });
    topUp(w.houseSeller, 5_000_000n);
    const wallets: Awaited<ReturnType<typeof fundedWallet>>[] = [];
    for (let i = 0; i < 10; i++) wallets.push(await fundedWallet(20_000_000n));
    const opened = await Promise.all(wallets.map((x) => open(pack.id, x.p)));
    expect(opened.every((o) => o.draw.drawIndex === null && o.draw.card === null)).toBe(true); // nothing is allocated before a payment
    await Promise.all(opened.map((o, i) => sign(o, wallets[i]!.p, wallets[i]!.k)));
    // the draws wait for each other (payment order); the buyers' screens keep reading until their card arrives
    const done = await Promise.all(opened.map((o) => drive(o.draw.id, 40)));
    expect(done.map((d) => d.status)).toEqual(Array(10).fill('demo_revealed'));
    const detail = await svc.detail(pack.id, null);
    expect(detail.pack.status).toBe('live'); // a demo draw takes no card: the pool never runs down
    expect(detail.pack.pool).toEqual({ total: 10, remaining: 10 });
    const rows = await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, pack.id));
    expect(rows.map((r) => r.drawIndex).sort((x, y) => x! - y!)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(rows.map((r) => r.txSignature)).size).toBe(10);
    expect(detail.cards.map((c) => owner(c.asset)).every((o) => o === w.houseSeller.publicKey.toBase58())).toBe(true); // no asset moved
    for (const r of rows) {
      const { checks } = await proofOf(r.id, rpcFor(r));
      expect(Object.fromEntries(checks.map((c) => [c.id, c.status])), `draw ${r.drawIndex}`).toMatchObject({ pool_hash: 'pass', params: 'pass', alpha: 'pass', proof: 'pass', output: 'pass', result: 'pass', taken: 'pass', beacon: 'pass', payment: 'pass', order: 'pass' });
    }
    // the draws were made in the order of their payments (by payment slot), the way the order rule demands
    const bySlot = [...rows].sort((a, b) => a.paymentSlot! - b.paymentSlot! || (a.txSignature! < b.txSignature! ? -1 : 1)).map((r) => r.drawIndex);
    expect(bySlot).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // and a draw that jumped the queue is caught by the verifier
    const last = rows.find((r) => r.drawIndex === 9)!;
    const good = await proofOf(last.id, rpcFor(last));
    const cheat = await verifyPackDraw(good.pool, good.draw, { earlier: [{ drawIndex: 0, status: 'demo_revealed', cardAsset: null, paymentSlot: last.paymentSlot! + 50 }] });
    expect(cheat.find((c) => c.id === 'order')!.status).toBe('fail');
  }, 120_000);

  it_('only the buyer pays: a stranger, the operator role and a changed amount are refused before anything is stored; a purchase in progress blocks a second one', async () => {
    const pack = await housePack(5);
    const opened = await open(pack.id);
    const strangerP = await profile(Keypair.generate().publicKey.toBase58());
    expect((await err(svc.prepareDraw(opened.draw.id, strangerP.id))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, strangerP.id, { role: 'buyer', signedTxBase64: opened.payment.txBase64 }))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'seller', signedTxBase64: opened.payment.txBase64 }))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, houseP.id, { role: 'seller', signedTxBase64: opened.payment.txBase64 }))).code).toBe('wrong_state'); // nobody signs a payment but the buyer
    const { buildUnsignedPayTx } = await import('@/lib/chain/pack-pay-tx');
    const bh = Transaction.from(bytes(opened.payment.txBase64)).recentBlockhash!;
    const exp = opened.payment.expected as PackPayExpected;
    for (const bad of [{ ...exp, gross: '99000000' }, { ...exp, platformFee: '1' }, { ...exp, operator: w.attacker.publicKey.toBase58() }, { ...exp, feeWallet: w.attacker.publicKey.toBase58() }]) {
      const greedy = buildUnsignedPayTx(bad, bh);
      expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: b64(partySigns(greedy, w.buyer)) }))).code).toBe('tx_mismatch');
    }
    expect((await rowOf(opened.draw.id)).buyerSignature).toBeNull();
    // one purchase of a pack at a time once the payment is on its way
    port.holdFinality = true;
    await sign(opened);
    expect((await err(open(pack.id))).code).toBe('wrong_state');
    port.holdFinality = false;
    expect((await drive(opened.draw.id)).status).toBe('demo_revealed');
    // a signing round that ended is renewed, and a signature over a stale message is refused
    const second = await open(pack.id);
    const stale = b64(partySigns(bytes(second.payment.txBase64), w.buyer));
    port.expireRound();
    advance(61);
    expect((await err(svc.signDraw(second.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: stale }))).code).toBe('round_expired');
    const next = await svc.prepareDraw(second.draw.id, buyerP.id);
    expect(next.txBase64).not.toBe(second.payment.txBase64);
    expect((await err(svc.signDraw(second.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: stale }))).code).toBe('tx_mismatch');
    expect((await svc.signDraw(second.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: b64(partySigns(bytes(next.txBase64), w.buyer)) })).step).toBe('settled');
  });

  it_('no house key, no sale: a chance pack is never sold when its delivery could not be signed, and nothing is charged or counted', async () => {
    const pack = await housePack(4);
    const noKey = createPackService({ db, chainFor: () => chain, sa: w.sa, houseOperator: null, vrfKey: () => vrf, beacon: async () => ({ slot: 1, blockhash: beaconHash }), beaconAfter: async () => null, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250, defaultCluster: cluster, now: () => clock });
    const before = w.usdcOf(w.buyer);
    expect((await err(noKey.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true }))).code).toBe('paused');
    expect(w.usdcOf(w.buyer)).toBe(before);
    expect(await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, pack.id))).toEqual([]);
    expect(await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, pack.id))).toEqual([]);
  });

  it_('a demo pack never sells out: a second buyer may pay while the first payment is still confirming, because a demo draw takes no card', async () => {
    const pack = await housePack(1);
    const a = await open(pack.id);
    port.holdFinality = true;
    await sign(a);
    const other = await fundedWallet();
    const b = await open(pack.id, other.p);
    expect(b.draw.status).toBe('awaiting_payment');
    port.holdFinality = false;
    expect((await drive(a.draw.id)).status).toBe('demo_revealed');
    expect((await cardRows(pack.id)).every((c) => c.status === 'available')).toBe(true);
  });

  it_(`uses the ${cluster === 'mainnet-beta' ? 'real mainnet USDC mint' : 'devnet test mint'} for the payment, and the draw input names the cluster`, async () => {
    const pack = await housePack(3);
    const opened = await open(pack.id);
    expect((opened.payment.expected as PackPayExpected).usdcMint).toBe(cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : w.usdc.toBase58());
    const r = await sign(opened);
    expect((await rowOf(opened.draw.id)).vrfInput).toContain(`cluster: ${cluster}`);
    expect(r.draw.status).toBe('demo_revealed');
  });


  it_('a card moved away by the house changes nothing for a demo: no delivery is ever attempted, so nobody is struck and nothing is undelivered', async () => {
    const pack = await housePack(4);
    const a = await open(pack.id);
    await sign(a);
    const asset = (await rowOf(a.draw.id)).asset!;
    const { transferV1 } = await import('@metaplex-foundation/mpl-core');
    const { createNoopSigner, publicKey: umiPk } = await import('@metaplex-foundation/umi');
    w.send(w.ixs(transferV1(w.umiFor(w.sa.publicKey), { asset: { publicKey: umiPk(asset) } as never, collection: { publicKey: umiPk(w.collection.toBase58()) } as never, authority: createNoopSigner(umiPk(w.houseSeller.publicKey.toBase58())), newOwner: umiPk(w.attacker.publicKey.toBase58()) }) as never), w.sa, [w.houseSeller]);
    advance(3 * 86_400);
    await svc.sweep(clock);
    expect(await svc.getDraw(a.draw.id)).toMatchObject({ status: 'demo_revealed', undeliveredReason: null });
    expect((await db.select().from(schema.profiles).where(eq(schema.profiles.id, houseP.id)))[0]!.strikes).toBe(0);
    expect((await db.select().from(schema.packDefinitions).where(eq(schema.packDefinitions.id, pack.id)))[0]!.status).toBe('live');
  });

  it_('a house draw that an older version left in `drawn` (card reserved) ends as a demo on the next look: the card goes back to the pool and nothing is sent', async () => {
    const pack = await housePack(4);
    const a = await open(pack.id);
    port.holdFinality = true;
    await sign(a);
    port.holdFinality = false;
    ctl.beaconReady = false;
    await svc.getDraw(a.draw.id); // paid, not drawn
    ctl.beaconReady = true;
    const done = await drive(a.draw.id);
    const row = await rowOf(a.draw.id);
    // put it back the way the old flow left it: drawn, the card reserved, a deadline set
    await db.update(schema.packDraws).set({ status: 'drawn', settledAt: null, deliverBy: new Date(clock.getTime() + 86_400_000) }).where(eq(schema.packDraws.id, a.draw.id));
    await db.update(schema.packPoolCards).set({ status: 'reserved' }).where(eq(schema.packPoolCards.id, row.cardId!));
    const sent = port.sent.length;
    expect(done.status).toBe('demo_revealed');
    const after = await drive(a.draw.id);
    expect(after.status).toBe('demo_revealed');
    expect(port.sent.length).toBe(sent);
    expect((await cardRows(pack.id)).every((c) => c.status === 'available')).toBe(true);
  });
});
