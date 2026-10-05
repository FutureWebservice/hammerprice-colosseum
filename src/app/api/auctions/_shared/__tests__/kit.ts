/**
 * Test kit for the LIVE route tests: a real Postgres 18 (ENGINE's harness, real migrations, the REAL engine service), the real route
 * handlers called directly with Request objects (the way AUTH's tests do), real ed25519 signatures, and a fake chain port.
 * Only the chain is fake: balances, asset readiness and the settlement sweep are set per test through `fake`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { ApiError } from '@/contracts';
import { actor, type Actor } from '@/lib/auth/__tests__/testkit';
import { buildBidIntent, buildPaddleAuth } from '@/lib/auth/intent';
import { startEnv, USDC, type Env } from '@/server/auction/__tests__/harness';

export { actor, USDC };
export type { Actor, Env };

export const HOST = 'localhost:3000';
export const ORIGIN = `http://${HOST}`;

export interface Fake {
  /** wallet -> USDC base units; wallets not listed hold 1,000 USDC */
  balances: Map<string, bigint>;
  /** make every balance read fail like an RPC outage */
  chainDown: boolean;
  balanceCalls: number;
  /** mint -> readiness reasons; mints not listed are eligible */
  readiness: Map<string, string[]>;
  readinessDown: boolean;
  expired: number;
  finalized: number;
}

export interface Kit {
  env: Env;
  fake: Fake;
  stop: () => Promise<void>;
}

export async function startKit(): Promise<{ kit: Kit } | { skip: string }> {
  const r = await startEnv();
  if ('skip' in r) return r;
  vi.stubEnv('SESSION_SECRET', 'integration-secret-integration-secret-01');
  vi.stubEnv('SOLANA_CLUSTER', 'devnet');
  vi.stubEnv('NEXT_PUBLIC_SOLANA_NETWORK', 'devnet');
  const fake: Fake = { balances: new Map(), chainDown: false, balanceCalls: 0, readiness: new Map(), readinessDown: false, expired: 0, finalized: 0 };
  const { setLiveServices } = await import('../deps');
  setLiveServices({
    chain: {
      getUsdcBalance: async (wallet) => {
        fake.balanceCalls++;
        if (fake.chainDown) throw new ApiError('balance_unavailable', 'could not read the USDC balance, try again');
        return fake.balances.get(wallet) ?? 1000n * USDC;
      },
      readiness: async (mint) => {
        if (fake.readinessDown) throw new ApiError('rpc_unavailable', 'every RPC endpoint failed');
        const reasons = fake.readiness.get(mint) ?? [];
        return { eligible: reasons.length === 0, reasons: reasons as never };
      },
    },
    settlement: { sweep: async () => ({ expired: fake.expired, finalized: fake.finalized }) },
  });
  return { kit: { env: r.env, fake, stop: async () => { vi.unstubAllEnvs(); await r.env.stop(); } } };
}

let ipCounter = 0;
/** A fresh client address per call so the per-IP limits of one test never bleed into another. */
export const freshIp = () => `10.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}.9`;

export interface ReqInit { body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string>; method?: string }

export function req(path: string, init: ReqInit = {}): Request {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { 'x-forwarded-for': init.ip ?? freshIp() };
  if (method !== 'GET') { headers.origin = ORIGIN; headers['content-type'] = 'application/json'; }
  if (init.cookie) headers.cookie = init.cookie;
  Object.assign(headers, init.headers);
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  return new Request(`${ORIGIN}${path}`, { method, headers, body });
}

export const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
export const bodyOf = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Full sign-in through AUTH's two routes; returns the cookie header value. */
export async function signIn(a: Actor): Promise<string> {
  const challenge = (await import('@/app/api/auth/challenge/route')).POST;
  const verify = (await import('@/app/api/auth/verify/route')).POST;
  const c = await bodyOf(await challenge(req('/api/auth/challenge', { body: { wallet: a.wallet } })));
  const res = await verify(req('/api/auth/verify', { body: { wallet: a.wallet, message: c.message, signature: a.sign(c.message) } }));
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(await res.json())}`);
  return res.headers.get('set-cookie')!.split(';')[0];
}

/** A registered bidder: an actor with a profile, an optional separate paddle session key and a paddle in the show. */
export interface Bidder { actor: Actor; session: Actor; profileId: string; paddleId: string; number: number }

export async function bidder(env: Env, showId: string, o: { maxBid?: bigint | null; hours?: number; wallet?: Actor } = {}): Promise<Bidder> {
  const a = o.wallet ?? actor();
  const session = actor();
  const existing = (await env.pool.query(`select id from profiles where wallet_address = $1`, [a.wallet])).rows[0];
  const p = existing ? { id: existing.id as string } : await env.profile({ wallet: a.wallet });
  const validUntil = new Date(Date.now() + (o.hours ?? 5) * 3_600_000);
  const authMessage = buildPaddleAuth({ cluster: 'devnet', show: showId, wallet: a.wallet, session: session.wallet, max: o.maxBid ?? null, valid: validUntil.getTime() });
  const paddle = await env.svc.registerPaddle({ showId, profileId: p.id, sessionPubkey: session.wallet, maxBid: o.maxBid ?? null, validUntil, authMessage, authSignature: a.sign(authMessage) });
  return { actor: a, session, profileId: p.id, paddleId: paddle.id, number: paddle.number };
}

export const nonce = () => randomBytes(8).toString('hex');

export interface BidOpts {
  showId: string;
  lotId: string;
  amount: bigint | string;
  who: Bidder;
  signer?: 'wallet' | 'session';
  /** override fields of the signed text (they will then differ from the body: a tamper) */
  text?: Partial<{ show: string; lot: string; amount: string; cluster: string; bidder: string; paddle: string | null; nonce: string; issued: number }>;
  /** sign with this key instead of the honest one */
  signWith?: Actor;
  /** override body fields after signing */
  body?: Partial<{ lotId: string; amount: string }>;
}

/** A BidRequest body: the signed intent plus the lot and amount it claims. */
export function bidBody(o: BidOpts) {
  const signer = o.signer ?? 'wallet';
  const amount = String(o.amount);
  const message = buildBidIntent({
    cluster: 'devnet', show: o.showId, lot: o.lotId, amount, bidder: o.who.actor.wallet, paddle: o.who.paddleId, nonce: nonce(), issued: Date.now(), ...(o.text as object),
  });
  const key = o.signWith ?? (signer === 'wallet' ? o.who.actor : o.who.session);
  return { lotId: o.lotId, amount, intent: { message, signature: key.sign(message), signer }, ...(o.body ?? {}) };
}

export const resetLimits = (env: Env) => env.pool.query('delete from rate_limits');
export const uuid = randomUUID;
