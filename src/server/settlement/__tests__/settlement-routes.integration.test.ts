/**
 * The settlement, readiness and sell routes called as functions (the way AUTH's integration test calls its routes) over a REAL
 * Postgres 18 and the REAL Core program (LiteSVM). Sessions are real signed cookies, requests carry the headers a browser sends,
 * and every body is checked against the contract schema. Nothing touches Neon or a network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { createNoopSigner, publicKey as umiPk } from '@metaplex-foundation/umi';
import { transferV1 } from '@metaplex-foundation/mpl-core';
import { PreparedSettlement, ReadinessResponse, SellAssetsResponse, SettlementView, SignResult, settlementMemo } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ChainError } from '@/lib/chain/errors';
import { createAtaIdempotentIx, mintToIx } from '@/lib/chain/ix';
import { buildUnsignedSettlementTx } from '@/lib/chain/settlement-tx';
import { createWorld, partySigns, BIDS, type World } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import { ctx, request, responseChecks, signIn } from './routekit';

let t: TestPg | undefined, skipReason: string | undefined;
let w: World, port: SvmPort;
const watch: string[] = [];
type Handler = (req: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
let R: { get: Handler; prepare: Handler; sign: Handler; readiness: Handler; sellAssets: (req: Request) => Promise<Response> };
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
let setSellService: typeof import('../sell').setSellService, createSellService: typeof import('../sell').createSellService;
let runSettlementSweep: typeof import('../sweep').runSettlementSweep;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  ({ db, schema } = await import('@/db'));
  const { createSettlementService, setSettlementService } = await import('../service');
  ({ setSellService, createSellService } = await import('../sell'));
  ({ runSettlementSweep } = await import('../sweep'));
  w = createWorld();
  port = createSvmPort(w, () => watch);
  setSettlementService(createSettlementService({
    db, chainFor: () => port, sa: w.sa, houseSeller: w.houseSeller, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(),
    defaultCluster: 'devnet', sleep: async () => undefined, assertCluster: () => undefined,
  }));
  setSellService(createSellService({ db, chainFor: () => port }));
  R = {
    get: (await import('@/app/api/settlements/[id]/route')).GET as Handler,
    prepare: (await import('@/app/api/settlements/[id]/prepare/route')).POST as Handler,
    sign: (await import('@/app/api/settlements/[id]/sign/route')).POST as Handler,
    readiness: (await import('@/app/api/lots/[id]/readiness/route')).POST as Handler,
    sellAssets: (await import('@/app/api/sell/assets/route')).GET,
  };
}, 120_000);
afterAll(async () => {
  const { setSettlementService } = await import('../service');
  setSettlementService(undefined);
  setSellService?.(undefined);
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
beforeEach(() => { if (port) port.height = 1_000; });
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

// ---- helpers --------------------------------------------------------------------------------------------------------------------
const { ok, fails } = responseChecks(() => [w.sa, w.mintAuth, w.houseSeller].flatMap((k) => [bs58.encode(k.secretKey), JSON.stringify(Array.from(k.secretKey))]));

interface Party { kp: Keypair; cookie: string; profileId: string }
async function party(kp = Keypair.generate(), usdc = 0n): Promise<Party> {
  if (kp !== w.houseSeller) watch.push(kp.publicKey.toBase58()); // the port already lists the house wallet; a duplicate would double-count its balance
  if (usdc > 0n) {
    const ata = (await import('@/lib/chain/ix')).ataAddress(w.usdc, kp.publicKey);
    w.send([createAtaIdempotentIx(w.sa.publicKey, ata, kp.publicKey, w.usdc), mintToIx(w.usdc, ata, w.mintAuth.publicKey, usdc)], w.sa, [w.mintAuth]);
  }
  const s = await signIn(kp);
  return { kp, cookie: s.cookie, profileId: s.profileId };
}
const funded = (usdc = 1_000_000_000n) => party(Keypair.generate(), usdc);

let uuidN = 0;
const uuid = () => `dddddddd-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

/** What ENGINE's closeDueLot leaves behind: a sold lot and its awaiting_payment settlement. */
async function sale(o: { buyer: Party; seller: Party; asset?: string; gross?: bigint; dueInMs?: number; standard?: string; lotState?: string }) {
  const asset = o.asset ?? w.consign('Lot ' + ++uuidN, o.seller.kp).toBase58();
  const [show] = await db.insert(schema.shows).values({ sellerId: o.seller.profileId, title: 'Route test show', cluster: 'devnet', settlementMode: 'onchain' }).returning();
  const [lot] = await db.insert(schema.lots).values({ showId: show!.id, sellerId: o.seller.profileId, lotNumber: 1, mintAddress: asset, nftStandard: o.standard ?? 'core', name: 'Card', increment: 1_000_000n, openingPrice: 1_000_000n, state: (o.lotState ?? 'sold') as 'sold' }).returning();
  const gross = o.gross ?? 120_000_000n, fee = (gross * 250n) / 10_000n, id = uuid();
  await db.insert(schema.settlements).values({
    id, lotId: lot!.id, buyerId: o.buyer.profileId, sellerId: o.seller.profileId, grossAmount: gross, platformFee: fee, sellerAmount: gross - fee, status: 'awaiting_payment', rail: 'cosign', cluster: 'devnet',
    mintAddress: asset, dueAt: new Date(Date.now() + (o.dueInMs ?? 900_000)), bidLogHash: BIDS, memo: settlementMemo(id, BIDS),
  });
  return { id, asset, lotId: lot!.id, showId: show!.id };
}
const row = async (id: string) => (await db.select().from(schema.settlements).where(eq(schema.settlements.id, id)))[0]!;
const strikesOf = async (profileId: string) => (await db.select().from(schema.profiles).where(eq(schema.profiles.id, profileId)))[0]!.strikes;

