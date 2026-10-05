/**
 * Sign-in with mocked wallets: wallet-standard signIn, signMessage, the real causes behind a failure (the adapter wraps every one of them in
 * WalletSignMessageError, which used to read as "you declined"), the not-connected race, the timeout, and the intent that survives a phone's app switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { SignInError, classifyWalletSignError, isWalletRejection, parseChallengeForSiws, signInWithWallet, type SiwsFn } from '@/lib/client/session';
import { INTENT_KEY, INTENT_TTL_MS, clearIntent, readIntent, resumeIntent, writeIntent, type IntentStore } from '@/lib/client/signInIntent';
import { buildLoginMessage } from '../login';
import { actor } from './testkit';

const a = actor();
const MESSAGE = buildLoginMessage({ host: 'hammerprice.test', wallet: a.wallet, chain: 'devnet', nonce: 'Nonce1234567890AB', issuedAt: '2026-10-06T12:00:00.000Z', expiresAt: '2026-10-06T12:05:00.000Z' });
const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const server = () => {
  const posted: Array<{ path: string; body: Record<string, string> }> = [];
  const f = vi.fn(async (path: string, init?: RequestInit) => {
    posted.push({ path, body: JSON.parse(init!.body as string) });
    return path.endsWith('challenge') ? res(200, { nonce: 'n', message: MESSAGE, expiresAt: 'x' }) : res(200, { wallet: a.wallet, profile: {} });
  });
  return { f: f as unknown as typeof fetch, posted, calls: f };
};
const sign = (m: Uint8Array) => nacl.sign.detached(m, a.secretKey);
const signMessage = vi.fn(async (m: Uint8Array) => sign(m));
const okSignIn = (): SiwsFn => vi.fn(async (input) => {
  expect(input.domain).toBe('hammerprice.test');
  const signedMessage = new TextEncoder().encode(MESSAGE);
  return { signedMessage, signature: sign(signedMessage), account: { address: a.wallet } };
});
/** What @solana/wallet-adapter-base throws: its own class name around the wallet's real error. */
const wrapped = (inner: Partial<Error> & { code?: number }, message = '') => Object.assign(new Error(message), { name: 'WalletSignMessageError', error: Object.assign(new Error(inner.message ?? ''), inner) });
const fast = { retryMs: 1 };

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); }); // the failure log line is expected
afterEach(() => { vi.restoreAllMocks(); signMessage.mockClear(); });

