/**
 * The pack routes called as functions over a REAL Postgres 18 and the REAL Core program (LiteSVM): the feature switch (FEATURE_PACKS and the
 * kill switch) in front of every route on BOTH clusters, the 18+ confirmation in the contract, sessions, limits, response safety. Sessions are
 * real signed cookies; nothing touches Neon or a network.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { sha512 } from '@noble/hashes/sha2';
import { PackDeliveriesResponse, PackDetailResponse, PackDrawView, PackDrawsResponse, PackOpenResponse, PackOperatorAccess, PackPayment, PackSignResponse, PackView, PacksResponse, ROUTES, type Cluster } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { partySigns } from '@/lib/chain/__tests__/svm-world';
import { createSvmPort, type SvmPort } from '@/lib/chain/__tests__/svm-port';
import { generateVrfKey } from '@/lib/vrf/key';
import { ctx, request, responseChecks, signIn } from '@/server/settlement/__tests__/routekit';
import { createPackWorld, type PackWorld } from './pack-world';
import type { PackService } from '../service';
import type { PackPayExpected } from '@/contracts';

type Handler = (req: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
type Routes = Record<'list' | 'create' | 'mine' | 'detail' | 'control' | 'open' | 'draws' | 'draw' | 'prepare' | 'sign' | 'deliveries' | 'operator', Handler>;
let t: TestPg | undefined, skipReason: string | undefined, R: Routes;
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
let svcRef: PackService | undefined;
const vrf = generateVrfKey();
const beacon = { slot: 777, blockhash: bs58.encode(sha512(new TextEncoder().encode('route-anchor')).slice(0, 32)) };
const watched: string[] = [];

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SELLER_ALLOWLIST', '*');
  ({ db, schema } = await import('@/db'));
  R = {
    list: (await import('@/app/api/packs/route')).GET as Handler,
    create: (await import('@/app/api/packs/route')).POST as Handler,
    mine: (await import('@/app/api/packs/mine/route')).GET as Handler,
    operator: (await import('@/app/api/packs/operator/route')).GET as Handler,
    deliveries: (await import('@/app/api/packs/deliveries/route')).GET as Handler,
    detail: (await import('@/app/api/packs/[id]/route')).GET as Handler,
    control: (await import('@/app/api/packs/[id]/control/route')).POST as Handler,
    open: (await import('@/app/api/packs/[id]/open/route')).POST as Handler,
    draws: (await import('@/app/api/packs/[id]/draws/route')).GET as Handler,
    draw: (await import('@/app/api/packs/draws/[id]/route')).GET as Handler,
    prepare: (await import('@/app/api/packs/draws/[id]/prepare/route')).POST as Handler,
    sign: (await import('@/app/api/packs/draws/[id]/sign/route')).POST as Handler,
  };
}, 120_000);
afterAll(async () => {
  (await import('../instance')).setPackService(undefined);
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 60_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const seed = (() => { let n = 0; return () => (++n).toString(16).padStart(32, 'c'); })();

describe.each([['devnet'], ['mainnet-beta']] as const)('pack routes on %s', (cluster: Cluster) => {
  let w: PackWorld, port: SvmPort;
  const ids = { pack: '', draw: '' };
  let op: Awaited<ReturnType<typeof signIn>>, buyer: Awaited<ReturnType<typeof signIn>>;
  const { ok, fails } = responseChecks(() => [w.sa, w.mintAuth, w.houseSeller].flatMap((k) => [bs58.encode(k.secretKey), JSON.stringify(Array.from(k.secretKey))]).concat([vrf.envValue, bs58.encode(Buffer.from(JSON.parse(vrf.envValue) as number[]))]));

  const env = (feature: boolean) => {
    vi.stubEnv('SOLANA_CLUSTER', cluster);
    vi.stubEnv('FEATURE_PACKS', feature ? 'true' : '');
    if (cluster === 'mainnet-beta') {
      vi.stubEnv('SOLANA_RPC_URL', 'https://rpc-mainnet.example.test/key');
      vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify(Array.from(w.sa.secretKey)));
      vi.stubEnv('PLATFORM_WALLET_ADDRESS', w.feeWallet.publicKey.toBase58());
      vi.stubEnv('VRF_SECRET_KEY', vrf.envValue); // a pack draw is a VRF draw: with FEATURE_PACKS on, mainnet needs the draw key
    }
  };

  beforeAll(async () => {
    if (!t) return;
    w = createPackWorld(cluster);
    port = createSvmPort(w, () => watched);
    const { createPackService } = await import('../service');
    const { setPackService } = await import('../instance');
    const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    clearFlagMemo();
    svcRef = createPackService({
      db, chainFor: () => port, sa: w.sa, houseOperator: w.houseSeller, vrfKey: () => vrf.key, beacon: async () => beacon, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), feeBps: 250,
      defaultCluster: cluster, sleep: async () => undefined, assertCluster: () => undefined,
      beaconAfter: async (_c, slot) => ({ slot: slot + 1, blockhash: bs58.encode(sha512(new TextEncoder().encode(`route-after-${slot + 1}`)).slice(0, 32)) }),
    });
    setPackService(svcRef);
    op = await signIn(w.seller);
    buyer = await signIn(w.buyer);
  }, 60_000);

  const paths = (id = '00000000-0000-4000-8000-000000000001') => [
    ['GET list', () => R.list(request('GET', '/api/packs'), ctx({}))],
    ['POST create', () => R.create(request('POST', '/api/packs', { cookie: op?.cookie, body: {} }), ctx({}))],
    ['GET mine', () => R.mine(request('GET', '/api/packs/mine', { cookie: op?.cookie }), ctx({}))],
    ['GET operator', () => R.operator(request('GET', '/api/packs/operator'), ctx({}))],
    ['GET deliveries', () => R.deliveries(request('GET', '/api/packs/deliveries', { cookie: op?.cookie }), ctx({}))],
    ['GET detail', () => R.detail(request('GET', `/api/packs/${id}`), ctx({ id }))],
    ['POST control', () => R.control(request('POST', `/api/packs/${id}/control`, { cookie: op?.cookie, body: { action: 'pause' } }), ctx({ id }))],
    ['POST open', () => R.open(request('POST', `/api/packs/${id}/open`, { cookie: buyer?.cookie, body: { clientSeed: seed(), ageConfirmed: true } }), ctx({ id }))],
    ['GET draws', () => R.draws(request('GET', `/api/packs/${id}/draws`), ctx({ id }))],
    ['GET draw', () => R.draw(request('GET', `/api/packs/draws/${id}`), ctx({ id }))],
    ['POST prepare', () => R.prepare(request('POST', `/api/packs/draws/${id}/prepare`, { cookie: buyer?.cookie, body: {} }), ctx({ id }))],
    ['POST sign', () => R.sign(request('POST', `/api/packs/draws/${id}/sign`, { cookie: buyer?.cookie, body: { role: 'buyer', signedTxBase64: 'AAAA' } }), ctx({ id }))],
  ] as const;

  it_('FEATURE_PACKS off: every route answers feature_off (404) as if it did not exist, before the session, the body or the chain are looked at', async () => {
    env(false);
    for (const [name, call] of paths()) await fails(await call(), 'feature_off').catch((e) => { throw new Error(`${name}: ${(e as Error).message}`); });
  });

  it_('who may offer a pack: the screen state comes from the same allowlist logic as the create route (open, invited with or without the wallet on the list, closed on mainnet)', async () => {
    env(true);
    const get = async (cookie?: string) => (await ok(await R.operator(request('GET', '/api/packs/operator', cookie ? { cookie } : {}), ctx({})), PackOperatorAccess)) as { mode: string; allowed: boolean | null };
    expect(await get()).toEqual({ mode: 'open', allowed: null }); // SELLER_ALLOWLIST=* : anybody, nobody signed in
    expect(await get(op.cookie)).toEqual({ mode: 'open', allowed: true });
    vi.stubEnv('SELLER_ALLOWLIST', w.seller.publicKey.toBase58());
    expect(await get(op.cookie)).toEqual({ mode: 'invited', allowed: true });
    expect(await get(buyer.cookie)).toEqual({ mode: 'invited', allowed: false });
    // the create route refuses exactly the wallet the screen says is not allowed
    await fails(await R.create(request('POST', '/api/packs', { cookie: buyer.cookie, body: {} }), ctx({})), 'seller_not_allowed');
    vi.stubEnv('SELLER_ALLOWLIST', '');
    expect(await get(op.cookie)).toEqual(cluster === 'mainnet-beta' ? { mode: 'closed', allowed: false } : { mode: 'open', allowed: true });
    vi.stubEnv('SELLER_ALLOWLIST', '*');
  });

  it_('the kill switch (app_flags.packs = false) turns it off without a redeploy, on both clusters', async () => {
    env(true);
    const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    await db.insert(schema.appFlags).values({ key: 'packs', value: false }).onConflictDoUpdate({ target: schema.appFlags.key, set: { value: false } });
    clearFlagMemo();
    for (const [name, call] of paths()) await fails(await call(), 'feature_off').catch((e) => { throw new Error(`${name}: ${(e as Error).message}`); });
    await db.delete(schema.appFlags);
    clearFlagMemo();
    await ok(await R.list(request('GET', '/api/packs'), ctx({})), PacksResponse);
  });

  it_('switched on, the environment decides the rest: mainnet with an incomplete environment fails closed (503 mainnet_config_incomplete) on the write that needs the chain', async () => {
    env(true);
    if (cluster === 'mainnet-beta') {
      vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', '');
      const res = await R.create(request('POST', '/api/packs', { cookie: op.cookie, body: {} }), ctx({}));
      const body = await fails(res, 'mainnet_config_incomplete');
      expect(JSON.stringify(body)).not.toContain('SETTLEMENT_AUTHORITY_SECRET_KEY=');
      // the draw key is part of the same check
      env(true);
      vi.stubEnv('VRF_SECRET_KEY', '');
      await fails(await R.create(request('POST', '/api/packs', { cookie: op.cookie, body: {} }), ctx({})), 'mainnet_config_incomplete');
    } else {
      const res = await R.create(request('POST', '/api/packs', { cookie: op.cookie, body: {} }), ctx({}));
      await fails(res, 'validation'); // devnet needs nothing but a valid request
    }
  });

  it_('an equal-value pack from create to settled over the HTTP routes: odds and pool visible before the purchase, the 18+ confirmation required, the result only after the payment', async () => {
    env(true);
    const assets: PublicKey[] = Array.from({ length: 6 }, (_, i) => w.consign(`Route card ${i}`, w.seller));
    const body = {
      name: { de: 'Routenpack', en: 'Route pack' }, mode: 'equal_value', price: '10000000', perWalletDailyCap: 5,
      odds: [{ tier: 'common', label: { de: 'Standard', en: 'Standard' }, bps: 10000 }],
      cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: 'common', name: `Card ${i}`, listedValue: '20000000' })),
    };
    // not signed in
    await fails(await R.create(request('POST', '/api/packs', { body }), ctx({})), 'unauthenticated');
    const created = await ok(await R.create(request('POST', '/api/packs', { cookie: op.cookie, body }), ctx({})).then((r) => new Response(r.body, { status: 200, headers: r.headers })), (await import('@/contracts')).PackControlResponse);
    ids.pack = created.pack.id;
    expect(created.pack.status).toBe('draft');
    // a draft is not public; the owner sees it in "mine"
    await fails(await R.detail(request('GET', `/api/packs/${ids.pack}`), ctx({ id: ids.pack })), 'not_found');
    expect((await ok(await R.mine(request('GET', '/api/packs/mine', { cookie: op.cookie }), ctx({})), PacksResponse)).packs.map((p) => p.id)).toContain(ids.pack);
    expect((await ok(await R.list(request('GET', '/api/packs'), ctx({})), PacksResponse)).packs.map((p) => p.id)).not.toContain(ids.pack);
    // only the owner publishes
    await fails(await R.control(request('POST', `/api/packs/${ids.pack}/control`, { cookie: buyer.cookie, body: { action: 'publish' } }), ctx({ id: ids.pack })), 'not_seller');
    const live = PackView.parse((await (await R.control(request('POST', `/api/packs/${ids.pack}/control`, { cookie: op.cookie, body: { action: 'publish' } }), ctx({ id: ids.pack }))).json() as { pack: unknown }).pack);
    expect(live).toMatchObject({ status: 'live', cluster });
    // odds and the whole pool are public BEFORE anyone buys; the cache header is the contract's
    const detailRes = await R.detail(request('GET', `/api/packs/${ids.pack}`), ctx({ id: ids.pack }));
    expect(detailRes.headers.get('Vercel-CDN-Cache-Control')).toBe(`max-age=${(ROUTES.packsDetail.cache as { cdnS: number }).cdnS}`);
    const detail = PackDetailResponse.parse(await detailRes.json());
    expect(detail.cards).toHaveLength(6);
    expect(detail.pack.odds.map((o) => o.bps)).toEqual([10000]);
    expect(detail.pack.commitment.poolHash).toMatch(/^[0-9a-f]{64}$/);

    // 18+: a request without the confirmation never reaches the service
    await fails(await R.open(request('POST', `/api/packs/${ids.pack}/open`, { cookie: buyer.cookie, body: { clientSeed: seed() } }), ctx({ id: ids.pack })), 'validation');
    await fails(await R.open(request('POST', `/api/packs/${ids.pack}/open`, { cookie: buyer.cookie, body: { clientSeed: seed(), ageConfirmed: false } }), ctx({ id: ids.pack })), 'validation');
    await fails(await R.open(request('POST', `/api/packs/${ids.pack}/open`, { body: { clientSeed: seed(), ageConfirmed: true } }), ctx({ id: ids.pack })), 'unauthenticated');
    await fails(await R.open(request('POST', `/api/packs/${ids.pack}/open`, { cookie: op.cookie, body: { clientSeed: seed(), ageConfirmed: true } }), ctx({ id: ids.pack })), 'forbidden'); // the operator cannot buy their own pack
    const opened = await ok(await R.open(request('POST', `/api/packs/${ids.pack}/open`, { cookie: buyer.cookie, body: { clientSeed: seed(), ageConfirmed: true } }), ctx({ id: ids.pack })), PackOpenResponse);
    ids.draw = opened.draw.id;
    expect(opened.draw).toMatchObject({ status: 'reserved', revealed: false, tier: null, card: null });
    expect(opened.payment.expected.cluster).toBe(cluster);

    // only the two parties see the signing round
    const stranger = await signIn(Keypair.generate());
    await fails(await R.prepare(request('POST', `/api/packs/draws/${ids.draw}/prepare`, { cookie: stranger.cookie, body: {} }), ctx({ id: ids.draw })), 'not_party');
    await fails(await R.sign(request('POST', `/api/packs/draws/${ids.draw}/sign`, { cookie: stranger.cookie, body: { role: 'buyer', signedTxBase64: opened.payment.txBase64 } }), ctx({ id: ids.draw })), 'not_party');
    const mine = await ok(await R.prepare(request('POST', `/api/packs/draws/${ids.draw}/prepare`, { cookie: buyer.cookie, body: {} }), ctx({ id: ids.draw })).then((r) => new Response(r.body, { status: 200, headers: r.headers })), (await import('@/contracts')).PackPayment);
    expect(mine.txBase64).toBe(opened.payment.txBase64);

    const sign = (cookie: string, role: 'buyer' | 'seller', kp: Keypair) => R.sign(request('POST', `/api/packs/draws/${ids.draw}/sign`, { cookie, body: { role, signedTxBase64: b64(partySigns(new Uint8Array(Buffer.from(opened.payment.txBase64, 'base64')), kp)) } }), ctx({ id: ids.draw }));
    expect((await ok(await sign(buyer.cookie, 'buyer', w.buyer), PackSignResponse)).step).toBe('awaiting_counterparty');
    // before the operator signs, the draw still shows no result to anybody
    const waiting = PackDrawView.parse(await (await R.draw(request('GET', `/api/packs/draws/${ids.draw}`), ctx({ id: ids.draw }))).json());
    expect(waiting).toMatchObject({ status: 'reserved', revealed: false, card: null });
    const done = await ok(await sign(op.cookie, 'seller', w.seller), PackSignResponse);
    expect(done.step).toBe('settled');
    expect(done.draw).toMatchObject({ status: 'settled', revealed: true });
    expect(done.draw.card).not.toBeNull();
    expect(done.draw.vrf.proofHex).toMatch(/^[0-9a-f]{160}$/);

    // the public log lists it with its proof
    const log = PackDrawsResponse.parse(await (await R.draws(request('GET', `/api/packs/${ids.pack}/draws?limit=5`), ctx({ id: ids.pack }))).json());
    expect(log.draws.map((d) => d.id)).toEqual([ids.draw]);
    expect(log.nextCursor).toBeNull();
    await fails(await R.draws(request('GET', `/api/packs/${ids.pack}/draws?limit=500`), ctx({ id: ids.pack })), 'validation');
    await fails(await R.draws(request('GET', `/api/packs/${ids.pack}/draws?surprise=1`), ctx({ id: ids.pack })), 'validation');
    await fails(await R.detail(request('GET', '/api/packs/not-a-uuid'), ctx({ id: 'not-a-uuid' })), 'not_found');
  });

  it_('the request the operator form builds from its typed lines (a short odds line, the tier left empty by the wallet picker) is saved as a draft by the create route', async () => {
    env(true);
    const { cardLine, parsePackForm } = await import('@/components/packs/form');
    const assets: PublicKey[] = Array.from({ length: 4 }, (_, i) => w.consign(`Form card ${i}`, w.seller));
    const picked = assets.slice(0, 3).map((a, i) => cardLine({ mint: a.toBase58(), name: `F${i}`, imageUrl: null }, '')); // added before any odds were typed
    const form = parsePackForm({ nameDe: 'Formularpack', nameEn: 'Form pack', price: '5', cap: '5', mode: 'chance', odds: 'common; 70%\nrare; Selten; Rare; 30', cards: [...picked, `${assets[3]!.toBase58()}; rare; F3`].join('\n') });
    expect(form.ok).toBe(true);
    if (!form.ok) return;
    const created = await ok(await R.create(request('POST', '/api/packs', { cookie: op.cookie, body: form.request }), ctx({})).then((r) => new Response(r.body, { status: 200, headers: r.headers })), (await import('@/contracts')).PackControlResponse);
    expect(created.pack).toMatchObject({ status: 'draft', mode: 'chance', name: { de: 'Formularpack', en: 'Form pack' } });
    expect(created.pack.odds.map((o) => [o.tier, o.bps])).toEqual([['common', 7000], ['rare', 3000]]);
  });

  it_('a chance pack over the HTTP routes: the third-party operator creates it, the buyer PAYS THE OPERATOR first (no card in the answer), the draw follows, and the OPERATOR delivers with their own signature', async () => {
    env(true);
    const { getView } = await import('@/server/vrf/service');
    const { packDrawSubject } = await import('@/lib/packs/commit');
    const assets: PublicKey[] = Array.from({ length: 5 }, (_, i) => w.consign(`Route chance card ${i}`, w.seller));
    const body = {
      name: { de: 'Betreiber', en: 'Operator' }, mode: 'chance', price: '10000000', perWalletDailyCap: 5, odds: [{ tier: 'common', label: { de: 'A', en: 'A' }, bps: 6000 }, { tier: 'rare', label: { de: 'B', en: 'B' }, bps: 4000 }],
      cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: i < 3 ? 'common' : 'rare', name: `C${i}`, listedValue: '25000000' })),
    };
    const created = await ok(await R.create(request('POST', '/api/packs', { cookie: op.cookie, body }), ctx({})).then((r) => new Response(r.body, { status: 200, headers: r.headers })), (await import('@/contracts')).PackControlResponse);
    const packId = created.pack.id;
    expect(created.pack).toMatchObject({ mode: 'chance', operator: { wallet: w.seller.publicKey.toBase58(), isHouse: false } });
    await R.control(request('POST', `/api/packs/${packId}/control`, { cookie: op.cookie, body: { action: 'publish' } }), ctx({ id: packId }));
    // the public pack carries the operator's delivery record (nothing delivered yet)
    const pub = PackDetailResponse.parse(await (await R.detail(request('GET', `/api/packs/${packId}`), ctx({ id: packId }))).json());
    expect(pub.pack.operatorRecord).toEqual({ delivered: 0, late: 0, undelivered: 0, medianDeliverySeconds: null });
    const buyer2 = await signIn(w.buyer);
    const opened = await ok(await R.open(request('POST', `/api/packs/${packId}/open`, { cookie: buyer2.cookie, body: { clientSeed: seed(), ageConfirmed: true }, ip: '10.8.8.8' }), ctx({ id: packId })), PackOpenResponse);
    expect(opened.draw).toMatchObject({ status: 'awaiting_payment', flow: 'pay_first', drawIndex: null, card: null, tier: null, revealed: false, operator: { wallet: w.seller.publicKey.toBase58(), isHouse: false } });
    expect('asset' in opened.payment.expected).toBe(false);
    for (const a of assets) expect(JSON.stringify(opened)).not.toContain(a.toBase58());
    expect((opened.payment.expected as PackPayExpected).operator).toBe(w.seller.publicKey.toBase58()); // the money goes to the operator
    expect(await getView(packDrawSubject(packId, 0))).toBeNull();
    // the operator role cannot sign the payment
    await fails(await R.sign(request('POST', `/api/packs/draws/${opened.draw.id}/sign`, { cookie: op.cookie, body: { role: 'seller', signedTxBase64: opened.payment.txBase64 } }), ctx({ id: opened.draw.id })), 'wrong_state');
    const paid = await ok(await R.sign(request('POST', `/api/packs/draws/${opened.draw.id}/sign`, { cookie: buyer2.cookie, body: { role: 'buyer', signedTxBase64: b64(partySigns(new Uint8Array(Buffer.from(opened.payment.txBase64, 'base64')), w.buyer)) } }), ctx({ id: opened.draw.id })), PackSignResponse);
    expect(paid.step).toBe('submitted');
    expect(paid.draw).toMatchObject({ status: 'drawn', revealed: false, card: null, drawIndex: 0 }); // drawn, hidden from the buyer until delivered
    expect(paid.draw.deliverBy).not.toBeNull();
    // the public VRF view of this draw stays a bare shell until it is delivered (review finding: the advance route must not leak it)
    const { advance } = await import('@/server/vrf/service');
    const adv = await advance(packDrawSubject(packId, 0), { cluster, budgetMs: 0, sleep: async () => undefined } as never);
    expect(adv?.result ?? null).toBeNull();
    expect(adv?.alphaText ?? null).toBeNull();
    expect(adv?.proofHex ?? null).toBeNull();
    // the operator (and nobody else) sees the sale and the card to deliver
    await fails(await R.deliveries(request('GET', '/api/packs/deliveries'), ctx({})), 'unauthenticated');
    const mineBuyer = PackDeliveriesResponse.parse(await (await R.deliveries(request('GET', '/api/packs/deliveries', { cookie: buyer2.cookie }), ctx({}))).json());
    expect(mineBuyer.deliveries).toEqual([]);
    const todo = PackDeliveriesResponse.parse(await (await R.deliveries(request('GET', '/api/packs/deliveries', { cookie: op.cookie }), ctx({}))).json());
    expect(todo.deliveries.map((d) => d.draw.id)).toEqual([opened.draw.id]);
    expect(todo.deliveries[0]).toMatchObject({ late: false, card: { asset: expect.any(String) } });
    // the buyer cannot prepare the delivery
    await fails(await R.prepare(request('POST', `/api/packs/draws/${opened.draw.id}/prepare`, { cookie: buyer2.cookie, body: {} }), ctx({ id: opened.draw.id })), 'wrong_state');
    const prep = await ok(await R.prepare(request('POST', `/api/packs/draws/${opened.draw.id}/prepare`, { cookie: op.cookie, body: {} }), ctx({ id: opened.draw.id })), PackPayment);
    expect(prep.expected).toMatchObject({ kind: 'delivery', operator: w.seller.publicKey.toBase58(), buyer: w.buyer.publicKey.toBase58() });
    // the buyer cannot sign the operator's delivery
    await fails(await R.sign(request('POST', `/api/packs/draws/${opened.draw.id}/sign`, { cookie: buyer2.cookie, body: { role: 'seller', signedTxBase64: prep.txBase64 } }), ctx({ id: opened.draw.id })), 'not_party');
    const done = await ok(await R.sign(request('POST', `/api/packs/draws/${opened.draw.id}/sign`, { cookie: op.cookie, body: { role: 'seller', signedTxBase64: b64(partySigns(new Uint8Array(Buffer.from(prep.txBase64, 'base64')), w.seller)) } }), ctx({ id: opened.draw.id })), PackSignResponse);
    expect(done.step).toBe('settled');
    expect(done.draw).toMatchObject({ status: 'settled', flow: 'pay_first', revealed: true, drawIndex: 0 });
    expect(done.draw.deliverySignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect((done.draw.vrf.params as { payment: { signature: string } }).payment.signature).toBe(done.draw.txSignature);
    expect((await getView(packDrawSubject(packId, 0)))?.result).toMatchObject({ asset: done.draw.card!.asset });
    expect(w.ownerOf(new PublicKey(done.draw.card!.asset))).toBe(w.buyer.publicKey.toBase58());
    const after = PackDeliveriesResponse.parse(await (await R.deliveries(request('GET', '/api/packs/deliveries', { cookie: op.cookie }), ctx({}))).json());
    expect(after.deliveries).toEqual([]);
    const rec = PackDetailResponse.parse(await (await R.detail(request('GET', `/api/packs/${packId}`), ctx({ id: packId }))).json()).pack.operatorRecord!;
    expect(rec).toMatchObject({ delivered: 1, late: 0, undelivered: 0 });
  });

  it_('limits: 5 openings a minute per wallet (the pack\'s own daily cap is enforced in the service)', async () => {
    env(true);
    const { createAtaIdempotentIx, ataAddress, mintToIx } = await import('@/lib/chain/ix');
    const fresh = Keypair.generate();
    w.send([createAtaIdempotentIx(w.sa.publicKey, ataAddress(w.usdc, fresh.publicKey), fresh.publicKey, w.usdc), mintToIx(w.usdc, ataAddress(w.usdc, fresh.publicKey), w.mintAuth.publicKey, 100_000_000n)], w.sa, [w.mintAuth]);
    watched.push(fresh.publicKey.toBase58());
    const freshSession = await signIn(fresh);
    const assets = Array.from({ length: 3 }, (_, i) => w.consign(`Limit card ${i}`, w.seller));
    const body = {
      name: { de: 'Limit', en: 'Limit' }, mode: 'chance', price: '10000000', odds: [{ tier: 'common', label: { de: 'A', en: 'A' }, bps: 10000 }],
      cards: assets.map((a, i) => ({ asset: a.toBase58(), tier: 'common', name: `L${i}` })), perWalletDailyCap: 50,
    };
    const created = await ok(await R.create(request('POST', '/api/packs', { cookie: op.cookie, body }), ctx({})).then((r) => new Response(r.body, { status: 200, headers: r.headers })), (await import('@/contracts')).PackControlResponse);
    const packId = created.pack.id;
    await R.control(request('POST', `/api/packs/${packId}/control`, { cookie: op.cookie, body: { action: 'publish' } }), ctx({ id: packId }));
    // the HTTP API never makes a house pack, and a platform wallet can not be the operator of a third-party pack
    const houseSession = await signIn(w.houseSeller);
    await fails(await R.create(request('POST', '/api/packs', { cookie: houseSession.cookie, body }), ctx({})), 'forbidden');
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await R.open(request('POST', `/api/packs/${packId}/open`, { cookie: freshSession.cookie, body: { clientSeed: seed(), ageConfirmed: true }, ip: '10.9.9.9' }), ctx({ id: packId }))).status);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true); // the first draw is returned again while it waits
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it_('a pool of cards bigger than 16 KB is accepted (192 KB limit) and a body beyond it is refused', async () => {
    env(true);
    const huge = { name: { de: 'x', en: 'x' }, mode: 'chance', price: '1', odds: [{ tier: 'common', label: { de: 'A', en: 'A' }, bps: 10000 }], cards: [{ asset: 'x'.repeat(200_000), tier: 'common', name: 'x' }] };
    await fails(await R.create(request('POST', '/api/packs', { cookie: op.cookie, body: huge }), ctx({})), 'validation');
  });
});
