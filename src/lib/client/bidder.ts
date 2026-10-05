/**
 * Everything the bidder's browser signs or stores: the paddle authorisation text, the bid intent text
 * (exact text, fixed order, no extra lines), the ephemeral paddle session key in
 * sessionStorage, and the mapping from API error codes and wallet errors to message keys.
 *
 * Pure apart from `crypto.getRandomValues` (injectable) and the storage handed in by the caller, so all of
 * it is tested in node.
 */
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ERROR_CODES, type BidIntentFields, type ErrorCode } from '@/contracts';

// ---------------------------------------------------------------------------------------------
// Signed texts
// ---------------------------------------------------------------------------------------------

export interface PaddleAuthFields { cluster: string; show: string; wallet: string; session: string; max: string | null; valid: number }

/** "hammerprice paddle v1": signed once per show by the wallet; the session key then signs each bid silently. */
export function buildPaddleAuth(f: PaddleAuthFields): string {
  return [
    'hammerprice paddle v1',
    `cluster: ${f.cluster}`,
    `show: ${f.show}`,
    `wallet: ${f.wallet}`,
    `session: ${f.session}`,
    `max: ${f.max ?? '-'}`,
    `valid: ${f.valid}`,
  ].join('\n');
}

/** "hammerprice bid v1": bound to cluster, show, lot and amount so it cannot be replayed elsewhere. */
export function buildBidIntent(f: BidIntentFields): string {
  return [
    'hammerprice bid v1',
    `cluster: ${f.cluster}`,
    `show: ${f.show}`,
    `lot: ${f.lot}`,
    `amount: ${f.amount}`,
    `bidder: ${f.bidder}`,
    `paddle: ${f.paddle ?? '-'}`,
    `nonce: ${f.nonce}`,
    `issued: ${f.issued}`,
  ].join('\n');
}

