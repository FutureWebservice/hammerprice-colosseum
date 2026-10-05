/**
 * Helpers for the CHAIN route tests: sessions without the wallet round trip (AUTH's own tests cover sign-in), requests the way a
 * browser sends them, and a LiteSVM-backed devnet sender. Not a test file; import it only after DATABASE_URL points at the test server.
 */
import { expect } from 'vitest';
import { Keypair, Transaction, type TransactionInstruction } from '@solana/web3.js';
import type { ZodTypeAny } from 'zod';
import { ERROR_STATUS, ErrorResponseSchema, type ErrorCode } from '@/contracts';
import bs58 from 'bs58';
import { FailedTransactionMetadata } from 'litesvm';
import { ChainError } from '@/lib/chain/errors';
import type { DevnetIo } from '@/lib/chain/devnet';
import type { World } from '@/lib/chain/__tests__/svm-world';

export const ORIGIN = 'http://localhost:3000';
let ipCounter = 0;
/** A fresh client address per call, so the per-IP limits of one test never bleed into another. */
export const freshIp = () => `10.7.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;

export async function signIn(kp: Keypair): Promise<{ cookie: string; profileId: string; wallet: string }> {
  const store = await import('@/lib/auth/store');
  const { signSession, SESSION_COOKIE } = await import('@/lib/auth/session');
  const profile = await store.upsertProfile(kp.publicKey.toBase58());
  return { cookie: `${SESSION_COOKIE}=${await signSession({ wallet: profile.walletAddress, profileId: profile.id })}`, profileId: profile.id, wallet: profile.walletAddress };
}

export function request(method: 'GET' | 'POST', path: string, o: { cookie?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? freshIp(), ...(o.cookie ? { cookie: o.cookie } : {}) };
  if (method === 'POST') Object.assign(headers, { 'content-type': 'application/json', origin: ORIGIN });
  return new Request(`${ORIGIN}${path}`, { method, headers: { ...headers, ...o.headers }, body: method === 'POST' ? (typeof o.body === 'string' ? o.body : JSON.stringify(o.body ?? {})) : undefined });
}

export const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });

/** A LiteSVM sender for the faucet and the card mint; `fail` makes the next send throw like a node that refused it. */
export function svmDevnetIo(w: World, o: { lamports?: () => bigint } = {}): DevnetIo & { fail: boolean; sends: number } {
  const io = {
    fail: false, sends: 0,
    saLamports: async () => (o.lamports ? o.lamports() : w.sol(w.sa)),
    async send(ixs: TransactionInstruction[], payer: Keypair, extra: Keypair[]) {
      if (io.fail) { io.fail = false; throw new ChainError('rpc_unavailable', 'the test network is down'); }
      const tx = new Transaction();
      tx.recentBlockhash = w.svm.latestBlockhash();
      tx.feePayer = payer.publicKey;
      tx.add(...ixs);
      tx.sign(payer, ...extra);
      const r = w.svm.sendTransaction(w.kit(tx));
      if (r instanceof FailedTransactionMetadata) throw new ChainError('rpc_unavailable', `rejected: ${r.toString().slice(0, 200)}`);
      io.sends++;
      return bs58.encode(tx.signatures[0]!.signature!);
    },
  };
  return io;
}

/**
 * Response assertions shared by the route tests. `secrets()` lists what no response may ever carry (server keys); a body may not
 * mention lamports either (the settlement authority's balance is not public), nor use an em dash (house style).
 */
export function responseChecks(secrets: () => string[]) {
  const noLeak = (text: string) => { for (const s of secrets()) expect(text).not.toContain(s); expect(text).not.toMatch(/lamports/i); expect(text).not.toMatch(/\u2014/); };
  return {
    noLeak,
    async ok<S extends ZodTypeAny>(res: Response, schema: S): Promise<ReturnType<S['parse']>> {
      const text = await res.text();
      expect(res.status, text).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      noLeak(text);
      return schema.parse(JSON.parse(text));
    },
    async fails(res: Response, code: ErrorCode) {
      const text = await res.text();
      expect(res.status, text).toBe(ERROR_STATUS[code]);
      noLeak(text);
      const body = ErrorResponseSchema.parse(JSON.parse(text));
      expect(body.code).toBe(code);
      expect(res.headers.get('cache-control')).toBe('no-store');
      return body;
    },
  };
}
