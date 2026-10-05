/**
 * Minimal JSON-RPC client over fetch with failover. No @solana/web3.js Connection: a Connection holds no failover, and
 * every call here is a one-line method with a typed result.
 *
 * Order: the primary gets two attempts (one retry), then each fallback one (SOLANA_RPC_URL, then SOLANA_RPC_FALLBACK_URLS, then the
 * public endpoint). Transport failures, 5xx, timeouts and "node unhealthy" errors move on; a real JSON-RPC answer (for example
 * "account not found" as an error) is final and is thrown as RpcError so callers can interpret it. When every endpoint fails the
 * result is ChainError('rpc_unavailable').
 *
 * HTTP 429 is special (the public devnet RPC rate-limits shared Vercel IPs): the endpoint's circuit opens for 30 to 60 s (its
 * Retry-After, clamped) and the next endpoint is tried at once. Only when no other endpoint is left does the call wait and retry, at most
 * twice, with exponential backoff plus jitter and never more than `maxWaitMs` (2 s) in total, so a page read is never held up by it.
 * While every endpoint's circuit is open a call fails at once with rpc_unavailable and sends no request: a rate-limited RPC is left alone.
 */
import type { Cluster } from '@/contracts';
import { rpcUrlsFor } from './config';
import { ChainError } from './errors';

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

export type RpcCall = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
export interface RpcOptions {
  fetch?: typeof fetch; timeoutMs?: number; urls?: string[];
  /** Total time one call may spend waiting out a 429 (default 2000). */
  maxWaitMs?: number;
  /** Test seams. */
  now?: () => number; sleep?: (ms: number) => Promise<void>; random?: () => number;
}

/** JSON-RPC codes that mean "this node cannot answer right now", not "your request is wrong". */
const UNHEALTHY = new Set([-32005, -32004, -32009, -32014, -32015, -32016]);

export const BREAKER_MIN_MS = 30_000;
export const BREAKER_MAX_MS = 60_000;
/** Endpoint URL to the time (ms) its circuit stays open. Per server instance, like the rate limit it reacts to. */
const openUntil = new Map<string, number>();
/** Tests only. */
export const resetRpcBreakers = (): void => openUntil.clear();
export const rpcCircuitOpen = (url: string, now = Date.now()): boolean => (openUntil.get(url) ?? 0) > now;

/** Retry-After: whole seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(h: string | null | undefined, now: number): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

type Reply<T> = { kind: 'ok'; value: T } | { kind: '429'; retryAfter: number | null } | { kind: 'transient'; why: string };

export function makeRpc(cluster: Cluster, opts: RpcOptions = {}): RpcCall {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  return async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const urls = opts.urls ?? rpcUrlsFor(cluster);
    const attempts = [urls[0]!, ...urls]; // the primary twice: one retry
    let last = 'no endpoint configured';
    let waitedMs = 0;

    const once = async (url: string): Promise<Reply<T>> => {
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429) return { kind: '429', retryAfter: retryAfterMs(res.headers?.get?.('retry-after'), now()) };
        if (!res.ok) return { kind: 'transient', why: `HTTP ${res.status}` };
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
        if (body.error) {
          if (UNHEALTHY.has(body.error.code)) return { kind: 'transient', why: `rpc ${body.error.code}` };
          throw new RpcError(body.error.code, body.error.message, body.error.data);
        }
        return { kind: 'ok', value: body.result as T };
      } catch (e) {
        if (e instanceof RpcError) throw e;
        return { kind: 'transient', why: e instanceof Error ? e.name : 'error' };
      }
    };
    const trip = (url: string, retryAfter: number | null) => {
      openUntil.set(url, now() + Math.min(BREAKER_MAX_MS, Math.max(BREAKER_MIN_MS, retryAfter ?? 0)));
    };

    for (let i = 0; i < attempts.length; i++) {
      const url = attempts[i]!;
      if (rpcCircuitOpen(url, now())) { last = 'HTTP 429'; continue; }
      let r = await once(url);
      // Another endpoint with a closed circuit is still to come: leave this one at once. Otherwise wait and retry, twice at most, within the budget.
      const another = () => attempts.slice(i + 1).some((u) => u !== url && !rpcCircuitOpen(u, now()));
      for (let retry = 0; r.kind === '429' && !another() && retry < 2; retry++) {
        const delay = r.retryAfter ?? Math.round(250 * 2 ** retry * (0.5 + random()));
        if (waitedMs + delay > (opts.maxWaitMs ?? 2000)) break;
        waitedMs += delay;
        await sleep(delay);
        r = await once(url);
      }
      if (r.kind === 'ok') return r.value;
      if (r.kind === '429') { last = 'HTTP 429'; trip(url, r.retryAfter); } else last = r.why;
    }
    throw new ChainError('rpc_unavailable', `every RPC endpoint failed (${last})`);
  };
}

// ---- typed helpers ------------------------------------------------------------------------------

export interface RawAccount { owner: string; lamports: number; data: Uint8Array }
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

export async function getAccount(call: RpcCall, address: string): Promise<RawAccount | null> {
  const r = await call<{ value: { owner: string; lamports: number; data: [string, string] } | null }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  return r.value ? { owner: r.value.owner, lamports: r.value.lamports, data: b64(r.value.data[0]) } : null;
}

/** One request for many accounts (at most 100 per request, the node's limit); the result lines up with `addresses`. */
export async function getMultipleAccounts(call: RpcCall, addresses: string[]): Promise<(RawAccount | null)[]> {
  const out: (RawAccount | null)[] = [];
  for (let i = 0; i < addresses.length; i += 100) {
    const r = await call<{ value: ({ owner: string; lamports: number; data: [string, string] } | null)[] }>('getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]);
    out.push(...r.value.map((v) => (v ? { owner: v.owner, lamports: v.lamports, data: b64(v.data[0]) } : null)));
  }
  return out;
}

export async function getLatestBlockhash(call: RpcCall): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  return (await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
}

export async function getBalanceLamports(call: RpcCall, address: string): Promise<bigint> {
  return BigInt((await call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }])).value);
}

export const getBlockHeight = (call: RpcCall): Promise<number> => call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);

export async function simulateTransaction(call: RpcCall, txBase64: string): Promise<{ err: unknown | null; logs: string[] }> {
  const r = await call<{ value: { err: unknown | null; logs: string[] | null } }>('simulateTransaction', [txBase64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' }]);
  return { err: r.value.err, logs: r.value.logs ?? [] };
}

export const sendTransaction = (call: RpcCall, txBase64: string): Promise<string> =>
  call<string>('sendTransaction', [txBase64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 }]);

export async function getSignatureStatus(call: RpcCall, signature: string): Promise<{ err: unknown | null; confirmationStatus: string | null } | null> {
  const r = await call<{ value: ({ err: unknown | null; confirmationStatus?: string | null } | null)[] }>('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);
  const s = r.value[0];
  return s ? { err: s.err, confirmationStatus: s.confirmationStatus ?? null } : null;
}

export const getParsedTransaction = (call: RpcCall, signature: string): Promise<unknown | null> =>
  call('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