/** 16 hex characters. */
export function newNonce(fill: (b: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return Array.from(fill(new Uint8Array(8)), (x) => x.toString(16).padStart(2, '0')).join('');
}

export const MAX_PADDLE_HOURS = 6;

/** Expiry in unix ms, clamped to the contract's 6 hours and pulled back 60 s so clock skew cannot push it over. */
export const paddleValidUntil = (nowMs: number, hours: number): number => nowMs + Math.min(MAX_PADDLE_HOURS, Math.max(1, hours)) * 3_600_000 - 60_000;

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** "12.5" -> 12500000n. Null for anything that is not a plain decimal with at most 6 places. */
export function parseUsdc(input: string): bigint | null {
  const m = /^(\d{1,12})(?:[.,](\d{1,6}))?$/.exec(input.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

// ---------------------------------------------------------------------------------------------
// Get ready to bid: the three steps before a first bid, and the defaults of the bidding number
// ---------------------------------------------------------------------------------------------

/** Mirrors MIN_PADDLE_USDC (src/lib/auth/me.ts): the least a wallet must hold to register. The server stays the judge. */
export const FUNDED_MIN_USDC = 1_000_000n;
/** The default spending limit never exceeds this (250 USDC). */
export const DEFAULT_LIMIT_CAP = 250_000_000n;
export const DEFAULT_PADDLE_HOURS = 3;

/** The limit a new bidding number gets unless the person changes it: the wallet's balance, at most 250 USDC. */
export function defaultSpendingLimit(balance: string | null | undefined): bigint {
  let b: bigint;
  try { b = BigInt(balance ?? ''); } catch { return DEFAULT_LIMIT_CAP; }
  return b > 0n && b < DEFAULT_LIMIT_CAP ? b : DEFAULT_LIMIT_CAP;
}

/** 1 connect, 2 verify (sign in), 3 funds, 4 everything is in place: only the bidding number is left. */
export function readyStep(i: { wallet: string | null; me: 'off' | 'loading' | 'signed_out' | 'ready' | 'error'; usdc: string | null | undefined }): 1 | 2 | 3 | 4 {
  if (!i.wallet) return 1;
  if (i.me !== 'ready') return 2;
  let funded = false;
  try { funded = BigInt(i.usdc ?? '') >= FUNDED_MIN_USDC; } catch { funded = false; }
  return funded ? 4 : 3;
}

// ---------------------------------------------------------------------------------------------
// Paddle session key (per tab, sessionStorage)
// ---------------------------------------------------------------------------------------------

export interface SessionKey { publicKey: string; secretKey: string }
export interface StoredPaddle extends SessionKey { paddleId: string | null; validUntil: number }

export function generateSessionKey(): SessionKey {
  const kp = nacl.sign.keyPair();
  return { publicKey: bs58.encode(kp.publicKey), secretKey: toBase64(kp.secretKey) };
}

/** Signature is base64, as the API expects. */
export function signWithSession(secretKeyB64: string, message: string): string {
  return toBase64(nacl.sign.detached(new TextEncoder().encode(message), fromBase64(secretKeyB64)));
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null | undefined;
const storageKey = (showId: string, wallet: string) => `hp:paddle:${showId}:${wallet}`;

export function loadPaddleKey(store: Store, showId: string, wallet: string, nowMs: number): StoredPaddle | null {
  try {
    const raw = store?.getItem(storageKey(showId, wallet));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredPaddle>;
    if (typeof v.secretKey !== 'string' || typeof v.publicKey !== 'string' || typeof v.validUntil !== 'number') return null;
    if (v.validUntil <= nowMs) { store?.removeItem(storageKey(showId, wallet)); return null; }
    return { secretKey: v.secretKey, publicKey: v.publicKey, validUntil: v.validUntil, paddleId: typeof v.paddleId === 'string' ? v.paddleId : null };
  } catch {
    return null;
  }
}
export function savePaddleKey(store: Store, showId: string, wallet: string, p: StoredPaddle): void {
  try { store?.setItem(storageKey(showId, wallet), JSON.stringify(p)); } catch { /* private window: bids fall back to a wallet signature */ }
}
export function clearPaddleKey(store: Store, showId: string, wallet: string): void {
  try { store?.removeItem(storageKey(showId, wallet)); } catch { /* nothing to clear */ }
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Codes a bidder can meet on the bid, paddle and sign-in routes. Each has a message under room.errors.<code>. */
export const BID_ERROR_CODES = [
  'validation', 'unauthenticated', 'bad_signature', 'replay', 'banned', 'forbidden', 'not_found', 'wrong_state',
  'nonce_used', 'expired', 'wrong_domain', 'rate_limited', 'paused', 'balance_unavailable', 'rpc_unavailable',
  'insufficient_funds', 'show_not_live', 'show_ended', 'lot_not_open', 'lot_closed', 'bid_too_low', 'amount_too_large',
  'self_bid', 'already_high_bidder', 'no_paddle', 'show_paused', 'mainnet_config_incomplete', 'cluster_config_conflict',
] as const satisfies readonly ErrorCode[];

/** Codes the settlement routes can answer with. Each has a message under settlement.errors.<code>. */
export const SETTLE_ERROR_CODES = [
  'unauthenticated', 'not_found', 'not_party', 'not_buyer', 'wrong_state', 'tx_mismatch', 'bad_signature', 'round_expired',
  'blockhash_expired', 'counterparty_pending', 'simulation_failed', 'insufficient_usdc', 'asset_not_ready',
  'balance_unavailable', 'rpc_unavailable', 'rate_limited', 'paused', 'banned', 'mainnet_config_incomplete', 'cluster_config_conflict',
] as const satisfies readonly ErrorCode[];

const isCode = (v: unknown): v is ErrorCode => typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);

/** Message key (`errors.<code>`) for an API error; codes outside `known` fall back to `errors.generic`. */
export function errorKey(code: unknown, known: readonly string[] = BID_ERROR_CODES): string {
  return isCode(code) && known.includes(code) ? `errors.${code}` : 'errors.generic';
}

/** `no_paddle` with this `detail` (set by the server, src/lib/auth/intent.ts PADDLE_LIMIT_DETAIL) means the bid is above the bidder number's spending limit. */
export const PADDLE_LIMIT_DETAIL = 'paddle_limit';

/** The message key of a failed bid: like errorKey, but an over-the-limit bid gets its own text instead of "Finish getting ready to bid first". */
export function bidFailureKey(f: Pick<ApiFailure, 'code' | 'detail'>): string {
  return f.code === 'no_paddle' && f.detail === PADDLE_LIMIT_DETAIL ? 'errors.paddle_limit' : errorKey(f.code);
}

export type WalletFailure = 'rejected' | 'cluster' | 'unsupported' | 'unknown';

/** What a wallet error means for the user. "cluster" = the wallet is most likely on another network than the show. */
export function classifyWalletError(e: unknown): WalletFailure {
  const err = e as { name?: string; message?: string; code?: number; error?: { message?: string; code?: number } } | null;
  const msg = `${err?.message ?? ''} ${err?.error?.message ?? ''}`.toLowerCase();
  const code = err?.code ?? err?.error?.code;
  if (code === 4001 || /reject|declin|denied|cancel/.test(msg)) return 'rejected';
  if (/not support|unsupported|not implemented/.test(msg) || err?.name === 'WalletNotSupportedError') return 'unsupported';
  if (/simulat|blockhash|cluster|network|chain|genesis|unexpected error|insufficient funds for (fee|rent)/.test(msg)) return 'cluster';
  return 'unknown';
}

/** The body of an error response, tolerant of a non-JSON failure. */
export interface ApiFailure { code: unknown; reason?: string; minNext?: string; retryAfterS?: number; detail?: string; status: number }
export async function readFailure(res: Response): Promise<ApiFailure> {
  const body = (await res.json().catch(() => null)) as { code?: unknown; reason?: string; minNext?: string; retryAfterS?: number; detail?: unknown } | null;
  return { code: body?.code, reason: body?.reason, minNext: body?.minNext, retryAfterS: body?.retryAfterS, detail: typeof body?.detail === 'string' ? body.detail : undefined, status: res.status };
}