describe('signing in', () => {
  it('uses wallet-standard signIn when the wallet has it, with the challenge as SIWS fields, and never asks signMessage', async () => {
    const s = server();
    const signIn = okSignIn();
    await signInWithWallet({ wallet: a.wallet, signIn, signMessage, fetchImpl: s.f, ...fast });
    expect(signIn).toHaveBeenCalledOnce();
    expect(signMessage).not.toHaveBeenCalled();
    expect(s.posted[1].body).toMatchObject({ wallet: a.wallet, message: MESSAGE });
  });

  it('falls back to signMessage when there is no signIn', async () => {
    const s = server();
    await signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: s.f, ...fast });
    expect(signMessage).toHaveBeenCalledOnce();
    expect(s.posted.map((p) => p.path)).toEqual(['/api/auth/challenge', '/api/auth/verify']);
  });

  it('falls back to signMessage when signIn breaks for a reason other than a decline, or returns another text', async () => {
    for (const signIn of [
      vi.fn(async () => { throw wrapped({ message: 'Invalid sign in input' }); }),
      vi.fn(async () => ({ signedMessage: new TextEncoder().encode('another text'), signature: new Uint8Array(64), account: { address: a.wallet } })),
    ] as unknown as SiwsFn[]) {
      const s = server();
      await signInWithWallet({ wallet: a.wallet, signIn, signMessage, fetchImpl: s.f, ...fast });
      expect(s.posted[1].body.message).toBe(MESSAGE);
    }
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  it('a declined prompt is wallet_rejected (code 4001, also inside the adapter wrapper), posts nothing and does not fall back', async () => {
    for (const e of [Object.assign(new Error('User rejected the request.'), { code: 4001 }), wrapped({ message: 'User rejected the request.', code: 4001 }), wrapped({ message: 'x', code: 4001 })]) {
      const s = server();
      const signIn = vi.fn(async () => { throw e; }) as unknown as SiwsFn;
      await expect(signInWithWallet({ wallet: a.wallet, signIn, signMessage, fetchImpl: s.f, ...fast })).rejects.toMatchObject({ code: 'wallet_rejected' });
      expect(s.posted.map((p) => p.path)).toEqual(['/api/auth/challenge']);
    }
    expect(signMessage).not.toHaveBeenCalled();
  });

  it('a wallet that cannot sign messages says so, before any request', async () => {
    const s = server();
    await expect(signInWithWallet({ wallet: a.wallet, fetchImpl: s.f })).rejects.toMatchObject({ code: 'no_sign_message' });
    expect(s.calls).not.toHaveBeenCalled();
  });

  it('a signMessage that is not a function in this browser (TypeError inside the adapter wrapper) is "cannot sign", not "you declined"', async () => {
    const s = server();
    const broken = vi.fn(async () => { throw Object.assign(new Error(''), { name: 'WalletSignMessageError', error: new TypeError('t.signMessage is not a function') }); });
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: broken, fetchImpl: s.f, ...fast })).rejects.toMatchObject({ code: 'no_sign_message' });
  });

  it('an unknown wallet failure is wallet_failed, not a decline', async () => {
    const s = server();
    const broken = vi.fn(async () => { throw wrapped({ name: 'InternalError', message: 'Something broke' }); });
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: broken, fetchImpl: s.f, ...fast })).rejects.toMatchObject({ code: 'wallet_failed' });
  });

  it('retries once after a short wait when the wallet says "not connected" (the adapter was still settling)', async () => {
    const s = server();
    let first = true;
    const flaky = vi.fn(async (m: Uint8Array) => {
      if (first) { first = false; throw Object.assign(new Error(), { name: 'WalletNotConnectedError' }); }
      return sign(m);
    });
    await signInWithWallet({ wallet: a.wallet, signMessage: flaky, fetchImpl: s.f, ...fast });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(s.posted).toHaveLength(2);
  });

  it('reads the wallet again on the retry (getSigners): a signer that only appears the second time is used', async () => {
    const s = server();
    let n = 0;
    const getSigners = () => (++n < 3 ? { signMessage: vi.fn(async () => { throw Object.assign(new Error(), { name: 'WalletNotConnectedError' }); }) } : { signMessage });
    await signInWithWallet({ wallet: a.wallet, getSigners, fetchImpl: s.f, ...fast });
    expect(signMessage).toHaveBeenCalledOnce();
  });

  it('gives up with not_connected when it stays disconnected', async () => {
    const s = server();
    const gone = vi.fn(async () => { throw Object.assign(new Error(), { name: 'WalletNotConnectedError' }); });
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: gone, fetchImpl: s.f, ...fast })).rejects.toMatchObject({ code: 'not_connected' });
    expect(gone).toHaveBeenCalledTimes(2);
  });

  it('a wallet that never answers ends in a timeout, which can be retried', async () => {
    const s = server();
    const hung = vi.fn(() => new Promise<Uint8Array>(() => {}));
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: hung, fetchImpl: s.f, timeoutMs: 20, ...fast })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a network failure stays "network", a server code stays the server code', async () => {
    await expect(signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: (async () => { throw new TypeError('Load failed'); }) as never, ...fast })).rejects.toMatchObject({ code: 'network' });
    const f = vi.fn(async (path: string) => (path.endsWith('challenge') ? res(200, { nonce: 'n', message: MESSAGE, expiresAt: 'x' }) : res(401, { ok: false, code: 'wrong_domain', reason: 'no' })));
    await expect(signInWithWallet({ wallet: a.wallet, signMessage, fetchImpl: f as never, ...fast })).rejects.toBeInstanceOf(SignInError);
  });

  it('logs the error name and code, never its message', async () => {
    const warn = vi.mocked(console.warn);
    const s = server();
    const bad = vi.fn(async () => { throw wrapped({ name: 'InternalError', message: 'SECRET-PAYLOAD-TEXT', code: -32603 }); });
    await expect(signInWithWallet({ wallet: a.wallet, signMessage: bad, fetchImpl: s.f, ...fast })).rejects.toMatchObject({ code: 'wallet_failed' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('WalletSignMessageError');
    expect(logged).toContain('-32603');
    expect(logged).not.toContain('SECRET-PAYLOAD-TEXT');
  });
});

