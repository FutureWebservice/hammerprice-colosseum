/**
 * The AI routes called as functions over a REAL Postgres 18 and LiteSVM (the way the settlement routes are tested): sessions are real signed
 * cookies, requests carry what a browser sends, every body is checked against its contract schema. The model is the built-in mock (AI_MOCK=1):
 * no network, no key. The adapter itself is tested against a fake Google in src/server/ai/__tests__.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AiAskResponse, AiCreditsResponse, AiListingResponse, AiPurchaseView, AiCreditsQuoteResponse, PaymentRequiredBody, ROUTES, MAINNET_NOT_USED } from './contracts-shim';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ctx, freshIp, request, responseChecks, signIn } from '@/server/settlement/__tests__/routekit';
import { createCreditWorld, walletSigns, type CreditWorld } from '@/server/credits/__tests__/credit-world';

void MAINNET_NOT_USED;
let t: TestPg | undefined, skipReason: string | undefined;
let w: CreditWorld;
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
type Handler = (req: Request, c?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let R: { credits: Handler; quote: Handler; pay: Handler; purchase: Handler; listing: Handler; ask: Handler };
let book: typeof import('@/server/credits/ledger').book;
let sa: Keypair;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 15 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  sa = Keypair.generate();
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('FEATURE_AI', 'true');
  vi.stubEnv('AI_MOCK', '1');
  vi.stubEnv('SETTLEMENT_AUTHORITY_SECRET_KEY', JSON.stringify(Array.from(sa.secretKey)));
  ({ db, schema } = await import('@/db'));
  ({ book } = await import('@/server/credits/ledger'));
  w = createCreditWorld();
  vi.stubEnv('PLATFORM_WALLET_ADDRESS', w.feeWallet.publicKey.toBase58());
  vi.stubEnv('USDC_MINT', w.usdc.toBase58());
  const { createCreditService, setCreditService } = await import('@/server/credits/service');
  setCreditService(createCreditService({ db, chainFor: () => w.port, sa: w.sa, usdcMint: () => w.usdc.toBase58(), feeWallet: w.feeWallet.publicKey.toBase58(), cluster: 'devnet', packsPerDay: 3, sleep: async () => undefined, pollMs: 0, assertCluster: () => undefined }));
  R = {
    credits: (await import('../credits/route')).GET as Handler,
    quote: (await import('../credits/quote/route')).POST as Handler,
    pay: (await import('../credits/pay/route')).POST as Handler,
    purchase: (await import('../credits/purchases/[id]/route')).GET as Handler,
    listing: (await import('../listing/route')).POST as Handler,
    ask: (await import('../ask/route')).POST as Handler,
  };
}, 120_000);
afterAll(async () => {
  (await import('@/server/credits/service')).setCreditService(undefined);
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await t?.pool.end().catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
beforeEach(async () => {
  if (!t) return;
  const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
  clearFlagMemo();
  await db.delete(schema.aiUsage);
});
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

const { ok, fails } = responseChecks(() => [bs58.encode(sa.secretKey), JSON.stringify(Array.from(sa.secretKey)), 'fake-key']);
const fields = { name: 'Charizard', setName: 'Base Set', gradingCompany: 'PSA', grade: '9', locale: 'en' };
let n = 0;
const uuid = () => `bbbbbbbb-1111-4000-8000-${String(++n).padStart(12, '0')}`;
async function user(usdc = 0n) {
  const kp = Keypair.generate();
  w.watch(kp.publicKey);
  if (usdc) w.fund(kp.publicKey, usdc);
  return { kp, ...(await signIn(kp)) };
}

describe('the switch: FEATURE_AI off answers as if the routes did not exist', () => {
  it_('every route is 404 feature_off, with or without a session', async () => {
    vi.stubEnv('FEATURE_AI', 'false');
    try {
      const u = await user();
      await fails(await R.credits(request('GET', '/api/ai/credits', { cookie: u.cookie })), 'feature_off');
      await fails(await R.quote(request('POST', '/api/ai/credits/quote', { cookie: u.cookie })), 'feature_off');
      await fails(await R.pay(request('POST', '/api/ai/credits/pay', { cookie: u.cookie, body: { purchaseId: uuid(), signedTxBase64: 'AAAA' } })), 'feature_off');
      await fails(await R.purchase(request('GET', `/api/ai/credits/purchases/${uuid()}`, { cookie: u.cookie }), ctx({ id: uuid() })), 'feature_off');
      await fails(await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } })), 'feature_off');
      await fails(await R.ask(request('POST', '/api/ai/ask', { body: { question: 'How do I bid?', locale: 'en' } })), 'feature_off');
    } finally { vi.stubEnv('FEATURE_AI', 'true'); }
  });
  it_('the ops kill switch (app_flags.ai = false) turns it off too, without a redeploy', async () => {
    await db.insert(schema.appFlags).values({ key: 'ai', value: false }).onConflictDoUpdate({ target: schema.appFlags.key, set: { value: false } });
    try {
      const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
      clearFlagMemo();
      await fails(await R.ask(request('POST', '/api/ai/ask', { body: { question: 'How do I bid?', locale: 'en' } })), 'feature_off');
    } finally {
      await db.delete(schema.appFlags).where((await import('drizzle-orm')).eq(schema.appFlags.key, 'ai'));
    }
  });
  it_('the routes are registered in the contract with the AI owner', () => {
    for (const k of ['aiCredits', 'aiCreditsQuote', 'aiCreditsPay', 'aiCreditsPurchase', 'aiListing', 'aiAsk'] as const) expect(ROUTES[k].agent).toBe('AI');
  });
});

describe('credits over the routes', () => {
  it_('needs a session; the balance, then quote, sign, pay, poll', async () => {
    await fails(await R.credits(request('GET', '/api/ai/credits')), 'unauthenticated');
    await fails(await R.quote(request('POST', '/api/ai/credits/quote')), 'unauthenticated');
    const u = await user(3_000_000n);
    const overview = await ok(await R.credits(request('GET', '/api/ai/credits', { cookie: u.cookie })), AiCreditsResponse);
    expect(overview).toMatchObject({ balance: 0, packsLeftToday: 3, cluster: 'devnet', configured: true });
    const q = await ok(await R.quote(request('POST', '/api/ai/credits/quote', { cookie: u.cookie, body: {} })), AiCreditsQuoteResponse);
    const signed = Buffer.from(walletSigns(new Uint8Array(Buffer.from(q.txBase64, 'base64')), u.kp)).toString('base64');
    const paid = await ok(await R.pay(request('POST', '/api/ai/credits/pay', { cookie: u.cookie, body: { purchaseId: q.purchaseId, signedTxBase64: signed } })), AiPurchaseView);
    expect(paid).toMatchObject({ status: 'settled', balance: 10 });
    const polled = await ok(await R.purchase(request('GET', `/api/ai/credits/purchases/${q.purchaseId}`, { cookie: u.cookie }), ctx({ id: q.purchaseId })), AiPurchaseView);
    expect(polled.status).toBe('settled');
    expect((await ok(await R.credits(request('GET', '/api/ai/credits', { cookie: u.cookie })), AiCreditsResponse)).balance).toBe(10);
  });
  it_('a tampered payment body is a 400/401, an unknown or foreign purchase is 404, a cross-origin write is 403', async () => {
    const u = await user(3_000_000n), v = await user(3_000_000n);
    const q = await ok(await R.quote(request('POST', '/api/ai/credits/quote', { cookie: u.cookie, body: {} })), AiCreditsQuoteResponse);
    await fails(await R.pay(request('POST', '/api/ai/credits/pay', { cookie: u.cookie, body: { purchaseId: q.purchaseId, signedTxBase64: 'not base64 !!' } })), 'validation');
    await fails(await R.pay(request('POST', '/api/ai/credits/pay', { cookie: v.cookie, body: { purchaseId: q.purchaseId, signedTxBase64: q.txBase64 } })), 'not_found');
    await fails(await R.purchase(request('GET', `/api/ai/credits/purchases/${q.purchaseId}`, { cookie: v.cookie }), ctx({ id: q.purchaseId })), 'not_found');
    await fails(await R.purchase(request('GET', '/api/ai/credits/purchases/nope', { cookie: u.cookie }), ctx({ id: 'nope' })), 'not_found');
    await fails(await R.pay(request('POST', '/api/ai/credits/pay', { cookie: u.cookie, body: { purchaseId: q.purchaseId, signedTxBase64: q.txBase64 }, headers: { origin: 'https://evil.example' } })), 'forbidden');
    await fails(await R.pay(request('POST', '/api/ai/credits/pay', { cookie: u.cookie, body: { purchaseId: q.purchaseId, signedTxBase64: q.txBase64 } })), 'bad_signature'); // unsigned
  });
  it_('quotes are limited to 6 a minute per wallet', async () => {
    const u = await user(0n); // no USDC: every quote fails the same way, but each one counts
    for (let i = 0; i < 6; i++) await fails(await R.quote(request('POST', '/api/ai/credits/quote', { cookie: u.cookie, body: {} })), 'insufficient_usdc');
    await fails(await R.quote(request('POST', '/api/ai/credits/quote', { cookie: u.cookie, body: {} })), 'rate_limited');
  });
});

describe('the listing route', () => {
  it_('without credit: 402 with the pack terms (scheme, network, amount, asset, payTo, fee payer, quote url)', async () => {
    const u = await user();
    const res = await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } }));
    expect(res.status).toBe(402);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = PaymentRequiredBody.parse(await res.json());
    expect(body).toMatchObject({ code: 'payment_required', scheme: 'exact', network: 'devnet', amount: '1000000', asset: w.usdc.toBase58(), payTo: w.feeWallet.publicKey.toBase58(), quoteUrl: '/api/ai/credits/quote', extra: { feePayer: sa.publicKey.toBase58() } });
    expect(JSON.stringify(body)).not.toMatch(/[\u2014–]/);
  });
  it_('the 402 on mainnet names the REAL mainnet USDC mint and the network of the cluster, and never a devnet value', async () => {
    vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta'); vi.stubEnv('USDC_MINT', '');
    try {
      const u = await user();
      const res = await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } }));
      expect(res.status).toBe(402);
      const body = PaymentRequiredBody.parse(await res.json());
      expect(body.network).toBe('mainnet-beta');
      expect(body.asset).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    } finally { vi.stubEnv('SOLANA_CLUSTER', 'devnet'); vi.stubEnv('USDC_MINT', w.usdc.toBase58()); }
  });
  it_('with credit: 200, the draft is labelled, one credit is taken, the response carries no key and no em dash', async () => {
    const u = await user();
    await book(db, u.profileId, 2, 'grant', uuid());
    const r = await ok(await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } })), AiListingResponse);
    expect(r).toMatchObject({ source: 'model', creditsLeft: 1, label: 'ai_draft' });
    expect(r.draft.descriptionEn).toMatch(/must be reviewed by the seller/);
  });
  it_('validation: unknown fields, a bad request id, too many or bad images, a body over 1.5 MB, wrong content type', async () => {
    const post = async (body: unknown, headers: Record<string, string> = {}) => R.listing(request('POST', '/api/ai/listing', { cookie: (await user()).cookie, body, ip: freshIp(), headers })); // a fresh wallet each time: the limit counts before the body is read
    await fails(await post({ requestId: 'x', fields }), 'validation');
    await fails(await post({ requestId: uuid(), fields: { ...fields, role: 'admin' } }), 'validation');
    await fails(await post({ requestId: uuid(), fields: { ...fields, name: '' } }), 'validation');
    const img = { mediaType: 'image/jpeg', dataBase64: Buffer.from([0xff, 0xd8, 0xff, 1, 2]).toString('base64') };
    await fails(await post({ requestId: uuid(), fields, images: [img, img, img, img] }), 'validation');
    await fails(await post({ requestId: uuid(), fields, images: [{ mediaType: 'image/jpeg', dataBase64: Buffer.from('GIF89a').toString('base64') }] }), 'validation');
    await fails(await post({ requestId: uuid(), fields: { ...fields, notes: 'x'.repeat(2_000_000) } }), 'validation');
    await fails(await post('{"requestId":', {}), 'validation');
    await fails(await post({ requestId: uuid(), fields }, { 'content-type': 'text/plain' }), 'validation');
  });
  it_('limits: 3 drafts a minute per wallet (the fourth is 429 with Retry-After), and a draft needs a session', async () => {
    await fails(await R.listing(request('POST', '/api/ai/listing', { body: { requestId: uuid(), fields } })), 'unauthenticated');
    const u = await user();
    await book(db, u.profileId, 9, 'grant', uuid());
    for (let i = 0; i < 3; i++) await ok(await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } })), AiListingResponse);
    const res = await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } }));
    await fails(res, 'rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
  it_('a banned wallet gets nothing', async () => {
    const u = await user();
    await db.update(schema.profiles).set({ isBanned: true }).where((await import('drizzle-orm')).eq(schema.profiles.id, u.profileId));
    await fails(await R.listing(request('POST', '/api/ai/listing', { cookie: u.cookie, body: { requestId: uuid(), fields } })), 'banned');
  });
});

describe('the assistant route (a signed-in wallet only)', () => {
  const askReq = (question: string, o: { cookie?: string; ip?: string; locale?: 'de' | 'en' } = {}) => R.ask(request('POST', '/api/ai/ask', { cookie: o.cookie, ip: o.ip, body: { question, locale: o.locale ?? 'en' } }));
  it_('a visitor without a wallet gets 401 unauthenticated, and no model call or usage row happens', async () => {
    await fails(await askReq('How do I bid?'), 'unauthenticated');
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });
  it_('a signed-in wallet asks: the answer is the fixed FAQ text, labelled AI, never cached', async () => {
    const u = await user();
    const r = await ok(await askReq('How do I bid?', { cookie: u.cookie }), AiAskResponse);
    expect(r).toMatchObject({ faqKey: 'bid.0', source: 'ai', label: 'ai' });
    expect(r.answer).toContain('connect your wallet');
    expect((await db.select().from(schema.aiUsage))[0]).toMatchObject({ kind: 'ask', profileId: u.profileId });
  });
  it_('German in, German out; advice in, the fixed no-advice text; nonsense in, the "cannot" text', async () => {
    const u = await user();
    const de = await ok(await askReq('Wie biete ich?', { cookie: u.cookie, locale: 'de' }), AiAskResponse);
    expect(de.answer).toMatch(/Wallet/);
    expect((await ok(await askReq('Soll ich 500 bieten?', { cookie: u.cookie, locale: 'de' }), AiAskResponse)).faqKey).toBe('no_advice');
    expect((await ok(await askReq('qwertz asdf', { cookie: u.cookie }), AiAskResponse)).faqKey).toBeNull();
  });
  it_('a signed-in asker is recorded by profile id only (no question text anywhere)', async () => {
    const u = await user();
    await ok(await askReq('How do I bid?', { cookie: u.cookie }), AiAskResponse);
    const rows = await db.select().from(schema.aiUsage);
    expect(rows[0]!.profileId).toBe(u.profileId);
    expect(JSON.stringify(rows)).not.toContain('How do I bid');
  });
  it_('validation: empty, over 300 characters, unknown locale, extra fields', async () => {
    const u = await user();
    for (const body of [{ question: '', locale: 'en' }, { question: 'x'.repeat(301), locale: 'en' }, { question: 'hi', locale: 'fr' }, { question: 'hi', locale: 'en', showId: uuid() }])
      await fails(await R.ask(request('POST', '/api/ai/ask', { cookie: u.cookie, body })), 'validation');
  });
  it_('limits: 6 questions a minute per wallet (the seventh is 429), and 40 a day per address', async () => {
    const u = await user();
    for (let i = 0; i < 6; i++) await ok(await askReq('How do I bid?', { cookie: u.cookie }), AiAskResponse);
    await fails(await askReq('How do I bid?', { cookie: u.cookie }), 'rate_limited');
    const ip2 = freshIp(), u2 = await user();
    const { rateLimit } = await import('@/lib/http/ratelimit');
    for (let i = 0; i < 40; i++) await rateLimit(`ip:ai-ask-d:${ip2}`, 40, 86_400); // 40 asked today already
    await fails(await askReq('How do I bid?', { cookie: u2.cookie, ip: ip2 }), 'rate_limited');
  });
});