const get = (s: { id: string }, who?: Party) => R.get(request('GET', `/api/settlements/${s.id}`, { cookie: who?.cookie }), ctx({ id: s.id }));
const prepare = (s: { id: string }, who?: Party, ip?: string) => R.prepare(request('POST', `/api/settlements/${s.id}/prepare`, { cookie: who?.cookie, ip }), ctx({ id: s.id }));
const sign = (s: { id: string }, who: Party | undefined, body: unknown) => R.sign(request('POST', `/api/settlements/${s.id}/sign`, { cookie: who?.cookie, body }), ctx({ id: s.id }));
const signedBy = (txBase64: string, kp: Keypair) => Buffer.from(partySigns(new Uint8Array(Buffer.from(txBase64, 'base64')), kp)).toString('base64');
const moveCard = (asset: string, owner: Keypair) => {
  const u = w.umiFor(w.sa.publicKey);
  w.send(w.ixs(transferV1(u, { asset: umiPk(asset), collection: umiPk(w.collection.toBase58()), newOwner: umiPk(w.other.publicKey.toBase58()), authority: createNoopSigner(umiPk(owner.publicKey.toBase58())) }) as never), w.sa, [owner]);
};

// ---- GET /api/settlements/:id ------------------------------------------------------------------------------------------------
describe('GET /api/settlements/:id', () => {
  it_('the buyer and the seller each see it, with their own role; the view matches the contract', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const b = await ok(await get(s, buyer), SettlementView);
    expect(b).toMatchObject({ id: s.id, status: 'awaiting_payment', rail: 'cosign', cluster: 'devnet', attempt: 1, gross: '120000000', platformFee: '3000000', sellerAmount: '117000000', role: 'buyer', buyerSigned: false, sellerSigned: false, roundExpiresAt: null });
    expect((await ok(await get(s, seller), SettlementView)).role).toBe('seller');
  });
  it_('a stranger is not_party, an unknown or malformed id is not_found, no cookie is unauthenticated, a banned wallet is banned', async () => {
    const buyer = await funded(), seller = await party(), stranger = await party();
    const s = await sale({ buyer, seller });
    await fails(await get(s, stranger), 'not_party');
    await fails(await get({ id: uuid() }, buyer), 'not_found');
    await fails(await R.get(request('GET', '/api/settlements/not-a-uuid', { cookie: buyer.cookie }), ctx({ id: 'not-a-uuid' })), 'not_found');
    await fails(await get(s), 'unauthenticated');
    await db.update(schema.profiles).set({ isBanned: true }).where(eq(schema.profiles.id, stranger.profileId));
    await fails(await get(s, stranger), 'banned');
  });
  it_('a read finalizes lazily: a transaction that landed while the RPC was cut off becomes settled on the next GET', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    port.dieAfterLanding = true;
    await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }); // the node dies after accepting it: submitted or settled
    const v = await ok(await get(s, buyer), SettlementView);
    expect(v.status).toBe('settled');
    expect(v.explorerUrl).toMatch(/explorer\.solana\.com\/tx\/.+\?cluster=devnet/);
  });
  it_('while the chain is unreachable a read still answers with the stored state', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    await db.update(schema.settlements).set({ status: 'submitted', txSignature: 'T'.repeat(88), lastValidHeight: 5_000 }).where(eq(schema.settlements.id, s.id));
    const real = port.getSignatureStatus;
    port.getSignatureStatus = async () => { throw new ChainError('rpc_unavailable', 'down'); };
    try { expect((await ok(await get(s, buyer), SettlementView)).status).toBe('submitted'); } finally { port.getSignatureStatus = real; }
  });
});