describe('classifyWalletSignError', () => {
  it('reads the cause, not the adapter class', () => {
    expect(classifyWalletSignError(Object.assign(new Error('x'), { name: 'WalletSignMessageError' }))).toBe('wallet_failed');
    expect(classifyWalletSignError(Object.assign(new Error('x'), { name: 'WalletConnectionError' }))).toBe('wallet_failed');
    expect(classifyWalletSignError(wrapped({ message: 'User rejected the request.', code: 4001 }))).toBe('wallet_rejected');
    expect(classifyWalletSignError(new Error('Transaction cancelled'))).toBe('wallet_rejected');
    expect(classifyWalletSignError(Object.assign(new Error(), { name: 'WalletNotConnectedError' }))).toBe('not_connected');
    expect(classifyWalletSignError(new Error('Request timed out'))).toBe('timeout');
    expect(classifyWalletSignError(Object.assign(new Error('x'), { name: 'WalletNotSupportedError' }))).toBe('no_sign_message');
    expect(classifyWalletSignError('x')).toBe('wallet_failed');
    expect(classifyWalletSignError(null)).toBe('wallet_failed');
    expect(isWalletRejection(new Error('Signing failed: timeout'))).toBe(false);
  });
});

describe('the challenge as SIWS fields', () => {
  it('reads the text we issue, and nothing else', () => {
    expect(parseChallengeForSiws(MESSAGE)).toMatchObject({ domain: 'hammerprice.test', address: a.wallet, chainId: 'devnet', nonce: 'Nonce1234567890AB', expirationTime: '2026-10-06T12:05:00.000Z', uri: 'https://hammerprice.test' });
    expect(parseChallengeForSiws('hello')).toBeNull();
  });
});

describe('the pending sign-in survives an app switch', () => {
  const memory = (): IntentStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  };
  const NOW = 1_800_000_000_000;

  it('is found again for the same wallet while fresh (resume after the page is visible again)', () => {
    const store = memory();
    writeIntent(store, { wallet: a.wallet, at: NOW, resumed: false });
    expect(resumeIntent(store, a.wallet, NOW + 20_000)).toBe('check');
    expect(readIntent(store, NOW + 20_000)).toEqual({ wallet: a.wallet, at: NOW, resumed: false });
  });

  it('is not found for another wallet, without a wallet, when expired, or when damaged', () => {
    const store = memory();
    writeIntent(store, { wallet: a.wallet, at: NOW, resumed: false });
    expect(resumeIntent(store, 'OtherWallet', NOW)).toBe('none');
    expect(resumeIntent(store, null, NOW)).toBe('none');
    expect(resumeIntent(store, a.wallet, NOW + INTENT_TTL_MS + 1)).toBe('none');
    expect(store.data.has(INTENT_KEY)).toBe(false); // the stale one was dropped
    store.data.set(INTENT_KEY, '{nope');
    expect(readIntent(store, NOW)).toBeNull();
  });

  it('is cleared when the sign-in settles, and a blocked storage never throws', () => {
    const store = memory();
    writeIntent(store, { wallet: a.wallet, at: NOW, resumed: true });
    clearIntent(store);
    expect(readIntent(store, NOW)).toBeNull();
    const blocked: IntentStore = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    expect(() => { writeIntent(blocked, { wallet: a.wallet, at: NOW, resumed: false }); clearIntent(blocked); }).not.toThrow();
    expect(readIntent(blocked, NOW)).toBeNull();
    expect(resumeIntent(null, a.wallet, NOW)).toBe('none');
  });
});
