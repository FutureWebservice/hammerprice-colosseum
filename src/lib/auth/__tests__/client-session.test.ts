import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { SESSION_PATHS, SignInError, fetchMe, isWalletRejection, signInWithWallet, signOutRequest } from '@/lib/client/session';
import { ROUTES } from '@/contracts';
import { normalizeCluster, configuredCluster, rpcEndpoint } from '../config';
import { verifySigned } from '../ed25519';
import { actor } from './testkit';
import meFixture from '@/contracts/fixtures/me.json';

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('signInWithWallet', () => {
  const a = actor();
  const secretKey = a.secretKey;
  const signMessage = async (m: Uint8Array) => nacl.sign.detached(m, secretKey);

  it('asks for a challenge, signs exactly the returned text and posts the signature', async () => {
    const message = 'the exact challenge text';
    const calls: Array<{ path: string; body: Record<string, string> }> = [];
    const f = vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, body: JSON.parse(init!.body as string) });
      return path.endsWith('challenge') ? res(200, { nonce: 'n', message, expiresAt: '2026-10-06T12:05:00.000Z' }) : res(200, { wallet: a.wallet, profile: {} });
    });
    await signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: f as unknown as typeof fetch });
    expect(calls.map((c) => c.path)).toEqual(['/api/auth/challenge', '/api/auth/verify']);
    expect(calls[0].body).toEqual({ wallet: a.wallet });
    expect(calls[1].body.message).toBe(message);
    expect(calls[1].body.wallet).toBe(a.wallet);
    expect(verifySigned(message, calls[1].body.signature, a.wallet)).toBe(true);
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
  });

  it('needs a wallet that can sign messages', async () => {
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: undefined, fetchImpl: vi.fn() as never })).rejects.toMatchObject({ code: 'no_sign_message' });
  });

  it('maps a declined prompt to wallet_rejected and never posts', async () => {
    const f = vi.fn(async () => res(200, { nonce: 'n', message: 'm', expiresAt: 'x' }));
    const reject = async () => { throw Object.assign(new Error('User rejected the request.'), { name: 'WalletSignMessageError' }); };
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: reject, fetchImpl: f as never })).rejects.toMatchObject({ code: 'wallet_rejected' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('carries the server error code through (rate limit, wrong domain, banned)', async () => {
    for (const code of ['rate_limited', 'wrong_domain', 'banned'] as const) {
      const f = vi.fn(async (path: string) => (path.endsWith('challenge') ? res(200, { nonce: 'n', message: 'm', expiresAt: 'x' }) : res(code === 'banned' ? 403 : 401, { ok: false, code, reason: 'nope' })));
      await expect(signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: f as never })).rejects.toMatchObject({ code, message: 'nope' });
    }
  });

  it('reports a network failure and a non-JSON error body as `network`', async () => {
    await expect(signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as never })).rejects.toMatchObject({ code: 'network' });
    await expect(signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: (async () => new Response('<html>', { status: 502 })) as never })).rejects.toBeInstanceOf(SignInError);
  });
});

describe('fetchMe and signOut', () => {
  it('returns the viewer, or null on 401, and asks for one show when told', async () => {
    const f = vi.fn(async (_path: string, _init?: RequestInit) => res(200, meFixture));
    expect((await fetchMe('3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10', f as never))?.wallet).toBe(meFixture.wallet);
    expect(f.mock.calls[0][0]).toBe('/api/me?show=3f6c1f2e-9b0a-4f43-8a52-1d7a0c5e7b10');
    expect(await fetchMe(undefined, (async () => res(401, { ok: false, code: 'unauthenticated', reason: 'x' })) as never)).toBeNull();
  });

  it('reads the 204 an anonymous visitor now gets as signed out', async () => {
    expect(await fetchMe(undefined, (async () => new Response(null, { status: 204 })) as never)).toBeNull();
  });

  it('throws on other failures (a ban must not look like "signed out")', async () => {
    await expect(fetchMe(undefined, (async () => res(403, { ok: false, code: 'banned', reason: 'x' })) as never)).rejects.toMatchObject({ code: 'banned' });
  });

  it('signOutRequest posts to logout and never throws', async () => {
    const f = vi.fn(async (_path: string, _init?: RequestInit) => res(204));
    await signOutRequest(f as never);
    expect(f.mock.calls[0]).toEqual(['/api/auth/logout', expect.objectContaining({ method: 'POST' })]);
    await expect(signOutRequest((async () => { throw new Error('offline'); }) as never)).resolves.toBeUndefined();
  });

  it('recognises wallet rejections', () => {
    expect(isWalletRejection(new Error('User rejected the request'))).toBe(true);
    expect(isWalletRejection(new Error('Signing failed: timeout'))).toBe(false);
    expect(isWalletRejection('x')).toBe(false);
  });
});

describe('cluster and endpoint', () => {
  it('defaults to devnet for anything that is not mainnet', () => {
    for (const v of [undefined, null, '', 'devnet', 'testnet', 'Mainnet-Beta ', 'garbage']) expect(normalizeCluster(v as string)).toBe(v === 'Mainnet-Beta ' ? 'mainnet-beta' : 'devnet');
    expect(normalizeCluster('mainnet')).toBe('mainnet-beta');
  });

  it('the server reads SOLANA_CLUSTER first, then the public mirror', () => {
    expect(configuredCluster({ SOLANA_CLUSTER: 'mainnet-beta', NEXT_PUBLIC_SOLANA_NETWORK: 'devnet' })).toBe('mainnet-beta');
    expect(configuredCluster({ NEXT_PUBLIC_SOLANA_NETWORK: 'mainnet-beta' })).toBe('mainnet-beta');
    expect(configuredCluster({})).toBe('devnet');
  });

  it('uses a clean https endpoint from the environment and ignores a polluted one', () => {
    expect(rpcEndpoint('devnet', 'https://rpc.example/key')).toBe('https://rpc.example/key');
    expect(rpcEndpoint('devnet', 'https://mainnet.helius-rpc.com      # Client-safe (no key)')).toBe('https://api.devnet.solana.com');
    expect(rpcEndpoint('devnet', 'http://insecure.example')).toBe('https://api.devnet.solana.com');
    expect(rpcEndpoint('devnet', 'not a url')).toBe('https://api.devnet.solana.com');
    expect(rpcEndpoint('mainnet-beta', '')).toBe('https://api.mainnet-beta.solana.com');
    expect(rpcEndpoint('devnet', undefined)).toBe('https://api.devnet.solana.com');
  });
});

describe('SESSION_PATHS', () => {
  it('are the AUTH routes of the contract (the browser code holds literals so the layout does not carry every API schema)', () => {
    expect(SESSION_PATHS).toEqual({ me: ROUTES.me.path, authChallenge: ROUTES.authChallenge.path, authVerify: ROUTES.authVerify.path, authLogout: ROUTES.authLogout.path });
  });
});