// ---- prepare ---------------------------------------------------------------------------------------------------------------
describe('POST /api/settlements/:id/prepare', () => {
  it_('opens a round for the buyer; the seller gets the same message; calling again changes nothing (idempotent)', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const a = await ok(await prepare(s, buyer), PreparedSettlement);
    expect(a).toMatchObject({ attempt: 1, buyerSigned: false, sellerSigned: false });
    expect(a.expected.feePayer).toBe(w.sa.publicKey.toBase58());
    expect(a.expected.memo).toBe(settlementMemo(s.id, BIDS));
    const b = await ok(await prepare(s, seller), PreparedSettlement);
    const c = await ok(await prepare(s, buyer), PreparedSettlement);
    expect(b.txBase64).toBe(a.txBase64);
    expect(c.txBase64).toBe(a.txBase64);
    expect((await row(s.id)).attempt).toBe(1);
  });
  it_('errors: not_party, not_found, unauthenticated, validation, cross-origin, wrong_state', async () => {
    const buyer = await funded(), seller = await party(), stranger = await party();
    const s = await sale({ buyer, seller });
    await fails(await prepare(s, stranger), 'not_party');
    await fails(await prepare({ id: uuid() }, buyer), 'not_found');
    await fails(await prepare(s), 'unauthenticated');
    await fails(await R.prepare(request('POST', `/api/settlements/${s.id}/prepare`, { cookie: buyer.cookie, body: { extra: 1 } }), ctx({ id: s.id })), 'validation');
    await fails(await R.prepare(request('POST', `/api/settlements/${s.id}/prepare`, { cookie: buyer.cookie, headers: { origin: 'https://evil.example' } }), ctx({ id: s.id })), 'forbidden');
    await db.update(schema.settlements).set({ status: 'expired' }).where(eq(schema.settlements.id, s.id));
    await fails(await prepare(s, buyer), 'wrong_state');
  });
  it_('insufficient_usdc (the buyer is short), asset_not_ready (the card moved: the seller is struck), balance_unavailable and rpc_unavailable', async () => {
    const poor = await funded(1_000_000n), seller = await party();
    await fails(await prepare(await sale({ buyer: poor, seller }), poor), 'insufficient_usdc');

    const buyer = await funded();
    const moved = await sale({ buyer, seller });
    moveCard(moved.asset, seller.kp);
    const body = await fails(await prepare(moved, buyer), 'asset_not_ready');
    expect(body.reason).toMatch(/can no longer be transferred/);
    expect(await row(moved.id)).toMatchObject({ status: 'failed', failureCode: 'asset_not_ready' });
    expect(await strikesOf(seller.profileId)).toBe(1);

    const s = await sale({ buyer, seller });
    const bal = port.getUsdcBalance;
    port.getUsdcBalance = async () => { throw new ChainError('balance_unavailable', 'try again'); };
    try { await fails(await prepare(s, buyer), 'balance_unavailable'); } finally { port.getUsdcBalance = bal; }
    const bh = port.getLatestBlockhash;
    port.getLatestBlockhash = async () => { throw new ChainError('rpc_unavailable', 'every endpoint failed'); };
    try { await fails(await prepare(s, buyer), 'rpc_unavailable'); } finally { port.getLatestBlockhash = bh; }
    expect((await row(s.id)).status).toBe('awaiting_payment'); // nothing changed
  });
  it_('the 7th prepare inside a minute is rate_limited with Retry-After', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    for (let i = 0; i < 6; i++) await ok(await prepare(s, buyer), PreparedSettlement);
    const res = await prepare(s, buyer);
    const body = await fails(res, 'rate_limited');
    expect(res.headers.get('retry-after')).toBe(String(body.retryAfterS));
    expect(body.retryAfterS).toBeGreaterThan(0);
  });
});

