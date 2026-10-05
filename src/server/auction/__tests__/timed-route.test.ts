/**
 * POST /api/shows for a timed show, through the real handler (embedded Postgres, real sessions, fake chain): who may create one, the
 * one-lot rule, and its own daily allowance (10, where a live show has 3).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ErrorResponseSchema, ShowDetail } from '@/contracts';
import { clearFlagMemo } from '@/app/api/auctions/_shared/flags';
import { actor, req, resetLimits, signIn, startKit, type Kit } from '@/app/api/auctions/_shared/__tests__/kit';

let kit: Kit | undefined; let skipReason: string | undefined;
let post: (r: Request) => Promise<Response>;
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  post = (await import('@/app/api/shows/route')).POST as typeof post;
}, 180_000);
afterAll(async () => { await kit?.stop(); });
afterEach(() => { vi.unstubAllEnvs(); vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01'); vi.stubEnv('SOLANA_CLUSTER', 'devnet'); vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet'); clearFlagMemo(); });
const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);

const mint = () => actor().wallet;
const body = (kind: 'timed' | 'live', lots = 1, over: Record<string, unknown> = {}) => ({ title: 'One card, one day', kind, lots: Array.from({ length: lots }, () => ({ mint: mint() })), ...over });
const code = async (res: Response) => ErrorResponseSchema.parse(await res.json()).code;

async function operator(k: Kit) {
  const a = actor();
  vi.stubEnv('FEATURE_TIMED', 'true'); clearFlagMemo();
  vi.stubEnv('OPERATOR_WALLETS', a.wallet);
  await resetLimits(k.env);
  return { a, cookie: await signIn(a) };
}

describe('POST /api/shows with kind timed', () => {
  t('an operator creates one: 201, kind timed, one lot, the show-level timed defaults apply', async (k) => {
    const o = await operator(k);
    const res = await post(req('/api/shows', { body: body('timed'), cookie: o.cookie }));
    expect(res.status).toBe(201);
    const d = ShowDetail.parse(await res.json());
    expect(d.show.kind).toBe('timed');
    expect(d.lots).toHaveLength(1);
  });

  t('a stranger is refused with feature_off and a plain sentence; a live show from the same stranger is fine', async (k) => {
    vi.stubEnv('FEATURE_TIMED', 'true'); clearFlagMemo();
    await resetLimits(k.env);
    const a = actor();
    const cookie = await signIn(a);
    const res = await post(req('/api/shows', { body: body('timed'), cookie }));
    expect(res.status).toBe(404);
    const err = ErrorResponseSchema.parse(await res.json());
    expect(err.code).toBe('feature_off');
    expect(JSON.stringify(err)).toMatch(/Hammerprice room/);
    expect((await post(req('/api/shows', { body: body('live', 2), cookie }))).status).toBe(201);
  });

  t('two cards are refused: a timed auction is one lot', async (k) => {
    const o = await operator(k);
    const res = await post(req('/api/shows', { body: body('timed', 2), cookie: o.cookie }));
    expect(res.status).toBe(400);
    expect(await code(res)).toBe('validation');
  });

  t('the allowance is 10 timed shows a day (a live show gets 3), counted separately', async (k) => {
    const o = await operator(k);
    for (let n = 0; n < 10; n++) expect((await post(req('/api/shows', { body: body('timed'), cookie: o.cookie }))).status, `timed #${n + 1}`).toBe(201);
    const eleventh = await post(req('/api/shows', { body: body('timed'), cookie: o.cookie }));
    expect(eleventh.status).toBe(429);
    expect(await code(eleventh)).toBe('rate_limited');
    // the live allowance is untouched
    for (let n = 0; n < 3; n++) expect((await post(req('/api/shows', { body: body('live'), cookie: o.cookie }))).status, `live #${n + 1}`).toBe(201);
    expect((await post(req('/api/shows', { body: body('live'), cookie: o.cookie }))).status).toBe(429);
  });
});
