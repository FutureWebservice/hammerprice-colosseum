/**
 * How long a paddle session key may live, by show kind: 6 hours in a live show, up to 7 days in a timed show, and a maximum bid amount for
 * anything past 6 hours. The pure rule, then the route (real handler, real engine, fake balance).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorResponseSchema, PaddleResponse } from '@/contracts';
import { PADDLE_MAX_VALIDITY_MS, PADDLE_MAX_VALIDITY_TIMED_MS, buildPaddleAuth, paddleMaxValidityMs, paddleValidityIssue, verifyPaddleAuth } from '@/lib/auth/intent';
import { SHOW, actor } from '@/lib/auth/__tests__/testkit';
import { req, resetLimits, signIn, startKit, USDC, type Kit } from '@/app/api/auctions/_shared/__tests__/kit';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const H = 3_600_000;
const D = 24 * H;

describe('the rule', () => {
  it('maxima: 6 hours live (and when the kind is unknown), 7 days timed', () => {
    expect(paddleMaxValidityMs(undefined)).toBe(6 * H);
    expect(paddleMaxValidityMs('live')).toBe(PADDLE_MAX_VALIDITY_MS);
    expect(paddleMaxValidityMs('timed')).toBe(7 * D);
    expect(PADDLE_MAX_VALIDITY_TIMED_MS).toBe(7 * D);
  });

  it('paddleValidityIssue: too long past the kind maximum; past 6 hours a key without a maximum bid is refused', () => {
    const f = (valid: number, max: bigint | null) => ({ valid: NOW + valid, max });
    expect(paddleValidityIssue('live', f(6 * H, null), NOW)).toBeNull();
    expect(paddleValidityIssue('live', f(6 * H + 1, 5n), NOW)).toBe('too_long');
    expect(paddleValidityIssue(undefined, f(7 * H, 5n), NOW)).toBe('too_long');
    expect(paddleValidityIssue('timed', f(6 * H, null), NOW)).toBeNull();
    expect(paddleValidityIssue('timed', f(6 * H + 1, null), NOW)).toBe('max_required');
    expect(paddleValidityIssue('timed', f(6 * H + 1, 100n * 1_000_000n), NOW)).toBeNull();
    expect(paddleValidityIssue('timed', f(7 * D, 5n), NOW)).toBeNull();
    expect(paddleValidityIssue('timed', f(7 * D + 1, 5n), NOW)).toBe('too_long');
    expect(paddleValidityIssue('timed', f(7 * D, null), NOW)).toBe('max_required');
  });

  it('verifyPaddleAuth follows the kind: the live default is unchanged, a timed key may be authorised for days with a maximum', () => {
    const w = actor(); const k = actor();
    const sign = (valid: number, max: bigint | null) => { const message = buildPaddleAuth({ cluster: 'devnet', show: SHOW, wallet: w.wallet, session: k.wallet, max, valid: NOW + valid }); return { message, signature: w.sign(message) }; };
    const ok = (valid: number, max: bigint | null, kind?: 'live' | 'timed') => verifyPaddleAuth({ ...sign(valid, max), wallet: w.wallet, showId: SHOW, nowMs: NOW, ...(kind ? { kind } : {}) });
    expect(ok(6 * H, 500n)).toBe(true);
    expect(ok(6 * H + 1, 500n)).toBe(false);
    expect(ok(2 * D, 500n, 'live')).toBe(false);
    expect(ok(2 * D, 500n, 'timed')).toBe(true);
    expect(ok(2 * D, null, 'timed')).toBe(false); // a long key needs a ceiling
    expect(ok(5 * H, null, 'timed')).toBe(true);
    expect(ok(7 * D + 1, 500n, 'timed')).toBe(false);
    expect(ok(-1, 500n, 'timed')).toBe(false);
  });
});

let kit: Kit | undefined; let skipReason: string | undefined;
let paddle: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>;
beforeAll(async () => {
  const r = await startKit();
  if ('skip' in r) { skipReason = r.skip; console.warn(r.skip); return; }
  kit = r.kit;
  paddle = (await import('@/app/api/shows/[id]/paddle/route')).POST;
  (await import('@/lib/auth/deps')).setServices({ chain: { getUsdcBalance: async () => 1000n * USDC } });
}, 180_000);
afterAll(async () => { await kit?.stop(); });
const t = (name: string, fn: (k: Kit) => Promise<void>, timeout = 60_000) => it(name, async (ctx) => { if (!kit) return ctx.skip(skipReason); await fn(kit); }, timeout);

async function show(k: Kit, kind: 'live' | 'timed', status: 'live' | 'ended' = 'live') {
  const seller = await k.env.profile();
  const s = await k.env.show({ sellerId: seller.id, status, lots: [{ state: 'open', openedAt: new Date(), closesAt: new Date(Date.now() + 3 * D) }] });
  await k.env.pool.query(`update shows set kind = $2 where id = $1`, [s.id, kind]);
  return s.id;
}
async function register(k: Kit, showId: string, validMs: number, max: bigint | null) {
  await resetLimits(k.env);
  const w = actor(); const session = actor();
  const cookie = await signIn(w);
  const message = buildPaddleAuth({ cluster: 'devnet', show: showId, wallet: w.wallet, session: session.wallet, max, valid: Date.now() + validMs });
  return paddle(req(`/api/shows/${showId}/paddle`, { body: { message, signature: w.sign(message), sessionPubkey: session.wallet, ...(max === null ? {} : { maxBid: max.toString() }) }, cookie }), { params: Promise.resolve({ id: showId }) });
}
const err = async (res: Response) => ErrorResponseSchema.parse(await res.json());

describe('POST /api/shows/:id/paddle', () => {
  t('a timed show takes a paddle for 3 days with a maximum', async (k) => {
    const id = await show(k, 'timed');
    const res = await register(k, id, 3 * D, 200n * USDC);
    expect(res.status).toBe(201);
    const p = PaddleResponse.parse(await res.json());
    expect(Date.parse(p.validUntil) - Date.now()).toBeGreaterThan(2.9 * D);
  });

  t('past 6 hours the maximum is required: a plain sentence, 400 validation', async (k) => {
    const id = await show(k, 'timed');
    const res = await register(k, id, 2 * D, null);
    expect(res.status).toBe(400);
    const e = await err(res);
    expect(e.code).toBe('validation');
    expect(JSON.stringify(e)).toMatch(/6 hours.*maximum bid/);
    expect((await register(k, id, 5 * H, null)).status).toBe(201); // a short key needs none
  });

  t('8 days is too long even for a timed show; a live show still takes 6 hours at most', async (k) => {
    const timed = await show(k, 'timed');
    expect((await err(await register(k, timed, 8 * D, 200n * USDC))).code).toBe('bad_signature');
    const live = await show(k, 'live');
    expect((await err(await register(k, live, 7 * H, 200n * USDC))).code).toBe('bad_signature');
    expect((await err(await register(k, live, 2 * D, 200n * USDC))).code).toBe('bad_signature');
    expect((await register(k, live, 5 * H, 200n * USDC)).status).toBe(201);
    expect((await register(k, live, 5 * H, null)).status).toBe(201); // live: no maximum needed, as before
  });

  t('an ended or unknown show is refused before anything is signed', async (k) => {
    const ended = await show(k, 'timed', 'ended');
    expect((await err(await register(k, ended, 3 * D, 1n * USDC))).code).toBe('show_ended');
    const unknown = '11111111-2222-4333-8444-555555555555';
    expect((await err(await register(k, unknown, 3 * D, 1n * USDC))).code).toBe('not_found');
  });
});