// ---- the operator's kill switch ----------------------------------------------------------------------------------------------
describe('the settlement kill switch (app_flags.settlement = false)', () => {
  it_('stops prepare and sign with 503 paused before any chain call, still lets a party read, and works again when switched back on', async () => {
    const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const set = async (v: boolean | null) => {
      if (v === null) await t!.pool.query(`delete from app_flags where key = 'settlement'`);
      else await t!.pool.query(`insert into app_flags (key, value) values ('settlement', $1::jsonb) on conflict (key) do update set value = $1::jsonb`, [JSON.stringify(v)]);
      clearFlagMemo();
    };
    await set(false);
    try {
      expect((await fails(await prepare(s, buyer), 'paused')).reason).toMatch(/switched off/);
      await fails(await sign(s, buyer, { role: 'buyer', signedTxBase64: 'AAAA' }), 'paused');
      await ok(await get(s, buyer), SettlementView);
      expect((await row(s.id)).preparedMessage).toBeNull(); // nothing was opened
    } finally { await set(null); }
    await ok(await prepare(s, buyer), PreparedSettlement);
  });
});

// ---- sign: the whole co-sign settlement through the handlers -----------------------------------------------------------------
describe('POST /api/settlements/:id/sign', () => {
  it_('full co-sign: buyer signs, seller signs, SA pays; both wallets hold 0 SOL and the card and the money move', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const sellerUsdc0 = w.usdcOf(seller.kp.publicKey), fee0 = w.usdcOf(w.feeWallet), sa0 = w.sol(w.sa);
    const p = await ok(await prepare(s, buyer), PreparedSettlement);

    const r1 = await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    expect(r1.step).toBe('awaiting_counterparty');
    expect(r1.settlement).toMatchObject({ buyerSigned: true, sellerSigned: false, role: 'buyer' });
    expect(new Date(r1.settlement.roundExpiresAt!).getTime()).toBeGreaterThan(Date.now());
    // the seller's side of the same round, seen by the seller
    expect(await ok(await get(s, seller), SettlementView)).toMatchObject({ buyerSigned: true, sellerSigned: false, role: 'seller' });

    const r2 = await ok(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), SignResult);
    expect(r2.step).toBe('settled');
    expect(r2.settlement).toMatchObject({ status: 'settled', role: 'seller' });
    expect(r2.settlement.txSignature).toBe(port.sent.at(-1));
    expect(new PublicKey(w.ownerOf(new PublicKey(s.asset))).toBase58()).toBe(buyer.kp.publicKey.toBase58());
    expect(w.usdcOf(seller.kp.publicKey) - sellerUsdc0).toBe(117_000_000n);
    expect(w.usdcOf(w.feeWallet) - fee0).toBe(3_000_000n);
    expect(w.sol(buyer.kp)).toBe(0n);
    expect(w.sol(seller.kp)).toBe(0n);
    expect(sa0 - w.sol(w.sa)).toBeGreaterThan(0n); // SA paid the fee and the account rent
    expect(await row(s.id)).toMatchObject({ status: 'settled', buyerSignature: null, sellerSignature: null });
  });
  it_('seller first, then buyer, settles the same way', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, seller), PreparedSettlement);
    expect((await ok(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), SignResult)).step).toBe('awaiting_counterparty');
    expect((await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult)).step).toBe('settled');
  });
  it_('house show: prepare already carries the server-signed seller leg, so the buyer signs once', async () => {
    const buyer = await funded(), house = await party(w.houseSeller);
    const s = await sale({ buyer, seller: house, asset: w.consign('House lot', w.houseSeller).toBase58() });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    expect(p).toMatchObject({ buyerSigned: false, sellerSigned: true });
    const r = await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    expect(r.step).toBe('settled');
    expect(w.ownerOf(new PublicKey(s.asset))).toBe(buyer.kp.publicKey.toBase58());
    expect(w.sol(buyer.kp)).toBe(0n);
  });
  it_('role and session must agree: the body alone never decides who is signing (not_party), and nothing is stored', async () => {
    const buyer = await funded(), seller = await party(), stranger = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    await fails(await sign(s, buyer, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), 'not_party'); // buyer's session claiming the seller role
    await fails(await sign(s, seller, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), 'not_party'); // and the other way round
    await fails(await sign(s, stranger, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), 'not_party');
    await fails(await sign(s, stranger, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), 'not_party');
    expect(await row(s.id)).toMatchObject({ buyerSignature: null, sellerSignature: null });
  });
  it_('refuses what is not the prepared message or not the party\'s own signature: tx_mismatch, bad_signature; nothing is stored', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    const otherAmount = Buffer.from(partySigns(buildUnsignedSettlementTx({ ...p.expected, gross: '119000000', platformFee: '2975000' }, w.svm.latestBlockhash()), seller.kp)).toString('base64');
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: otherAmount }), 'tx_mismatch');
    const t0 = Transaction.from(Buffer.from(p.txBase64, 'base64')); // the right message carrying someone else's signature in the seller slot
    t0.addSignature(seller.kp.publicKey, Buffer.from((await import('tweetnacl')).default.sign.detached(t0.serializeMessage(), w.attacker.secretKey)));
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: t0.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64') }), 'bad_signature');
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: p.txBase64 }), 'bad_signature'); // unsigned bytes
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: '!!not base64!!' }), 'validation');
    await fails(await sign(s, seller, { role: 'seller' }), 'validation');
    await fails(await sign(s, seller, { role: 'both', signedTxBase64: p.txBase64 }), 'validation');
    expect(await row(s.id)).toMatchObject({ buyerSignature: null, sellerSignature: null });
  });
  it_('double submit: the same signature twice stores once, and after the settlement a repeat re-sends nothing', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    const buyerBody = { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) };
    const sent0 = port.sent.length;
    expect((await ok(await sign(s, buyer, buyerBody), SignResult)).step).toBe('awaiting_counterparty');
    expect((await ok(await sign(s, buyer, buyerBody), SignResult)).step).toBe('awaiting_counterparty');
    expect(port.sent.length).toBe(sent0);
    const sellerBody = { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) };
    const [a, b] = await Promise.all([sign(s, seller, sellerBody), sign(s, seller, sellerBody)]); // two tabs, one click each
    for (const r of [a, b]) expect(['settled', 'submitted']).toContain((await ok(r, SignResult)).step);
    expect(port.sent.length - sent0).toBe(1);
    const again = await ok(await sign(s, buyer, buyerBody), SignResult);
    expect(again.step).toBe('settled');
    expect(port.sent.length - sent0).toBe(1);
  });
  it_('an expired round: late signatures get round_expired; prepare opens attempt 2 with a fresh message and it settles', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p1 = await ok(await prepare(s, buyer), PreparedSettlement);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p1.txBase64, buyer.kp) }), SignResult);
    await db.update(schema.settlements).set({ roundExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.settlements.id, s.id)); // the minute is over
    port.expireRound();
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p1.txBase64, seller.kp) }), 'round_expired');
    expect(await ok(await get(s, buyer), SettlementView)).toMatchObject({ buyerSigned: false, roundExpiresAt: null }); // the buyer's old signature is gone
    const p2 = await ok(await prepare(s, seller), PreparedSettlement);
    expect(p2.attempt).toBe(2);
    expect(p2.txBase64).not.toBe(p1.txBase64);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p2.txBase64, buyer.kp) }), SignResult);
    expect((await ok(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p2.txBase64, seller.kp) }), SignResult)).step).toBe('settled');
  });
  it_('a round whose blockhash died on chain before the second signature is round_expired and nothing is sent', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    port.height += 1_000;
    const sent0 = port.sent.length;
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), 'round_expired');
    expect(port.sent.length).toBe(sent0);
  });
  it_('wrong_state on a settlement that is no longer open; unknown id is not_found; unauthenticated', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    const body = { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) };
    await fails(await sign({ id: uuid() }, buyer, body), 'not_found');
    await fails(await sign(s, undefined, body), 'unauthenticated');
    await db.update(schema.settlements).set({ status: 'expired' }).where(eq(schema.settlements.id, s.id));
    await fails(await sign(s, buyer, body), 'wrong_state');
  });
  it_('a card that moved after the hammer fails atomically (simulation_failed), the buyer keeps the USDC; a dead RPC at send time is rpc_unavailable', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    const h = port.getBlockHeight;
    port.getBlockHeight = async () => { throw new ChainError('rpc_unavailable', 'down'); };
    try { await fails(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), 'rpc_unavailable'); } finally { port.getBlockHeight = h; }
    moveCard(s.asset, seller.kp);
    const usdc0 = w.usdcOf(buyer.kp.publicKey), sent0 = port.sent.length;
    await fails(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), 'simulation_failed');
    expect(w.usdcOf(buyer.kp.publicKey)).toBe(usdc0);
    expect(port.sent.length).toBe(sent0);
  });
});

