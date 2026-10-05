/**
 * Everything that costs us something or writes something needs a signed-in wallet: the AI agent (a search included), the assistant, the listing
 * draft, the credits, a chat post and a bid. Called as route functions over a real Postgres with the built-in mock model (AI_MOCK=1): if a guard
 * were missing, the AI routes would answer 200 here, so a 401 is proof. An anonymous call also leaves no ai_usage row (no model call, no cost).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { ctx, freshIp, request, responseChecks, signIn } from '@/server/settlement/__tests__/routekit';
import { AiAgentResponse } from '@/contracts';

let t: TestPg | undefined, skipReason: string | undefined;
let db: typeof import('@/db').db, schema: typeof import('@/db').schema;
type Handler = (req: Request, c?: { params: Promise<Record<string, string>> }) => Promise<Response>;
let R: Record<'agent' | 'ask' | 'listing' | 'credits' | 'quote' | 'pay' | 'chatPost' | 'bid', Handler>;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('FEATURE_AI', 'true');
  vi.stubEnv('FEATURE_CHAT', 'true');
  vi.stubEnv('AI_MOCK', '1');
  ({ db, schema } = await import('@/db'));
  R = {
    agent: (await import('../agent/route')).POST as Handler,
    ask: (await import('../ask/route')).POST as Handler,
    listing: (await import('../listing/route')).POST as Handler,
    credits: (await import('../credits/route')).GET as Handler,
    quote: (await import('../credits/quote/route')).POST as Handler,
    pay: (await import('../credits/pay/route')).POST as Handler,
    chatPost: (await import('../../shows/[id]/chat/route')).POST as Handler,
    bid: (await import('../../bids/route')).POST as Handler,
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
const uuid = '99999999-1111-4000-8000-000000000001';
const agentBody = (message: string, locale: 'de' | 'en' = 'en') => ({ message, locale });

describe('without a wallet session: 401 unauthenticated, nothing runs, nothing is recorded', () => {
  it_('the AI agent (a search included), the assistant, the draft and the credits', async () => {
    const calls: [string, Handler, Request][] = [
      ['agent search', R.agent, request('POST', '/api/ai/agent', { body: agentBody('search charizard') })],
      ['agent search (German)', R.agent, request('POST', '/api/ai/agent', { body: agentBody('suche Glurak', 'de') })],
      ['agent bid', R.agent, request('POST', '/api/ai/agent', { body: agentBody('bid 50 USDC on lot 3') })],
      ['agent draft', R.agent, request('POST', '/api/ai/agent', { body: agentBody('draft a listing for my PSA 10 card') })],
      ['assistant', R.ask, request('POST', '/api/ai/ask', { body: { question: 'How do I bid?', locale: 'en' } })],
      ['listing draft', R.listing, request('POST', '/api/ai/listing', { body: { requestId: uuid, fields: { name: 'Charizard', locale: 'en' } } })],
      ['credits', R.credits, request('GET', '/api/ai/credits')],
      ['credit quote', R.quote, request('POST', '/api/ai/credits/quote', { body: {} })],
      ['credit pay', R.pay, request('POST', '/api/ai/credits/pay', { body: { purchaseId: uuid, signedTxBase64: 'AAAA' } })],
    ];
    for (const [name, handler, req] of calls) {
      const res = await handler(req);
      expect(res.status, name).toBe(401);
      await fails(res, 'unauthenticated');
    }
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });
  it_('a forged cookie is no wallet either', async () => {
    for (const cookie of ['hp_session=not-a-token', 'hp_session=eyJ3YWxsZXQiOiJ4In0.AAAA']) {
      await fails(await R.agent(request('POST', '/api/ai/agent', { cookie, body: agentBody('search charizard') })), 'unauthenticated');
      await fails(await R.ask(request('POST', '/api/ai/ask', { cookie, body: { question: 'How do I bid?', locale: 'en' } })), 'unauthenticated');
    }
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });
  it_('a chat post', async () => {
    const res = await R.chatPost(request('POST', `/api/shows/${uuid}/chat`, { body: { body: 'hello', clientNonce: uuid } }), ctx({ id: uuid }));
    expect(res.status).toBe(401);
    await fails(res, 'unauthenticated');
  });
  it_('a bid (the signed text is the proof of the wallet: an unsigned or invented one is refused)', async () => {
    const intent = { message: 'please let me bid', signature: 'A'.repeat(86), signer: 'wallet' };
    const res = await R.bid(request('POST', '/api/bids', { body: { lotId: uuid, amount: '50000000', intent } }));
    expect(res.status).toBe(401);
    await fails(res, 'bad_signature');
    expect(await db.select().from(schema.bids)).toHaveLength(0);
  });
});

describe('with a wallet session', () => {
  it_('the agent answers and records one agent usage row for that profile', async () => {
    const { cookie, profileId } = await signIn(Keypair.generate());
    const r = await ok(await R.agent(request('POST', '/api/ai/agent', { cookie, body: agentBody('search charizard') })), AiAgentResponse);
    expect(r.text.length).toBeGreaterThan(0);
    expect(await db.select().from(schema.aiUsage)).toMatchObject([{ kind: 'agent', profileId }]);
  });
  it_('a banned wallet gets nothing from the agent or the assistant', async () => {
    const { cookie, profileId } = await signIn(Keypair.generate());
    await db.update(schema.profiles).set({ isBanned: true }).where((await import('drizzle-orm')).eq(schema.profiles.id, profileId));
    await fails(await R.agent(request('POST', '/api/ai/agent', { cookie, body: agentBody('search charizard') })), 'banned');
    await fails(await R.ask(request('POST', '/api/ai/ask', { cookie, body: { question: 'How do I bid?', locale: 'en' } })), 'banned');
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });
  it_('the per-wallet limit stays: 6 agent messages a minute, the seventh is 429, another wallet is not affected', async () => {
    const a = await signIn(Keypair.generate()), b = await signIn(Keypair.generate());
    const send = (cookie: string) => R.agent(request('POST', '/api/ai/agent', { cookie, ip: freshIp(), body: agentBody('search charizard') }));
    for (let i = 0; i < 6; i++) await ok(await send(a.cookie), AiAgentResponse);
    await fails(await send(a.cookie), 'rate_limited');
    await ok(await send(b.cookie), AiAgentResponse);
  });
  it_('the daily address limit stays: 40 a day per address', async () => {
    const { cookie } = await signIn(Keypair.generate());
    const ip = freshIp();
    const { rateLimit } = await import('@/lib/http/ratelimit');
    for (let i = 0; i < 40; i++) await rateLimit(`ip:ai-agent-d:${ip}`, 40, 86_400);
    await fails(await R.agent(request('POST', '/api/ai/agent', { cookie, ip, body: agentBody('search charizard') })), 'rate_limited');
  });
});
