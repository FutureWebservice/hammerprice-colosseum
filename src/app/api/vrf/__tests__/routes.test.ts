/**
 * The four VRF routes as route handlers over a real Postgres: the feature gate, shapes against the contract, cache modes, what never appears
 * (transaction bytes, the key), the advance route's body check and per-IP limit. The chain behind `advance` is the in-memory fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES, VrfKeyResponse, VrfRequestView, VrfShowResponse, type ErrorCode } from '@/contracts';
import { ERROR_STATUS } from '@/contracts';
import { startTestPg, type TestPg } from '@/db/__tests__/pg-harness';
import { generateVrfKey } from '@/lib/vrf/key';
import { clearFlagMemo } from '@/app/api/auctions/_shared/flags';
import { ctx, request } from '@/server/settlement/__tests__/routekit';
import { FakeChain } from '@/server/vrf/__tests__/fake-chain';
import { Keypair } from '@solana/web3.js';
import { clearVrfKeyMemo } from '@/server/vrf/key';

const hoisted = vi.hoisted(() => ({ deps: null as null | (() => unknown) }));
vi.mock('@/server/vrf/service', async (orig) => ({ ...(await orig<typeof import('@/server/vrf/service')>()), defaultDeps: () => hoisted.deps!() }));

let t: TestPg | undefined, skipReason: string | undefined;
type H = (req: Request, c?: never) => Promise<Response>;
let R: { key: H; request: H; showsDraws: H; advance: H };
let S: typeof import('@/server/vrf/service');
let pool: TestPg['pool'];
const g = generateVrfKey();
const sa = Keypair.generate();
let chain: FakeChain;

beforeAll(async () => {
  const r = await startTestPg({ poolMax: 10 });
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  t = r.pg; pool = t.pool;
  vi.stubEnv('DATABASE_URL', t.url);
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('TRUST_PROXY_HEADERS', 'true');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  S = await import('@/server/vrf/service');
  R = {
    key: (await import('../key/route')).GET as unknown as H,
    request: (await import('../requests/[id]/route')).GET as unknown as H,
    showsDraws: (await import('../shows/[id]/route')).GET as unknown as H,
    advance: (await import('../requests/[id]/advance/route')).POST as unknown as H,
  };
}, 120_000);
afterAll(async () => {
  await (globalThis as { __pool?: { end(): Promise<void> } }).__pool?.end().catch(() => {});
  vi.unstubAllEnvs();
  await new Promise((r) => setTimeout(r, 300));
  await t?.stop();
});
beforeEach(() => {
  if (!t) return;
  chain = new FakeChain();
  hoisted.deps = () => ({ chain, key: g.key, sa, cluster: 'devnet', now: () => new Date(), sleep: async () => {}, env: {}, budgetMs: 60_000 });
  vi.stubEnv('FEATURE_VRF', 'true');
  vi.stubEnv('VRF_SECRET_KEY', g.envValue);
  vi.stubEnv('VRF_REGISTRATION_TX', '5'.repeat(88));
  clearFlagMemo(); clearVrfKeyMemo();
});
const it_ = (name: string, fn: () => Promise<void> | void, timeout = 30_000) => it(name, async (c) => { if (!t) return c.skip(skipReason); await fn(); }, timeout);

async function seedShow(): Promise<{ showId: string; requestId: string }> {
  const { rows: [p] } = await pool.query(`insert into profiles (wallet_address) values ($1) returning id`, [Keypair.generate().publicKey.toBase58()]);
  const { rows: [s] } = await pool.query(`insert into shows (seller_id, title, status, scheduled_at, order_mode, cluster) values ($1,'t','scheduled', now() + interval '1 minute','vrf','devnet') returning id`, [p.id]);
  for (let n = 1; n <= 4; n++) await pool.query(`insert into lots (show_id, seller_id, lot_number, mint_address, nft_standard, name, increment, opening_price, consign_status) values ($1,$2,$3,$4,'core',$5,5,5,'ready')`, [s.id, p.id, n, `mint${n}${s.id}`.slice(0, 44), `Lot ${n}`]);
  const made = (await S.requestLotOrder(s.id, { key: g.key, now: () => new Date(), env: {} }))!;
  return { showId: s.id, requestId: made.id };
}
const fails = async (res: Response, code: ErrorCode) => {
  const text = await res.text();
  expect(res.status, text).toBe(ERROR_STATUS[code]);
  expect(JSON.parse(text).code).toBe(code);
  expect(res.headers.get('cache-control')).toBe('no-store');
};
const noSecret = (text: string) => { expect(text).not.toContain(g.envValue); expect(text).not.toMatch(/tx_?b64|TxB64|lease/i); expect(text).not.toMatch(/\u2014/); };

describe('FEATURE_VRF off', () => {
  it_('every route answers 404 feature_off as if it did not exist', async () => {
    vi.stubEnv('FEATURE_VRF', 'false'); clearFlagMemo();
    const id = '11111111-1111-4111-8111-111111111111';
    await fails(await R.key(request('GET', '/api/vrf/key')), 'feature_off');
    await fails(await R.request(request('GET', `/api/vrf/requests/${id}`), ctx({ id }) as never), 'feature_off');
    await fails(await R.showsDraws(request('GET', `/api/vrf/shows/${id}`), ctx({ id }) as never), 'feature_off');
    await fails(await R.advance(request('POST', `/api/vrf/requests/${id}/advance`), ctx({ id }) as never), 'feature_off');
  });
  it_('the ops kill switch (app_flags) turns it off again within the memo window', async () => {
    await pool.query(`insert into app_flags (key, value) values ('vrf', 'false'::jsonb) on conflict (key) do update set value = 'false'::jsonb`);
    clearFlagMemo();
    await fails(await R.key(request('GET', '/api/vrf/key')), 'feature_off');
    await pool.query(`delete from app_flags where key = 'vrf'`); clearFlagMemo();
    expect((await R.key(request('GET', '/api/vrf/key'))).status).toBe(200);
  });
  it_('no key configured: the key route answers feature_off too', async () => {
    vi.stubEnv('VRF_SECRET_KEY', ''); clearVrfKeyMemo();
    await fails(await R.key(request('GET', '/api/vrf/key')), 'feature_off');
  });
});

describe('GET /api/vrf/key', () => {
  it_('answers the contract shape, caches for 60 s on the CDN, never shows the secret', async () => {
    const res = await R.key(request('GET', '/api/vrf/key'));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('vercel-cdn-cache-control')).toBe(`max-age=${(ROUTES.vrfKey.cache as { cdnS: number }).cdnS}`);
    noSecret(text);
    const body = VrfKeyResponse.parse(JSON.parse(text));
    expect(body).toMatchObject({ publicKey: g.key.publicKey, suite: 'ECVRF-EDWARDS25519-SHA512-TAI', cluster: 'devnet', registrationTx: '5'.repeat(88) });
    expect(body.stats).toEqual({ commits: 0, reveals: 0, defaults: 0 });
  });
  it_('a registration value that is not a signature is not echoed', async () => {
    vi.stubEnv('VRF_REGISTRATION_TX', 'not a signature');
    expect(VrfKeyResponse.parse(await (await R.key(request('GET', '/api/vrf/key'))).json()).registrationTx).toBeNull();
  });
});

describe('GET /api/vrf/requests/:id and /api/vrf/shows/:id', () => {
  it_('a pending draw: contract shape, 5 s CDN cache, nothing internal', async () => {
    const { requestId, showId } = await seedShow();
    const res = await R.request(request('GET', `/api/vrf/requests/${requestId}`), ctx({ id: requestId }) as never);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('vercel-cdn-cache-control')).toBe('max-age=5');
    noSecret(text);
    expect(VrfRequestView.parse(JSON.parse(text))).toMatchObject({ status: 'pending', subject: { type: 'show', id: showId }, purpose: 'lot_order', beacon: null });
    const d = await R.showsDraws(request('GET', `/api/vrf/shows/${showId}`), ctx({ id: showId }) as never);
    expect(d.headers.get('vercel-cdn-cache-control')).toBe('max-age=3');
    expect(VrfShowResponse.parse(await d.json())).toEqual({ lotOrder: { requestId, status: 'pending' }, raffle: null });
  });
  it_('an unknown or malformed id is a plain 404', async () => {
    await fails(await R.request(request('GET', '/api/vrf/requests/nope'), ctx({ id: 'nope' }) as never), 'not_found');
    const id = '22222222-2222-4222-8222-222222222222';
    await fails(await R.request(request('GET', `/api/vrf/requests/${id}`), ctx({ id }) as never), 'not_found');
  });
});

describe('POST /api/vrf/requests/:id/advance', () => {
  it_('moves the draw to revealed, answers the view, and the lots are renumbered', async () => {
    const { requestId, showId } = await seedShow();
    const res = await R.advance(request('POST', `/api/vrf/requests/${requestId}/advance`), ctx({ id: requestId }) as never);
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    noSecret(text);
    const v = VrfRequestView.parse(JSON.parse(text));
    expect(v.status).toBe('revealed');
    const order = (v.result as { order: string[] }).order;
    const rows = (await pool.query(`select id from lots where show_id = $1 order by lot_number`, [showId])).rows.map((r) => r.id);
    expect(rows).toEqual(order);
    const again = await R.advance(request('POST', `/api/vrf/requests/${requestId}/advance`), ctx({ id: requestId }) as never);
    expect(VrfRequestView.parse(await again.json())).toEqual(v); // idempotent
  });
  it_('refuses a body with extra fields, a foreign origin and a non-JSON content type', async () => {
    const { requestId } = await seedShow();
    const path_ = `/api/vrf/requests/${requestId}/advance`;
    await fails(await R.advance(request('POST', path_, { body: { x: 1 } }), ctx({ id: requestId }) as never), 'validation');
    await fails(await R.advance(request('POST', path_, { headers: { origin: 'https://evil.example' } }), ctx({ id: requestId }) as never), 'forbidden');
    await fails(await R.advance(request('POST', path_, { headers: { 'content-type': 'text/plain' } }), ctx({ id: requestId }) as never), 'validation');
  });
  it_('limits a caller to 20 per minute (429 with Retry-After); another address is not affected', async () => {
    const { requestId } = await seedShow();
    const p = `/api/vrf/requests/${requestId}/advance`;
    for (let i = 0; i < 20; i++) expect((await R.advance(request('POST', p, { ip: '203.0.113.9' }), ctx({ id: requestId }) as never)).status).toBe(200);
    const res = await R.advance(request('POST', p, { ip: '203.0.113.9' }), ctx({ id: requestId }) as never);
    await fails(res, 'rate_limited');
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect((await R.advance(request('POST', p, { ip: '203.0.113.10' }), ctx({ id: requestId }) as never)).status).toBe(200);
  });
  it_('a mainnet deployment without its configuration answers 503 mainnet_config_incomplete before any chain call', async () => {
    const { requestId } = await seedShow();
    await pool.query(`update vrf_requests set cluster = 'mainnet-beta' where id = $1`, [requestId]);
    vi.stubEnv('SOLANA_CLUSTER', 'mainnet-beta'); vi.stubEnv('SOLANA_RPC_URL', ''); vi.stubEnv('PLATFORM_WALLET_ADDRESS', '');
    await fails(await R.advance(request('POST', `/api/vrf/requests/${requestId}/advance`), ctx({ id: requestId }) as never), 'mainnet_config_incomplete');
    expect(chain.sent).toHaveLength(0);
    vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  });
  it_('a draw of the other cluster is refused with cluster_config_conflict', async () => {
    const { requestId } = await seedShow();
    await pool.query(`update vrf_requests set cluster = 'mainnet-beta' where id = $1`, [requestId]);
    await fails(await R.advance(request('POST', `/api/vrf/requests/${requestId}/advance`), ctx({ id: requestId }) as never), 'cluster_config_conflict');
    expect(chain.sent).toHaveLength(0);
  });
});

describe('the route table', () => {
  const root = path.resolve(__dirname, '..', '..');
  const mine = Object.entries(ROUTES).filter(([, r]) => r.agent === 'VRF');
  it('the four VRF routes exist as files and export exactly their method; cache modes match the contract', () => {
    expect(mine).toHaveLength(4);
    for (const [name, r] of mine) {
      const f = path.join(root, ...r.path.replace(/^\/api\//, '').split('/').map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s)), 'route.ts');
      expect(fs.existsSync(f), `${name}: ${f}`).toBe(true);
      const src = fs.readFileSync(f, 'utf8');
      expect([...src.matchAll(/export const (GET|POST|PATCH|DELETE)\b/g)].map((m) => m[1]), name).toEqual([r.method]);
      if (r.cache !== 'none') expect(src, name).toContain(`ROUTES.${name}.cache`);
    }
  });
});