// ---- the sweep hook -----------------------------------------------------------------------------------------------------------
describe('runSettlementSweep', () => {
  it_('expires an overdue settlement with the strike on the party that did not act, and drops the stored signature', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    await db.update(schema.settlements).set({ dueAt: new Date(Date.now() - 1000) }).where(eq(schema.settlements.id, s.id));
    const r = await runSettlementSweep(new Date());
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await row(s.id)).toMatchObject({ status: 'expired', buyerSignature: null, sellerSignature: null });
    expect(await strikesOf(seller.profileId)).toBe(1);
    expect(await strikesOf(buyer.profileId)).toBe(0);
    expect((await runSettlementSweep(new Date())).expired).toBe(0); // idempotent
    expect(await strikesOf(seller.profileId)).toBe(1);
  });
  it_('finalizes a transaction that landed while the node could not confirm it, and drops signatures of a round that ended', async () => {
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const p = await ok(await prepare(s, buyer), PreparedSettlement);
    await ok(await sign(s, buyer, { role: 'buyer', signedTxBase64: signedBy(p.txBase64, buyer.kp) }), SignResult);
    const status = port.getSignatureStatus;
    port.getSignatureStatus = async () => { throw new ChainError('rpc_unavailable', 'down'); }; // the transaction lands, then the node stops answering
    try { await fails(await sign(s, seller, { role: 'seller', signedTxBase64: signedBy(p.txBase64, seller.kp) }), 'rpc_unavailable'); } finally { port.getSignatureStatus = status; }
    expect((await row(s.id)).status).toBe('submitted');

    const stale = await sale({ buyer, seller });
    const sp = await ok(await prepare(stale, buyer), PreparedSettlement);
    await ok(await sign(stale, buyer, { role: 'buyer', signedTxBase64: signedBy(sp.txBase64, buyer.kp) }), SignResult);
    await db.update(schema.settlements).set({ roundExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.settlements.id, stale.id));

    const r = await runSettlementSweep(new Date());
    expect(r.finalized).toBeGreaterThanOrEqual(1);
    expect(await row(s.id)).toMatchObject({ status: 'settled', buyerSignature: null, sellerSignature: null });
    expect(w.ownerOf(new PublicKey(s.asset))).toBe(buyer.kp.publicKey.toBase58());
    expect(await row(stale.id)).toMatchObject({ status: 'awaiting_payment', buyerSignature: null });
  });
});

