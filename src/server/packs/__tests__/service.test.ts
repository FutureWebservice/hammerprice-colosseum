/**
 * The pack service on a REAL Postgres 18 (embedded), the REAL Core and token programs (LiteSVM) and the REAL ECVRF library, for BOTH
 * clusters (a test USDC mint on devnet, the real mainnet USDC address on mainnet). No network, no Neon, no real keys, no mainnet transaction.
 *
 * This file: packs, the commitment, the caps and the ATOMIC flow (equal_value packs, any operator), and the rule that a third party cannot run a
 * chance pack. The PAY FIRST flow of chance packs is in thirdparty.test.ts (the operator is paid directly) and payfirst.test.ts (the devnet house demo).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha2';
import * as schema from '@/db/schema';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ApiError, PackCreateRequest, PackDrawView, PackOpenResponse, PackView, type Cluster } from '@/contracts';
import { MAINNET_USDC_MINT } from '@/lib/chain/config';
import { partySigns } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import type { PackExpectedPayment } from '@/contracts';
import { generateVrfKey } from '@/lib/vrf/key';
import { isPackProven, poolHashOf, verifyPackDraw, type ProofDraw, type ProofPool } from '@/lib/packs';
import { createPackService, OPERATOR_WINDOW_S, type PackDeps, type PackService } from '../service';
import { createPackWorld, type PackWorld } from './pack-world';

type Db = PackDeps['db'];
let t: TestPg | undefined, skipReason: string | undefined, db: Db;
const T0 = new Date('2026-10-05T12:00:00.000Z');
let clock = T0;
const advance = (s: number) => { clock = new Date(clock.getTime() + s * 1000); };
const vrf = generateVrfKey().key;
const beaconHash = bs58.encode(sha512(new TextEncoder().encode('anchor')).slice(0, 32));

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  db = drizzle(t.pool, { schema }) as unknown as Db;
}, 120_000);
afterAll(async () => { await new Promise((r) => setTimeout(r, 200)); await t?.stop(); });
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 60_000) => it(name, async (ctx) => { if (!t) return ctx.skip(skipReason); await fn(); }, timeout);

let n = 0;
const profile = async (wallet: string, o: Partial<typeof schema.profiles.$inferInsert> = {}) => (await db.insert(schema.profiles).values({ walletAddress: wallet, ...o }).onConflictDoUpdate({ target: schema.profiles.walletAddress, set: { updatedAt: new Date() } }).returning())[0]!;
const seed = () => (++n).toString(16).padStart(32, 'a');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected the call to fail'); };

const TIERS = [{ tier: 'common', label: { de: 'Häufig', en: 'Common' }, bps: 7000 }, { tier: 'rare', label: { de: 'Selten', en: 'Rare' }, bps: 3000 }];

describe.each([['devnet'], ['mainnet-beta']] as const)('packs on %s', (cluster: Cluster) => {
  let w: PackWorld, port: SvmPort, svc: PackService, opP: typeof schema.profiles.$inferSelect, buyerP: typeof schema.profiles.$inferSelect, houseP: typeof schema.profiles.$inferSelect;
  const beaconAt = { slot: 424_242_424, blockhash: beaconHash };
  const spend: string[] = [];
  const watched: string[] = [];

  beforeAll(async () => {
    if (!t) return;
    w = createPackWorld(cluster);
    port = createSvmPort(w, () => watched);
    svc = createPackService({
      db, chainFor: () => port, sa: w.sa, houseOperator: w.houseSeller, vrfKey: () => vrf, beacon: async () => beaconAt, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250,
      defaultCluster: cluster, now: () => clock, sleep: async () => { advance(1); }, assertCluster: () => undefined, spendGuard: async (k) => { spend.push(k); },
      beaconAfter: async (_c, slot) => ({ slot: slot + 1, blockhash: bs58.encode(sha512(new TextEncoder().encode(`after-${slot + 1}`)).slice(0, 32)) }),
    });
    opP = await profile(w.seller.publicKey.toBase58(), { isSeller: true });
    buyerP = await profile(w.buyer.publicKey.toBase58());
    houseP = await profile(w.houseSeller.publicKey.toBase58(), { isSeller: true });
  }, 60_000);

  const actor = (p: { id: string; walletAddress: string }) => ({ id: p.id, wallet: p.walletAddress });
  /** Pools of 3 or more cards have two tiers (every third card is rare); smaller ones have one. */
  const makeRequest = (assets: PublicKey[], o: { odds?: typeof TIERS; tiers?: string[]; price?: string; cap?: number; mode?: 'chance' | 'equal_value' } = {}): PackCreateRequest => PackCreateRequest.parse({
    name: { de: 'Testpack', en: 'Test pack' }, mode: o.mode ?? 'chance', price: o.price ?? '10000000', odds: o.odds ?? (assets.length < 3 ? [{ ...TIERS[0]!, bps: 10000 }] : TIERS), perWalletDailyCap: o.cap ?? 5,
    cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: o.tiers?.[i] ?? (assets.length >= 3 && i % 3 === 2 ? 'rare' : 'common'), name: `Card ${i + 1}`, listedValue: String(25_000_000 + i * 1_000_000) })),
  });
  /** An equal-value pack: one tier, every card the same listed value (nothing to cherry-pick). */
  const equalRequest = (assets: PublicKey[], o: { price?: string; cap?: number } = {}): PackCreateRequest => PackCreateRequest.parse({
    name: { de: 'Gleicher Wert', en: 'Equal value' }, mode: 'equal_value', price: o.price ?? '10000000', odds: [{ tier: 'common', label: { de: 'Standard', en: 'Standard' }, bps: 10000 }], perWalletDailyCap: o.cap ?? 5,
    cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: 'common', name: `Card ${i + 1}`, listedValue: '25000000' })),
  });
  /** A wallet with USDC and a profile; its balance is watched so the verifier sees its token delta. */
  async function fundedWallet(amount = 100_000_000n) {
    const k = Keypair.generate();
    const { createAtaIdempotentIx, ataAddress, mintToIx } = await import('@/lib/chain/ix');
    const ata = ataAddress(w.usdc, k.publicKey);
    w.send([createAtaIdempotentIx(w.sa.publicKey, ata, k.publicKey, w.usdc), mintToIx(w.usdc, ata, w.mintAuth.publicKey, amount)], w.sa, [w.mintAuth]);
    watched.push(k.publicKey.toBase58());
    return { k, p: await profile(k.publicKey.toBase58()) };
  }
  /**
   * A live pack with `count` real Core cards owned by the operator. A third party sells equal_value packs (atomic); the house sells chance packs (pay first)
   * unless `mode` says equal_value (the house may sell those too, signed on the operator side by the server).
   */
  async function livePack(count = 6, o: { house?: boolean; cap?: number; price?: string; mode?: 'chance' | 'equal_value' } = {}) {
    const owner = o.house ? w.houseSeller : w.seller;
    const op = o.house ? houseP : opP;
    const mode = o.mode ?? (o.house ? 'chance' : 'equal_value');
    const assets = Array.from({ length: count }, (_, i) => w.consign(`Pack card ${++n}-${i}`, owner));
    const view = await svc.create(actor(op), mode === 'equal_value' ? equalRequest(assets, { cap: o.cap, price: o.price }) : makeRequest(assets, { cap: o.cap, price: o.price }), { isHouse: !!o.house });
    const live = await svc.control(view.id, op.id, 'publish');
    return { id: live.id, assets, op, owner, view: live };
  }
  const earlierOf = (draws: { drawIndex: number | null; status: string; card: { asset: string } | null }[], index: number) => draws.filter((d) => d.drawIndex !== null && d.drawIndex < index).map((d) => ({ drawIndex: d.drawIndex!, status: d.status, cardAsset: d.card?.asset ?? null }));
  const payment = async (id: string, kp: Keypair, p: { txBase64: string }) => b64(partySigns(bytes(p.txBase64), kp));
  /** What the pack operator does on the manage page: asks for the delivery to sign, signs it in their wallet, posts the signature. */
  const deliverAs = async (drawId: string, op = opP, k: Keypair = w.seller) => {
    const prep = await svc.prepareDraw(drawId, op.id);
    return svc.signDraw(drawId, op.id, { role: 'seller', signedTxBase64: b64(partySigns(bytes(prep.txBase64), k)) });
  };
  const buy = async (packId: string, o: { buyer?: Keypair; buyerProfile?: typeof schema.profiles.$inferSelect } = {}) => {
    const bp = o.buyerProfile ?? buyerP, bk = o.buyer ?? w.buyer;
    const opened = await svc.open(actor(bp), packId, { clientSeed: seed(), ageConfirmed: true });
    return { opened, bp, bk };
  };
  /** Both parties sign: the third-party operator and the buyer. */
  async function settle(packId: string, operator: Keypair = w.seller, operatorProfileId = opP.id) {
    const { opened, bp, bk } = await buy(packId);
    const d = opened.draw.id;
    const a = await svc.signDraw(d, bp.id, { role: 'buyer', signedTxBase64: await payment(d, bk, opened.payment) });
    const b = operatorProfileId ? await svc.signDraw(d, operatorProfileId, { role: 'seller', signedTxBase64: await payment(d, operator, opened.payment) }) : null;
    return { opened, a, b, drawId: d };
  }

  it_('one card, one place: a card in a room (or in another pack) cannot go into a pool, and it can again once that listing is over', async () => {
    const assets = Array.from({ length: 4 }, (_, i) => w.consign(`Listed ${++n}-${i}`, w.seller));
    const m = assets[0]!.toBase58();
    // listed in a room: a scheduled show with one queued lot
    const { rows: [show] } = await t!.pool.query(`insert into shows (seller_id, title, status, settlement_mode, mode, cluster) values ($1,'Room','scheduled','onchain','auto',$2) returning id`, [opP.id, cluster]);
    const { rows: [lot] } = await t!.pool.query(
      `insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price) values ($1,$2,1,$3,'core','Lot',1000000,1000000) returning id`, [show.id, opP.id, m]);
    expect((await err(svc.create(actor(opP), makeRequest(assets)))).code).toBe('already_listed');
    expect(Number((await t!.pool.query(`select count(*)::int n from pack_definitions where operator_profile_id = $1 and (select count(*) from pack_pool_cards c where c.pack_id = pack_definitions.id and c.asset = $2) > 0`, [opP.id, m])).rows[0].n)).toBe(0); // nothing half-made
    // the lot ended unsold: free
    await t!.pool.query(`update lots set state = 'passed', closed_at = now() where id = $1`, [lot.id]);
    const first = await svc.create(actor(opP), makeRequest(assets));
    // now the card is in a pool: a second pack with it is refused too, and so is a room
    expect((await err(svc.create(actor(opP), makeRequest(assets)))).code).toBe('already_listed');
    expect((await err(svc.create(actor(opP), makeRequest([assets[1]!, assets[2]!, assets[3]!])))).code).toBe('already_listed');
    // closing the pack frees its cards
    await svc.control(first.id, opP.id, 'close');
    await expect(svc.create(actor(opP), makeRequest(assets))).resolves.toBeTruthy();
  });

  it_('creates a draft, refuses cards the operator does not own, commits the pool on publish and keeps a draft private', async () => {
    const assets = Array.from({ length: 4 }, (_, i) => w.consign(`Draft ${++n}-${i}`, w.seller));
    const draft = await svc.create(actor(opP), makeRequest(assets));
    expect(PackView.parse(draft)).toMatchObject({ status: 'draft', mode: 'chance', cluster, commitment: { poolHash: null, oddsHash: null, committedAt: null }, operator: { wallet: w.seller.publicKey.toBase58(), isHouse: false } });
    expect(draft.price).toBe('10000000');
    // somebody else's card
    const foreign = w.consign(`Foreign ${++n}`, w.attacker);
    expect((await err(svc.create(actor(opP), makeRequest([foreign])))).code).toBe('asset_not_ready'); // one card, one tier
    // a tier with odds but no card
    expect((await err(svc.create(actor(opP), makeRequest(assets, { tiers: ['common', 'common', 'common', 'common'] })))).code).toBe('validation');
    // a draft is the operator's alone
    expect((await err(svc.detail(draft.id, null))).code).toBe('not_found');
    expect((await err(svc.detail(draft.id, buyerP.id))).code).toBe('not_found');
    expect((await svc.detail(draft.id, opP.id)).cards).toHaveLength(4);
    expect((await err(svc.control(draft.id, buyerP.id, 'publish'))).code).toBe('not_seller');
    // publish: the pool is committed, the hash is the one anybody recomputes from the public pool
    const live = await svc.control(draft.id, opP.id, 'publish');
    expect(live.status).toBe('live');
    expect(live.commitment.poolHash).toMatch(/^[0-9a-f]{64}$/);
    expect(live.commitment.committedAt).toBe(clock.toISOString());
    expect(live.vrfPublicKey).toBe(vrf.publicKey);
    const pub = await svc.detail(draft.id, null);
    const poolHash = poolHashOf({ mode: pub.pack.mode, cluster, price: pub.pack.price, operator: pub.pack.operator.wallet, odds: pub.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })), cards: pub.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })) });
    expect(poolHash).toBe(live.commitment.poolHash);
    expect(pub.pack.odds.map((o) => [o.tier, o.bps, o.total, o.remaining])).toEqual([['common', 7000, 3, 3], ['rare', 3000, 1, 1]]);
    // the pool cannot change after the commitment: publishing again is refused, and so is every second commit
    expect((await err(svc.control(draft.id, opP.id, 'publish'))).code).toBe('wrong_state');
    const [row] = await db.select().from(schema.vrfRequests).where(eq(schema.vrfRequests.subjectId, `pack:${draft.id}`));
    expect(row).toMatchObject({ status: 'revealed', beaconSlot: beaconAt.slot, beaconBlockhash: beaconHash, publicKey: vrf.publicKey, cluster });
    // pause, resume, close
    expect((await svc.control(draft.id, opP.id, 'pause')).status).toBe('paused');
    expect((await err(svc.control(draft.id, opP.id, 'pause'))).code).toBe('wrong_state');
    expect((await svc.control(draft.id, opP.id, 'resume')).status).toBe('live');
    expect((await svc.control(draft.id, opP.id, 'close')).status).toBe('closed');
    expect((await err(svc.control(draft.id, opP.id, 'resume'))).code).toBe('wrong_state');
    expect((await svc.list()).some((p) => p.id === draft.id)).toBe(false);
    expect((await svc.list({ operatorProfileId: opP.id })).some((p) => p.id === draft.id)).toBe(true);
  });

  it_('THIRD-PARTY chance packs are allowed again (the buyer pays the operator directly); a platform wallet can never be the operator of a third-party pack; a house pack exists on devnet only', async () => {
    const assets = Array.from({ length: 4 }, (_, i) => w.consign(`Third ${++n}-${i}`, w.seller));
    const view = await svc.create(actor(opP), makeRequest(assets));
    expect(view).toMatchObject({ mode: 'chance', status: 'draft', operator: { wallet: w.seller.publicKey.toBase58(), isHouse: false } });
    const live = await svc.control(view.id, opP.id, 'publish');
    expect(live.status).toBe('live');
    // an operator needs the cards: ownership is checked at create
    const foreign = w.consign(`Foreign ${++n}`, w.attacker);
    expect((await err(svc.create(actor(opP), makeRequest([foreign])))).code).toBe('asset_not_ready');
    // even when the caller claims to be the house: only the house wallet can be the house
    expect((await err(svc.create(actor(opP), makeRequest(assets), { isHouse: true }))).code).toBe('forbidden');
    // a platform wallet (house wallet, fee wallet, settlement authority) never operates a third-party pack: the customer's payment would reach the platform
    const feeP = await profile(w.feeWallet.publicKey.toBase58());
    const saP = await profile(w.sa.publicKey.toBase58());
    expect((await err(svc.create(actor(houseP), makeRequest(assets)))).code).toBe('forbidden');
    expect((await err(svc.create(actor(feeP), makeRequest(assets)))).code).toBe('forbidden');
    expect((await err(svc.create(actor(saP), makeRequest(assets)))).code).toBe('forbidden');
    // the house pack: a devnet demo only. Anywhere else it is refused at create, publish and open, whatever the mode
    const houseAssets = Array.from({ length: 4 }, (_, i) => w.consign(`HouseDemo ${++n}-${i}`, w.houseSeller));
    if (cluster === 'devnet') {
      const hp = await svc.create(actor(houseP), makeRequest(houseAssets), { isHouse: true });
      expect(hp.operator.isHouse).toBe(true);
      expect((await svc.control(hp.id, houseP.id, 'publish')).status).toBe('live');
    } else {
      const e = await err(svc.create(actor(houseP), makeRequest(houseAssets), { isHouse: true }));
      expect(e.code).toBe('forbidden');
      expect(e.message).toMatch(/does not run packs that take your payment/);
      expect((await err(svc.create(actor(houseP), equalRequest(houseAssets), { isHouse: true }))).code).toBe('forbidden');
      // a house pack that an older version left live is not sold, and nothing is charged or counted
      const [old] = await db.insert(schema.packDefinitions).values({
        operatorProfileId: houseP.id, operatorWallet: w.houseSeller.publicKey.toBase58(), isHouse: true, name: { de: 'a', en: 'a' }, mode: 'chance', cluster, price: 10_000_000n, odds: [],
        status: 'live', poolHash: 'ab'.repeat(32), oddsHash: 'cd'.repeat(32), committedAt: new Date(),
      }).returning();
      const refused = await err(svc.open(actor(buyerP), old!.id, { clientSeed: seed(), ageConfirmed: true }));
      expect(refused.code).toBe('wrong_state');
      expect(refused.message).toMatch(/no longer sold/);
      expect(await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, old!.id))).toEqual([]);
      await db.execute(sql`delete from pack_definitions where id = ${old!.id}`);
    }
    expect(JSON.stringify([live])).not.toMatch(/\u2014/);
  });

  it_('the card list is frozen once sales start: after sales (and a pause and a resume) the public pack still hashes to the committed pool hash', async () => {
    const pk = await livePack(4);
    const recompute = async () => {
      const pub = await svc.detail(pk.id, null);
      return { hash: poolHashOf({ mode: pub.pack.mode, cluster, price: pub.pack.price, operator: pub.pack.operator.wallet, odds: pub.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })), cards: pub.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })) }), committed: pub.pack.commitment.poolHash, cards: pub.cards.map((c) => c.asset) };
    };
    const before = await recompute();
    expect(before.hash).toBe(before.committed);
    await settle(pk.id);
    await svc.control(pk.id, opP.id, 'pause');
    await svc.control(pk.id, opP.id, 'resume');
    const after = await recompute();
    expect(after.hash).toBe(before.committed);
    expect(after.cards).toEqual(before.cards);
    // the only writes an operator has are publish, pause, resume and close: a second publish and any change by somebody else are refused
    expect((await err(svc.control(pk.id, opP.id, 'publish'))).code).toBe('wrong_state');
    expect((await err(svc.control(pk.id, buyerP.id, 'close'))).code).toBe('not_seller');
  });

  it_('a third-party equal-value pack sells in ONE co-signed transaction: price to the operator, the card to the buyer, SA only pays; the result is shown after the payment and recomputes', async () => {
    const pack = await livePack(6);
    const buyer0 = w.usdcOf(w.buyer), op0 = w.usdcOf(w.seller), fee0 = w.usdcOf(w.feeWallet);
    const { opened, a, b, drawId } = await settle(pack.id);
    // before the payment the answer holds no result
    expect(PackOpenResponse.parse(opened).draw).toMatchObject({ status: 'reserved', revealed: false, tier: null, card: null, vrf: { requestId: null, input: null, proofHex: null, outputHex: null } });
    expect(opened.payment).toMatchObject({ buyerSigned: false, operatorSigned: false });
    expect(opened.payment.expected as PackExpectedPayment).toMatchObject({ cluster, operator: w.seller.publicKey.toBase58(), buyer: w.buyer.publicKey.toBase58(), usdcMint: w.usdc.toBase58(), gross: '10000000', platformFee: '250000', feePayer: w.sa.publicKey.toBase58() });
    expect(opened.payment.expected.memo).toBe(`hp:pack:${drawId}:${pack.view.commitment.poolHash}`);
    expect(a.step).toBe('awaiting_counterparty');
    expect(b!.step).toBe('settled');
    // money and card
    expect(buyer0 - w.usdcOf(w.buyer)).toBe(10_000_000n);
    expect(w.usdcOf(w.seller) - op0).toBe(9_750_000n);
    expect(w.usdcOf(w.feeWallet) - fee0).toBe(250_000n);
    const view = PackDrawView.parse(b!.draw);
    expect(view).toMatchObject({ status: 'settled', revealed: true, drawIndex: 0, flow: 'atomic', cluster, buyer: w.buyer.publicKey.toBase58() });
    expect(w.ownerOf(new PublicKey(view.card!.asset))).toBe(w.buyer.publicKey.toBase58());
    expect(view.txSignature).toBe(port.sent.at(-1));
    expect(view.settlementRef).toBe(opened.payment.expected.memo);
    expect(view.vrf.input).toContain(`cluster: ${cluster}`);
    expect(spend).toContain('third-party');
    // anybody recomputes it from the public pack and the public log
    const detail = await svc.detail(pack.id, null);
    const log = await svc.listDraws(pack.id);
    const pool: ProofPool = { mode: detail.pack.mode, cluster, price: detail.pack.price, operator: detail.pack.operator.wallet, odds: detail.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })), cards: detail.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })), poolHash: detail.pack.commitment.poolHash!, removed: [] };
    const draw: ProofDraw = { id: view.id, packId: view.packId, drawIndex: view.drawIndex, flow: view.flow, buyer: view.buyer, clientSeed: view.clientSeed, poolHash: view.poolHash, status: view.status, tier: view.tier, cardAsset: view.card!.asset, vrf: { requestId: view.vrf.requestId, input: view.vrf.input, proofHex: view.vrf.proofHex, outputHex: view.vrf.outputHex, params: view.vrf.params ?? null, paramsHash: view.vrf.paramsHash ?? null, beacon: view.vrf.beacon ?? null, publicKey: view.vrf.publicKey ?? null } };
    const checks = await verifyPackDraw(pool, draw, { earlier: earlierOf(log.draws, view.drawIndex!) });
    expect(isPackProven(checks), JSON.stringify(checks)).toBe(true);
    // the pool card is now drawn; the pack count went down
    expect((await svc.detail(pack.id, null)).pack.pool.remaining).toBe(5);
  });

  it_('a house equal-value pack (devnet demo only): the server signs the operator leg at prepare, the buyer signs ONCE and the draw settles', async (): Promise<void> => {
    if (cluster !== 'devnet') return; // on every other network a house pack is refused (see the third-party test above)
    const pack = await livePack(5, { house: true, mode: 'equal_value' });
    const { opened } = await buy(pack.id);
    expect(opened.payment).toMatchObject({ operatorSigned: true, buyerSigned: false });
    const r = await svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: await payment(opened.draw.id, w.buyer, opened.payment) });
    expect(r.step).toBe('settled');
    expect(r.draw.card).not.toBeNull();
    expect(w.ownerOf(new PublicKey(r.draw.card!.asset))).toBe(w.buyer.publicKey.toBase58());
    expect(spend).toContain('house');
  });

  it_('an opening is idempotent: the same seed is the same purchase, a waiting purchase is returned instead of a second one, and it counts once', async () => {
    const pack = await livePack(6, { mode: 'chance' });
    const s = seed();
    const one = await svc.open(actor(buyerP), pack.id, { clientSeed: s, ageConfirmed: true });
    const again = await svc.open(actor(buyerP), pack.id, { clientSeed: s, ageConfirmed: true });
    const other = await svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true });
    expect(again.draw.id).toBe(one.draw.id);
    expect(other.draw.id).toBe(one.draw.id);
    expect(again.payment.txBase64).toBe(one.payment.txBase64); // inside a live round: the same message
    const [c] = await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, pack.id));
    expect(c!.count).toBe(1);
    expect((await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, pack.id)))).toHaveLength(1);
    // after it was paid, the same seed is refused (start again with a new one)
    await svc.signDraw(one.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: await payment(one.draw.id, w.buyer, one.payment) });
    expect((await err(svc.open(actor(buyerP), pack.id, { clientSeed: s, ageConfirmed: true }))).code).toBe('wrong_state');
  });

  it_('the 18+ confirmation is stored with the draw; the operator cannot buy their own pack', async () => {
    const pack = await livePack(4, { mode: 'chance' });
    const { opened } = await buy(pack.id);
    const [row] = await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, opened.draw.id));
    expect(row!.ageConfirmedAt).toEqual(clock);
    const third = await livePack(3);
    expect((await err(svc.open(actor(opP), third.id, { clientSeed: seed(), ageConfirmed: true }))).code).toBe('forbidden');
  });

  it_('the per-wallet daily cap counts every paid purchase, an unpaid one that lapses gives its count back, and it resets the next UTC day', async () => {
    const pack = await livePack(8, { mode: 'chance', cap: 2 });
    const pay = async (p: typeof buyerP, k: Keypair) => {
      const o = await svc.open(actor(p), pack.id, { clientSeed: seed(), ageConfirmed: true });
      const r = await svc.signDraw(o.draw.id, p.id, { role: 'buyer', signedTxBase64: await payment(o.draw.id, k, o.payment) });
      expect(r.step).toBe('submitted'); // paid and drawn: now the operator delivers (nobody else can)
      expect((await deliverAs(o.draw.id)).step).toBe('settled');
      return o;
    };
    // an abandoned (never paid) purchase takes its count while it waits and gives it back when it lapses
    const lapsed = await svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true });
    expect((await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, pack.id)))[0]!.count).toBe(1);
    advance(HOUSE_EXPIRY + 1);
    await svc.sweep(clock);
    expect((await svc.getDraw(lapsed.draw.id)).status).toBe('expired');
    expect((await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, pack.id)))[0]!.count).toBe(0);
    await pay(buyerP, w.buyer);
    await pay(buyerP, w.buyer);
    const refused = await err(svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true }));
    expect(refused.code).toBe('rate_limited');
    expect(refused.extra.retryAfterS).toBeGreaterThan(0);
    // another wallet is not affected (this one is simply poor), and the next UTC day starts from zero
    const other = Keypair.generate();
    await expect(svc.open(actor(await profile(other.publicKey.toBase58())), pack.id, { clientSeed: seed(), ageConfirmed: true })).rejects.toMatchObject({ code: 'insufficient_usdc' });
    clock = new Date('2026-10-06T00:00:01.000Z');
    expect((await svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true })).draw.status).toBe('awaiting_payment');
    clock = T0;
  });

  it_('a pack that cannot be paid for does not use up the day: not enough USDC gives the count back', async () => {
    const pack = await livePack(4, { mode: 'chance', cap: 1 });
    const poor = Keypair.generate();
    const poorP = await profile(poor.publicKey.toBase58());
    await expect(svc.open(actor(poorP), pack.id, { clientSeed: seed(), ageConfirmed: true })).rejects.toMatchObject({ code: 'insufficient_usdc' });
    expect(await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.wallet, poor.publicKey.toBase58()))).toEqual([]);
  });

  it_('(atomic) a card that left the operator\'s wallet before the draw ends the draw, removes the card, pauses the pack and costs the buyer nothing', async () => {
    const pack = await livePack(1, { cap: 3, mode: 'equal_value' }); // one card: the draw cannot miss it
    // the operator sends the card away (a real Core transfer by the owner)
    const { transferV1 } = await import('@metaplex-foundation/mpl-core');
    const { createNoopSigner, publicKey: umiPk } = await import('@metaplex-foundation/umi');
    const u = w.umiFor(w.sa.publicKey);
    const ix = w.ixs(transferV1(u, { asset: { publicKey: umiPk(pack.assets[0]!.toBase58()) } as never, collection: { publicKey: umiPk(w.collection.toBase58()) } as never, authority: createNoopSigner(umiPk(w.seller.publicKey.toBase58())), newOwner: umiPk(w.attacker.publicKey.toBase58()) }) as never);
    w.send(ix, w.sa, [w.seller]);
    const before = w.usdcOf(w.buyer);
    const e = await err(svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true }));
    expect(e.code).toBe('asset_not_ready');
    expect(w.usdcOf(w.buyer)).toBe(before);
    const detail = await svc.detail(pack.id, null);
    expect(detail.pack.status).toBe('paused');
    expect(detail.cards[0]!.status).toBe('removed');
    expect(detail.pack.pool.total).toBe(0);
    const [d] = await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, pack.id));
    expect(d).toMatchObject({ status: 'failed', failureCode: 'asset_not_ready' });
    expect(await db.select().from(schema.packPurchaseCounts).where(eq(schema.packPurchaseCounts.packId, pack.id))).toMatchObject([{ count: 0 }]);
    expect((await err(svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true }))).code).toBe('wrong_state'); // paused
  });

  it_('(atomic) an empty pool stops the pack (sold out); a draw that expires gives its card back and the pack sells again', async () => {
    const pack = await livePack(2, { cap: 5, mode: 'equal_value' });
    const a = await svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true });
    const buyer2 = (await fundedWallet()).p;
    const b = await svc.open(actor(buyer2), pack.id, { clientSeed: seed(), ageConfirmed: true });
    expect(new Set([a.draw.drawIndex, b.draw.drawIndex])).toEqual(new Set([0, 1]));
    const buyer3 = (await fundedWallet()).p;
    expect((await err(svc.open(actor(buyer3), pack.id, { clientSeed: seed(), ageConfirmed: true }))).code).toBe('wrong_state'); // both cards are reserved
    expect((await svc.detail(pack.id, null)).pack.status).toBe('sold_out');
    advance(OPERATOR_WINDOW_S + 1);
    await svc.sweep(clock);
    expect((await svc.getDraw(a.draw.id)).status).toBe('expired');
    const reopened = await svc.detail(pack.id, null);
    expect(reopened.pack.status).toBe('live');
    expect(reopened.pack.pool.remaining).toBe(2);
    expect((await svc.open(actor(buyer3), pack.id, { clientSeed: seed(), ageConfirmed: true })).draw.status).toBe('reserved');
    // an expired draw shows its card (the log is honest), a live one does not
    const expired = await svc.getDraw(a.draw.id);
    expect(expired).toMatchObject({ revealed: true });
    expect(expired.card).not.toBeNull();
  });

  it_('a third-party operator who leaves a paying buyer waiting loses the sale and the pack is paused; the buyer is not blamed', async () => {
    const pack = await livePack(4);
    const { opened } = await buy(pack.id);
    await svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: await payment(opened.draw.id, w.buyer, opened.payment) });
    advance(61); // the round ends with the buyer's signature and no operator signature
    await svc.sweep(clock);
    let [row] = await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, opened.draw.id));
    expect(row).toMatchObject({ status: 'reserved', buyerSignature: null, failureCode: 'operator_absent' }); // the stale signature is gone, the cause is kept
    advance(OPERATOR_WINDOW_S);
    expect((await svc.sweep(clock)).expired).toBeGreaterThanOrEqual(1); // the sweep serves the whole table
    [row] = await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, opened.draw.id));
    expect(row).toMatchObject({ status: 'expired', failureCode: 'operator_absent', preparedMessage: null });
    expect((await svc.detail(pack.id, null)).pack.status).toBe('paused');
    expect((await svc.getDraw(opened.draw.id)).revealed).toBe(true);
  });

  it_('the same while the round is still open; and a pack is never paused when the buyer walks away', async () => {
    const pack = await livePack(4);
    const { opened } = await buy(pack.id);
    await svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: await payment(opened.draw.id, w.buyer, opened.payment) });
    advance(OPERATOR_WINDOW_S + 1); // the whole window passes inside one round's bookkeeping
    expect((await svc.sweep(clock)).expired).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, opened.draw.id)))[0]).toMatchObject({ status: 'expired', failureCode: 'operator_absent' });
    // a buyer who walks away does not pause anybody's pack (the buyer was absent, not the operator)
    const other = await livePack(4, { mode: 'equal_value' });
    const h = await buy(other.id);
    advance(OPERATOR_WINDOW_S + 1);
    await svc.sweep(clock);
    expect((await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, h.opened.draw.id)))[0]).toMatchObject({ status: 'expired', failureCode: 'buyer_absent' });
    expect((await svc.detail(other.id, null)).pack.status).toBe('live');
  });

  it_('a signing round that ends unsigned can be started again, and a signature over a stale message is refused', async () => {
    const pack = await livePack(4, { mode: 'chance' });
    const { opened } = await buy(pack.id);
    const stale = await payment(opened.draw.id, w.buyer, opened.payment);
    port.expireRound();
    advance(61);
    expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: stale }))).code).toBe('round_expired');
    const next = await svc.prepareDraw(opened.draw.id, buyerP.id);
    expect(next.txBase64).not.toBe(opened.payment.txBase64);
    expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: stale }))).code).toBe('tx_mismatch');
    const r = await svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: await payment(opened.draw.id, w.buyer, next) });
    expect(r.step).toBe('submitted'); // paid; the operator delivers next
    expect(r.draw.status).toBe('drawn');
  });

  it_('only the buyer and the operator take part: a stranger cannot prepare or sign, and a changed amount is refused before anything is stored', async () => {
    const pack = await livePack(4);
    const { opened } = await buy(pack.id);
    const strangerP = await profile(Keypair.generate().publicKey.toBase58());
    expect((await err(svc.prepareDraw(opened.draw.id, strangerP.id))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, strangerP.id, { role: 'buyer', signedTxBase64: opened.payment.txBase64 }))).code).toBe('not_party');
    expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'seller', signedTxBase64: opened.payment.txBase64 }))).code).toBe('not_party');
    // a wallet that "signs" a transaction asking the buyer for more
    const { buildUnsignedPackTx } = await import('@/lib/chain/pack-tx');
    const greedy = buildUnsignedPackTx({ ...(opened.payment.expected as PackExpectedPayment), gross: '99000000' }, Transaction.from(bytes(opened.payment.txBase64)).recentBlockhash!);
    expect((await err(svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: b64(partySigns(greedy, w.buyer)) }))).code).toBe('tx_mismatch');
    const [row] = await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, opened.draw.id));
    expect(row!.buyerSignature).toBeNull();
    expect(w.usdcOf(w.buyer)).toBeGreaterThan(0n);
  });

  it_('(atomic) parallel buyers: every card is drawn at most once, draw indexes are strictly increasing, and every draw recomputes', async () => {
    const pack = await livePack(10, { cap: 5, mode: 'equal_value' });
    const wallets: Awaited<ReturnType<typeof fundedWallet>>[] = [];
    for (let i = 0; i < 10; i++) wallets.push(await fundedWallet(20_000_000n));
    const opened = await Promise.all(wallets.map((x) => svc.open(actor(x.p), pack.id, { clientSeed: seed(), ageConfirmed: true })));
    expect(new Set(opened.map((o) => o.draw.drawIndex)).size).toBe(10);
    expect([...opened.map((o) => o.draw.drawIndex as number)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const rows = await db.select().from(schema.packDraws).where(eq(schema.packDraws.packId, pack.id));
    expect(new Set(rows.map((r) => r.cardId)).size).toBe(10);
    // everybody pays
    for (let i = 0; i < wallets.length; i++) {
      await svc.signDraw(opened[i]!.draw.id, wallets[i]!.p.id, { role: 'buyer', signedTxBase64: await payment(opened[i]!.draw.id, wallets[i]!.k, opened[i]!.payment) });
      const r = await svc.signDraw(opened[i]!.draw.id, opP.id, { role: 'seller', signedTxBase64: await payment(opened[i]!.draw.id, w.seller, opened[i]!.payment) });
      expect(r.step).toBe('settled');
    }
    const detail = await svc.detail(pack.id, null);
    expect(detail.pack.status).toBe('sold_out');
    expect(detail.pack.pool).toEqual({ total: 10, remaining: 0 });
    const log = await svc.listDraws(pack.id, { limit: 100 });
    expect(log.draws).toHaveLength(10);
    const pool: ProofPool = { mode: detail.pack.mode, cluster, price: detail.pack.price, operator: detail.pack.operator.wallet, odds: detail.pack.odds.map((o) => ({ tier: o.tier, bps: o.bps })), cards: detail.cards.map((c) => ({ asset: c.asset, tier: c.tier, value: c.listedValue })), poolHash: detail.pack.commitment.poolHash!, removed: [] };
    for (const v of log.draws) {
      const checks = await verifyPackDraw(pool, { id: v.id, packId: v.packId, drawIndex: v.drawIndex, flow: v.flow, buyer: v.buyer, clientSeed: v.clientSeed, poolHash: v.poolHash, status: v.status, tier: v.tier, cardAsset: v.card!.asset, vrf: { requestId: v.vrf.requestId, input: v.vrf.input, proofHex: v.vrf.proofHex, outputHex: v.vrf.outputHex, params: v.vrf.params ?? null, paramsHash: v.vrf.paramsHash ?? null, beacon: v.vrf.beacon ?? null, publicKey: v.vrf.publicKey ?? null } }, { earlier: earlierOf(log.draws, v.drawIndex!) });
      expect(Object.fromEntries(checks.map((c) => [c.id, c.status])), `draw ${v.drawIndex}`).toMatchObject({ pool_hash: 'pass', params: 'pass', alpha: 'pass', proof: 'pass', output: 'pass', result: 'pass', taken: 'pass' });
    }
    // every card went to exactly one buyer
    const owners = detail.cards.map((c) => w.ownerOf(new PublicKey(c.asset)));
    expect(new Set(owners).size).toBe(10);
    expect(owners).not.toContain(w.houseSeller.publicKey.toBase58());
  }, 120_000);

  it_(`uses the ${cluster === 'mainnet-beta' ? 'real mainnet USDC mint' : 'devnet test mint'} and the explorer link of the cluster; the VRF input names the cluster`, async () => {
    const pack = await livePack(3, { mode: 'chance' });
    const { opened } = await buy(pack.id);
    expect((opened.payment.expected as { usdcMint: string }).usdcMint).toBe(cluster === 'mainnet-beta' ? MAINNET_USDC_MINT : w.usdc.toBase58());
    const r = await svc.signDraw(opened.draw.id, buyerP.id, { role: 'buyer', signedTxBase64: await payment(opened.draw.id, w.buyer, opened.payment) });
    const [row] = await db.select().from(schema.packDraws).where(eq(schema.packDraws.id, opened.draw.id));
    expect(row!.vrfInput).toContain(`cluster: ${cluster}`);
    const { drawExplorerUrl } = await import('../views');
    expect(drawExplorerUrl({ txSignature: r.draw.txSignature, cluster })).toBe(`https://explorer.solana.com/tx/${r.draw.txSignature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`);
  });

  it_('a pack of the other cluster is not sold here, and a deployment without the randomness key sells nothing', async () => {
    const pack = await livePack(3, { mode: 'chance' });
    await db.execute(sql`update pack_definitions set cluster = ${cluster === 'devnet' ? 'mainnet-beta' : 'devnet'} where id = ${pack.id}`);
    expect((await err(svc.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true }))).code).toBe('wrong_state');
    await db.execute(sql`update pack_definitions set cluster = ${cluster} where id = ${pack.id}`);
    const noKey = createPackService({ db, chainFor: () => port, sa: w.sa, houseOperator: w.houseSeller, vrfKey: () => null, beacon: async () => beaconAt, beaconAfter: async () => null, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250, defaultCluster: cluster, now: () => clock });
    expect((await err(noKey.open(actor(buyerP), pack.id, { clientSeed: seed(), ageConfirmed: true }))).code).toBe('paused');
    const draft = await noKey.create(actor(opP), equalRequest([w.consign(`NoKey ${++n}`, w.seller)]));
    expect((await err(noKey.control(draft.id, opP.id, 'publish'))).code).toBe('paused');
  });

  it_('(atomic) the public never learns a pending result: reserved cards look available and the log shows no result', async () => {
    const pack = await livePack(4, { mode: 'equal_value' });
    const { opened } = await buy(pack.id);
    const detail = await svc.detail(pack.id, null);
    expect(detail.cards.every((c) => c.status === 'available')).toBe(true);
    expect(detail.pack.pool).toEqual({ total: 4, remaining: 4 });
    const log = await svc.listDraws(pack.id);
    expect(log.draws[0]).toMatchObject({ id: opened.draw.id, status: 'reserved', revealed: false, tier: null, card: null });
    expect(JSON.stringify(log)).not.toContain((opened.payment.expected as PackExpectedPayment).asset);
  });
});

const HOUSE_EXPIRY = 300;
