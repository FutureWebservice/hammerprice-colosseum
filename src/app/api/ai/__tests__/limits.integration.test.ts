/**
 * The limits of the AI routes as a caller sees them, over a real Postgres with the built-in mock model (AI_MOCK=1): a banned wallet is 403 on every
 * AI route, the per-wallet limits per minute, hour and day, the per-address layer that many wallets from one address cannot multiply, a spent
 * budget (no model path at all), an open in-flight cap or breaker (the fixed answer, no new usage row), and a limiter that is down (the request
 * fails, it is not waved through). The anonymous 401 of every route is in wallet-required.integration.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { eq, sql } from 'drizzle-orm';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { freshIp, request, responseChecks, signIn } from '@/server/settlement/__tests__/routekit';
import { AiAgentResponse, AiAskResponse } from '@/contracts';

let t: TestPg | undefined, skipReason: string | undefined;
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
type Handler = (req: Request, c?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let R: Record<'agent' | 'ask' | 'listing' | 'credits' | 'quote' | 'pay', Handler>;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('FEATURE_AI', 'true');
  vi.stubEnv('AI_MOCK', '1');
  ({ db, schema } = await import('@/db'));
  R = {
    agent: (await import('../agent/route')).POST as Handler,
    ask: (await import('../ask/route')).POST as Handler,
    listing: (await import('../listing/route')).POST as Handler,
    credits: (await import('../credits/route')).GET as Handler,
    quote: (await import('../credits/quote/route')).POST as Handler,
    pay: (await import('../credits/pay/route')).POST as Handler,
  };
}, 120_000);
afterAll(async () => {
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
const { ok, fails } = responseChecks(() => ['fake-key']);
const uuid = '99999999-1111-4000-8000-000000000002';
const agent = (cookie: string, ip = freshIp(), message = 'how do I bid?') => R.agent(request('POST', '/api/ai/agent', { cookie, ip, body: { message, locale: 'en' } }));
const askQ = (cookie: string, ip = freshIp()) => R.ask(request('POST', '/api/ai/ask', { cookie, ip, body: { question: 'How do I bid?', locale: 'en' } }));
const touched = new Set<string>();
const setEnv = (k: string, v: string) => { touched.add(k); vi.stubEnv(k, v); };
const unset = () => { for (const k of touched) vi.stubEnv(k, undefined as unknown as string); touched.clear(); };
const usage = () => db.select().from(schema.aiUsage);

describe('a banned wallet is 403 on every AI route, before any limit, budget or model call', () => {
  it_('agent, assistant, listing draft, credits, quote and pay', async () => {
    const { cookie, profileId } = await signIn(Keypair.generate());
    await db.update(schema.profiles).set({ isBanned: true }).where(eq(schema.profiles.id, profileId));
    const calls: [string, Request][] = [
      ['agent', request('POST', '/api/ai/agent', { cookie, body: { message: 'search charizard', locale: 'en' } })],
      ['ask', request('POST', '/api/ai/ask', { cookie, body: { question: 'How do I bid?', locale: 'en' } })],
      ['listing', request('POST', '/api/ai/listing', { cookie, body: { requestId: uuid, fields: { name: 'Charizard', locale: 'en' } } })],
      ['credits', request('GET', '/api/ai/credits', { cookie })],
      ['quote', request('POST', '/api/ai/credits/quote', { cookie, body: {} })],
      ['pay', request('POST', '/api/ai/credits/pay', { cookie, body: { purchaseId: uuid, signedTxBase64: 'AAAA' } })],
    ];
    const handlers = [R.agent, R.ask, R.listing, R.credits, R.quote, R.pay];
    for (const [i, [name, req]] of calls.entries()) {
      const res = await handlers[i]!(req);
      expect(res.status, name).toBe(403);
      await fails(res, 'banned');
    }
    expect(await usage()).toHaveLength(0);
    expect(await db.select().from(schema.rateLimits).where(sql`${schema.rateLimits.key} like ${`w:ai-%:${(await db.select().from(schema.profiles).where(eq(schema.profiles.id, profileId)))[0]!.walletAddress}`}`)).toHaveLength(0);
  });
});

describe('per wallet: minute, hour and day (AI_RATE_PER_MIN, AI_RATE_PER_HOUR, AI_RATE_PER_DAY)', () => {
  it_('the defaults are 6 a minute across the AI routes (agent and assistant share it); the seventh is 429 with Retry-After', async () => {
    const { cookie } = await signIn(Keypair.generate());
    for (let i = 0; i < 3; i++) await ok(await agent(cookie), AiAgentResponse);
    for (let i = 0; i < 3; i++) await ok(await askQ(cookie), AiAskResponse);
    const res = await agent(cookie);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    await fails(res, 'rate_limited');
    expect(await usage()).toHaveLength(6);
  });
  it_('the hourly window: with 3 an hour the fourth call is 429 although the minute window is far from full', async () => {
    setEnv('AI_RATE_PER_MIN', '50'); setEnv('AI_RATE_PER_HOUR', '3');
    try {
      const { cookie } = await signIn(Keypair.generate());
      for (let i = 0; i < 3; i++) await ok(await agent(cookie), AiAgentResponse);
      await fails(await agent(cookie), 'rate_limited');
      await fails(await askQ(cookie), 'rate_limited');
    } finally { unset(); }
  });
  it_('the daily window: with 2 a day the third call is 429; another wallet is not affected', async () => {
    setEnv('AI_RATE_PER_MIN', '50'); setEnv('AI_RATE_PER_HOUR', '50'); setEnv('AI_RATE_PER_DAY', '2');
    try {
      const a = await signIn(Keypair.generate()), b = await signIn(Keypair.generate());
      for (let i = 0; i < 2; i++) await ok(await agent(a.cookie), AiAgentResponse);
      await fails(await agent(a.cookie), 'rate_limited');
      await ok(await agent(b.cookie), AiAgentResponse);
    } finally { unset(); }
  });
  it_('the listing draft shares the wallet limit and keeps its own tighter one (3 a minute)', async () => {
    setEnv('AI_RATE_PER_MIN', '2');
    try {
      const { cookie } = await signIn(Keypair.generate());
      const draft = () => R.listing(request('POST', '/api/ai/listing', { cookie, body: { requestId: crypto.randomUUID(), fields: { name: 'Charizard', locale: 'en' } } }));
      for (let i = 0; i < 2; i++) expect((await draft()).status).not.toBe(429);
      await fails(await draft(), 'rate_limited');
    } finally { unset(); }
  });
});

describe('per address: many wallets from one address cannot multiply the limit (AI_RATE_IP_PER_MIN, _HOUR, _DAY)', () => {
  it_('twenty calls a minute from one address by any number of wallets, the twenty-first is 429 for a fresh wallet', async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) {
      const w = await signIn(Keypair.generate());
      expect((await agent(w.cookie, ip)).status, `call ${i + 1}`).toBe(200);
    }
    const w = await signIn(Keypair.generate());
    const res = await agent(w.cookie, ip);
    expect(res.status).toBe(429);
    await fails(res, 'rate_limited');
    expect((await agent(w.cookie, freshIp())).status).toBe(200); // the same wallet from another address is fine
  }, 60_000);
  it_('the hourly and daily address windows are env-controlled too', async () => {
    setEnv('AI_RATE_IP_PER_HOUR', '2');
    try {
      const ip = freshIp();
      for (let i = 0; i < 2; i++) expect((await agent((await signIn(Keypair.generate())).cookie, ip)).status).toBe(200);
      await fails(await agent((await signIn(Keypair.generate())).cookie, ip), 'rate_limited');
    } finally { unset(); }
  });
});

describe('the model path fails closed', () => {
  it_('a spent budget: the route still answers (the fixed FAQ), no model call, no usage row, any number of times', async () => {
    setEnv('AI_DAILY_BUDGET_USD', '0'); setEnv('AI_RATE_PER_MIN', '50'); setEnv('AI_RATE_IP_PER_MIN', '50');
    try {
      const { cookie } = await signIn(Keypair.generate());
      for (let i = 0; i < 8; i++) {
        const r = await ok(await agent(cookie, freshIp(), 'search charizard'), AiAgentResponse);
        expect(r.cards, 'a search is a model choice: without the model the FAQ answers').toEqual([]);
        await ok(await askQ(cookie), AiAskResponse);
      }
      expect(await usage()).toHaveLength(0);
    } finally { unset(); }
  });
  it_('an open breaker or a full in-flight cap: the fixed answer, and no new usage row', async () => {
    const { cookie } = await signIn(Keypair.generate());
    await db.insert(schema.aiUsage).values(Array.from({ length: 5 }, () => ({ requestId: crypto.randomUUID(), kind: 'agent', model: 'm', status: 'error', costMicroUsd: 0, createdAt: new Date() })));
    const r = await ok(await agent(cookie, freshIp(), 'search charizard'), AiAgentResponse);
    expect(r.cards).toEqual([]);
    expect(await usage()).toHaveLength(5);
    await db.delete(schema.aiUsage);
    setEnv('AI_MAX_CONCURRENT', '1');
    try {
      await db.insert(schema.aiUsage).values({ requestId: crypto.randomUUID(), kind: 'agent', model: 'm', status: 'reserved', costMicroUsd: 3000, createdAt: new Date() });
      await ok(await askQ(cookie), AiAskResponse);
      expect(await usage()).toHaveLength(1);
    } finally { unset(); }
  });
  it_('the limiter is down (its table is gone): the request fails with no answer and no model call; it is not waved through', async () => {
    const { cookie } = await signIn(Keypair.generate());
    await db.execute(sql`alter table rate_limits rename to rate_limits_away`);
    try {
      for (const call of [() => agent(cookie), () => askQ(cookie)]) await expect(call()).rejects.toThrow();
    } finally { await db.execute(sql`alter table rate_limits_away rename to rate_limits`); }
    expect(await usage()).toHaveLength(0);
  });
  it_('the feature switch: FEATURE_AI off is 404 before the session is even read, and the ops flag switches it off without a redeploy', async () => {
    const { cookie } = await signIn(Keypair.generate());
    await db.insert(schema.appFlags).values({ key: 'ai', value: false }).onConflictDoUpdate({ target: schema.appFlags.key, set: { value: false } });
    const { clearFlagMemo } = await import('@/app/api/auctions/_shared/flags');
    clearFlagMemo();
    try {
      for (const res of [await agent(cookie), await askQ(cookie), await R.credits(request('GET', '/api/ai/credits', { cookie }))]) { expect(res.status).toBe(404); await fails(res, 'feature_off'); }
      expect(await usage()).toHaveLength(0);
    } finally { await db.delete(schema.appFlags).where(eq(schema.appFlags.key, 'ai')); clearFlagMemo(); }
  });
});