// ---- readiness --------------------------------------------------------------------------------------------------------------
describe('POST /api/lots/:id/readiness', () => {
  const readiness = (lotId: string, who?: Party) => R.readiness(request('POST', `/api/lots/${lotId}/readiness`, { cookie: who?.cookie }), ctx({ id: lotId }));
  async function catalogued(seller: Party, o: { asset?: string; standard?: string } = {}) {
    const asset = o.asset ?? w.consign('Card ' + ++uuidN, seller.kp).toBase58();
    const [show] = await db.insert(schema.shows).values({ sellerId: seller.profileId, title: 'Readiness show', cluster: 'devnet', settlementMode: 'onchain' }).returning();
    const [lot] = await db.insert(schema.lots).values({ showId: show!.id, sellerId: seller.profileId, lotNumber: 1, mintAddress: asset, nftStandard: o.standard ?? 'core', name: 'Card', increment: 1_000_000n, openingPrice: 1_000_000n, consignStatus: 'pending' }).returning();
    return { lotId: lot!.id, asset };
  }
  const status = async (lotId: string) => (await db.select().from(schema.lots).where(eq(schema.lots.id, lotId)))[0]!.consignStatus;

  it_('a Core card the seller owns is ready; once it moves the answer is not_owner and the lot is rejected (a normal 200, not an error)', async () => {
    const seller = await party();
    const l = await catalogued(seller);
    expect(await ok(await readiness(l.lotId, seller), ReadinessResponse)).toEqual({ ok: true, readiness: { eligible: true, reasons: [] }, consign: 'ready' });
    expect(await status(l.lotId)).toBe('ready');
    moveCard(l.asset, seller.kp);
    expect(await ok(await readiness(l.lotId, seller), ReadinessResponse)).toEqual({ ok: true, readiness: { eligible: false, reasons: ['not_owner'] }, consign: 'rejected' });
    expect(await status(l.lotId)).toBe('rejected');
  });
  it_('a pNFT or a card that does not exist is rejected with a reason; a sold lot keeps its flag', async () => {
    const seller = await party();
    const p = await catalogued(seller, { standard: 'pnft' });
    expect((await ok(await readiness(p.lotId, seller), ReadinessResponse)).readiness.reasons).toEqual(['unsupported_standard']);
    const missing = await catalogued(seller, { asset: Keypair.generate().publicKey.toBase58() });
    expect((await ok(await readiness(missing.lotId, seller), ReadinessResponse)).readiness.reasons).toEqual(['not_found']);
    const sold = await catalogued(seller);
    await db.update(schema.lots).set({ state: 'sold', consignStatus: 'ready' }).where(eq(schema.lots.id, sold.lotId));
    moveCard(sold.asset, seller.kp);
    expect((await ok(await readiness(sold.lotId, seller), ReadinessResponse)).consign).toBe('ready');
  });
  it_('errors: not_seller, not_found, unauthenticated, rpc_unavailable (and the lot is left alone)', async () => {
    const seller = await party(), other = await party();
    const l = await catalogued(seller);
    await fails(await readiness(l.lotId, other), 'not_seller');
    await fails(await readiness(uuid(), seller), 'not_found');
    await fails(await R.readiness(request('POST', '/api/lots/xyz/readiness', { cookie: seller.cookie }), ctx({ id: 'xyz' })), 'not_found');
    await fails(await readiness(l.lotId), 'unauthenticated');
    const real = port.readAsset;
    port.readAsset = async () => { throw new ChainError('rpc_unavailable', 'down'); };
    try { await fails(await readiness(l.lotId, seller), 'rpc_unavailable'); } finally { port.readAsset = real; }
    expect(await status(l.lotId)).toBe('pending');
  });
});

// ---- sell/assets ------------------------------------------------------------------------------------------------------------
describe('GET /api/sell/assets', () => {
  const list = (who?: Party, query = '') => R.sellAssets(request('GET', `/api/sell/assets${query}`, { cookie: who?.cookie }));
  async function replica(owner: Keypair, name: string) {
    const mint = w.consign(name, owner).toBase58();
    await db.insert(schema.devnetAssets).values({ mint, ownerWallet: owner.publicKey.toBase58(), name, imageUrl: 'https://d1xpxki1g4htqu.cloudfront.net/x', attributes: [{ trait_type: 'Grade', value: 'MINT 9' }, { trait_type: 'Grading Company', value: 'PSA' }] });
    return mint;
  }

  it_('devnet: the wallet\'s replicas from devnet_assets with the on-chain owner read; a card that moved is flagged not_owner; the consign flag shows', async () => {
    const seller = await party();
    const a = await replica(seller.kp, 'Replica A'), b = await replica(seller.kp, 'Replica B');
    await db.insert(schema.devnetAssets).values({ mint: Keypair.generate().publicKey.toBase58(), ownerWallet: Keypair.generate().publicKey.toBase58(), name: 'Somebody else', attributes: [] });
    const [show] = await db.insert(schema.shows).values({ sellerId: seller.profileId, title: 'x', cluster: 'devnet', settlementMode: 'onchain' }).returning();
    await db.insert(schema.lots).values({ showId: show!.id, sellerId: seller.profileId, lotNumber: 1, mintAddress: a, nftStandard: 'core', name: 'A', increment: 1n, openingPrice: 1n, consignStatus: 'ready' });
    moveCard(b, seller.kp);
    const { assets } = await ok(await list(seller), SellAssetsResponse);
    expect(assets).toHaveLength(2);
    const byMint = Object.fromEntries(assets.map((x) => [x.mint, x]));
    // replica A sits in a queued lot, so it is already listed: not eligible, with the reason and where it is (one card, one place)
    expect(byMint[a]).toMatchObject({ name: 'Replica A', standard: 'core', eligible: false, reasons: ['already_listed'], listed: { kind: 'lot', showId: show!.id }, consign: 'ready', grade: 'PSA MINT 9', imageUrl: 'https://d1xpxki1g4htqu.cloudfront.net/x' });
    expect(byMint[b]).toMatchObject({ eligible: false, reasons: ['not_owner'], consign: 'none' });
  });
  it_('devnet: a replica the wallet WON in a settled sale is listed too (owner_wallet only says where it was minted to); one still awaiting payment is not', async () => {
    const buyer = await funded(), seller = await party();
    const wonMint = await replica(seller.kp, 'Won card'), waitingMint = await replica(seller.kp, 'Waiting card');
    const won = await sale({ buyer, seller, asset: wonMint }), waiting = await sale({ buyer, seller, asset: waitingMint });
    await db.update(schema.settlements).set({ status: 'settled', settledAt: new Date() }).where(eq(schema.settlements.id, won.id));
    const { assets } = await ok(await list(buyer), SellAssetsResponse);
    expect(assets.map((x) => x.mint)).toEqual([wonMint]); // the on-chain owner read still decides whether it can be sold
    expect(assets[0]).toMatchObject({ name: 'Won card', grade: 'PSA MINT 9' });
    expect(waiting.asset).toBe(waitingMint);
  });
  it_('errors: unauthenticated, a cluster other than the deployment\'s is refused plainly, a bad cluster value, rpc_unavailable', async () => {
    const seller = await party();
    await replica(seller.kp, 'Replica C');
    await fails(await list(), 'unauthenticated');
    const body = await fails(await list(seller, '?cluster=mainnet-beta'), 'validation');
    expect(body.reason).toMatch(/runs on devnet/);
    await fails(await list(seller, '?cluster=moon'), 'validation');
    expect((await ok(await list(seller, '?cluster=devnet'), SellAssetsResponse)).assets).toHaveLength(1);
    const real = port.readAsset;
    port.readAsset = async () => { throw new ChainError('rpc_unavailable', 'down'); };
    try { await fails(await list(seller), 'rpc_unavailable'); } finally { port.readAsset = real; }
  });
  it_('mainnet: Collector Crypt Core assets from DAS, each with its reasons (frozen, standard); no devnet table is read', async () => {
    const seller = await party();
    const mk = (over: object) => ({ mint: Keypair.generate().publicKey.toBase58(), standard: 'core' as const, owner: seller.kp.publicKey.toBase58(), collection: 'CCryptUfeFSZ3Fgc9FLeKrhLVAP67FSqi1GuVoj9CRac', name: 'Charizard', imageUrl: 'https://img/x.png', frozen: false, compressed: false, burnt: false, royaltyBlocksOwnerTransfer: false, blockingDelegate: null, ...over });
    const items = [mk({}), mk({ frozen: true, name: 'Frozen one' }), mk({ standard: 'pnft', name: 'A pNFT' })];
    const asked: string[] = [];
    setSellService(createSellService({ db, chainFor: () => port, das: async (wallet) => { asked.push(wallet); return items; } }));
    vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta');
    try {
      const { assets } = await ok(await list(seller), SellAssetsResponse);
      expect(asked).toEqual([seller.kp.publicKey.toBase58()]);
      expect(assets.map((x) => [x.name, x.eligible, x.reasons])).toEqual([['Charizard', true, []], ['Frozen one', false, ['frozen']], ['A pNFT', false, ['unsupported_standard']]]);
    } finally {
      vi.stubEnv('SOLANA_CLUSTER', 'devnet');
      setSellService(createSellService({ db, chainFor: () => port }));
    }
  });
});

describe('no route answers with a key or the settlement authority\'s balance', () => {
  it_('the secrets and "lamports" never appear in an error or a success body (checked by every helper above); a spot check on the paused path', async () => {
    const { getSettlementService, setSettlementService } = await import('../service');
    const keep = getSettlementService();
    setSettlementService(undefined);
    const env = { ...process.env };
    delete process.env.SETTLEMENT_AUTHORITY_SECRET_KEY;
    process.env.PLATFORM_WALLET_ADDRESS = w.feeWallet.publicKey.toBase58();
    const buyer = await funded(), seller = await party();
    const s = await sale({ buyer, seller });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const body = await fails(await prepare(s, buyer), 'paused'); // no key: 503 "payments are paused", not a 500 and not a crash
      expect(body.reason).not.toMatch(/KEY|SECRET|SETTLEMENT_AUTHORITY/);
      expect(spy.mock.calls.flat().join(' ')).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/); // no key-sized string in the logs
      // FEE_PAYER=buyer is not built: with a good key it is still refused loudly (paused), not silently ignored
      process.env.SETTLEMENT_AUTHORITY_SECRET_KEY = JSON.stringify(Array.from(w.sa.secretKey));
      process.env.FEE_PAYER = 'buyer';
      const body2 = await fails(await prepare(s, buyer), 'paused');
      expect(body2.reason).not.toMatch(/FEE_PAYER|buyer/);
    } finally {
      spy.mockRestore();
      process.env = env as NodeJS.ProcessEnv;
      setSettlementService(keep);
    }
  });
});

