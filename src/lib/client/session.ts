/**
 * Browser side of sign-in: plain fetch calls to the AUTH routes, no React, so they can be tested with a fake
 * fetch. The flow is challenge -> the wallet signs the returned text -> verify (which sets the HttpOnly
 * session cookie). The cookie itself is invisible here; `fetchMe` is how the page learns it is signed in.
 */
import type { ErrorCode, MeResponse } from '@/contracts';

/**
 * The AUTH paths as literals. They were read from ROUTES, but ROUTES holds every API schema, so importing it put zod and all the contracts (about 100 kB of
 * script) into the layout of every page. A test pins these to ROUTES (session.test.ts).
 */
export const SESSION_PATHS = { me: '/api/me', authChallenge: '/api/auth/challenge', authVerify: '/api/auth/verify', authLogout: '/api/auth/logout' } as const;

export type SignInErrorCode = ErrorCode | 'wallet_rejected' | 'no_sign_message' | 'not_connected' | 'timeout' | 'wallet_failed' | 'network';

/** `code` is stable and meant for the UI to translate; `message` is the server's English reason, for logs. */
export class SignInError extends Error {
  constructor(readonly code: SignInErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SignInError';
  }
}

type Fetch = typeof fetch;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function failure(res: Response): Promise<SignInError> {
  // Loaded when there is an error to read, not with every page (see SESSION_PATHS).
  const { ErrorResponseSchema } = await import('@/contracts/errors');
  const body = ErrorResponseSchema.safeParse(await res.json().catch(() => null));
  return body.success ? new SignInError(body.data.code, body.data.reason) : new SignInError('network', `HTTP ${res.status}`);
}

async function call(f: Fetch, path: string, init: RequestInit): Promise<Response> {
  try {
    return await f(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new SignInError('network', 'Could not reach the server');
  }
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/**
 * What a wallet-side failure means. The wallet adapter wraps EVERY failure in WalletSignMessageError or WalletConnectionError, so that name says nothing
 * (it used to make every failure read as "you declined"); the cause is in the inner error, which is what is looked at here.
 */
export type WalletSignFailure = 'wallet_rejected' | 'no_sign_message' | 'not_connected' | 'timeout' | 'wallet_failed';

export function classifyWalletSignError(e: unknown): WalletSignFailure {
  type E = { name?: unknown; message?: unknown; code?: unknown; error?: unknown; cause?: unknown };
  const chain: E[] = [];
  for (let x: unknown = e, i = 0; x && typeof x === 'object' && i < 4; i++) {
    chain.push(x as E);
    x = (x as E).error ?? (x as E).cause;
  }
  const any = (f: (name: string, message: string, code: unknown) => boolean) => chain.some((x) => f(String(x.name ?? ''), String(x.message ?? ''), x.code));
  if (any((n, m, c) => c === 4001 || /UserRejected/i.test(n) || /user rejected|rejected the request|declin|denied|cancel/i.test(m))) return 'wallet_rejected';
  if (any((n, m) => n === 'WalletNotConnectedError' || /not connected|wallet.{0,12}disconnected/i.test(m))) return 'not_connected';
  if (any((n, m, c) => n === 'TimeoutError' || c === 'timeout' || /timed? ?out/i.test(m))) return 'timeout';
  if (any((n, m) => n === 'WalletNotSupportedError' || /not support|unsupported|not implemented|is not a function|undefined is not/i.test(m))) return 'no_sign_message';
  return 'wallet_failed';
}

/** Is this what a wallet throws when the person closes or declines the prompt? */
export const isWalletRejection = (e: unknown): boolean => classifyWalletSignError(e) === 'wallet_rejected';

/** Console line for debugging a phone report: the error's name and code only, never its message (it can carry the signed text) and never a key. */
function logSignFailure(e: unknown, kind: WalletSignFailure): void {
  const x = (e && typeof e === 'object' ? e : {}) as { name?: unknown; code?: unknown; error?: { name?: unknown; code?: unknown } };
  console.warn('[sign-in] wallet error', { kind, name: String(x.name ?? typeof e), code: x.code ?? null, innerName: x.error ? String(x.error.name ?? '') : null, innerCode: x.error?.code ?? null });
}

/** The signed-in viewer, or null when there is no valid session (204; a 401 from an older deploy reads the same). `show` adds that show's paddle and standing. */
export async function fetchMe(show?: string, f: Fetch = fetch): Promise<MeResponse | null> {
  const res = await call(f, show ? `${SESSION_PATHS.me}?show=${encodeURIComponent(show)}` : SESSION_PATHS.me, { method: 'GET', cache: 'no-store' });
  if (res.status === 204 || res.status === 401) return null;
  if (!res.ok) throw await failure(res);
  return (await res.json()) as MeResponse;
}

/** The wallet-standard `solana:signIn` (Sign In With Solana) input and output, as far as we use them: the adapter's `signIn`. */
export interface SiwsInput { domain: string; address: string; statement: string; uri: string; version: string; chainId: string; nonce: string; issuedAt: string; expirationTime: string }
export type SiwsFn = (input: SiwsInput) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array; account: { address: string } }>;
export type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;
export interface Signers { signMessage?: SignMessageFn; signIn?: SiwsFn }

const CHALLENGE_RE = /^(\S+) wants you to sign in with your Solana account:\n(\S+)\n\n(.+)\n\nURI: (\S+)\nVersion: (\S+)\nChain ID: (\S+)\nNonce: (\S+)\nIssued At: (\S+)\nExpiration Time: (\S+)$/;

/** The challenge text as `solana:signIn` fields (the wallet writes the same text itself), or null for a layout we do not know. */
export function parseChallengeForSiws(message: string): SiwsInput | null {
  const m = CHALLENGE_RE.exec(message);
  return m ? { domain: m[1], address: m[2], statement: m[3], uri: m[4], version: m[5], chainId: m[6], nonce: m[7], issuedAt: m[8], expirationTime: m[9] } : null;
}

/** No answer from the wallet for this long: the prompt was lost (a mobile app switch can drop it) and the person can try again. */
export const WALLET_TIMEOUT_MS = 90_000;
/** A wallet that says "not connected" a moment after connecting (the adapter state is still settling) gets one more try after this. */
export const NOT_CONNECTED_RETRY_MS = 300;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('The wallet did not answer'), { name: 'TimeoutError' })), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

/**
 * Runs the whole exchange. Throws SignInError; resolves once the cookie is set.
 *
 * The wallet signs through wallet-standard `solana:signIn` when it has it, else `signMessage`. A `signIn` that fails for any other reason than the person
 * declining (or no answer at all), or that returns text other than the challenge, falls back to `signMessage`. `getSigners` (when given) is read again on
 * every attempt, so a wallet that had not finished connecting is found ready on the second one.
 */
export async function signInWithWallet(input: {
  wallet: string;
  signMessage?: SignMessageFn;
  signIn?: SiwsFn;
  getSigners?: () => Signers;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  retryMs?: number;
}): Promise<void> {
  const f = input.fetchImpl ?? fetch;
  const signers = (): Signers => input.getSigners?.() ?? { signMessage: input.signMessage, signIn: input.signIn };
  const first = signers();
  if (!first.signMessage && !first.signIn) throw new SignInError('no_sign_message', 'This wallet cannot sign messages');
  const timeoutMs = input.timeoutMs ?? WALLET_TIMEOUT_MS;

  const cres = await call(f, SESSION_PATHS.authChallenge, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ wallet: input.wallet }) });
  if (!cres.ok) throw await failure(cres);
  const { message } = (await cres.json()) as { message: string };

  const attempt = async (): Promise<Uint8Array> => {
    const s = signers();
    const fields = s.signIn ? parseChallengeForSiws(message) : null;
    if (s.signIn && fields) {
      try {
        const out = await withTimeout(s.signIn(fields), timeoutMs);
        // The wallet wrote the text itself: use it only when it is exactly the challenge (the server accepts one spelling), else ask signMessage.
        if (new TextDecoder().decode(out.signedMessage) === message && out.account.address === input.wallet) return out.signature;
      } catch (e) {
        const kind = classifyWalletSignError(e);
        if (kind === 'wallet_rejected' || kind === 'timeout' || kind === 'not_connected' || !s.signMessage) throw e;
      }
    }
    if (!s.signMessage) throw new SignInError('no_sign_message', 'This wallet cannot sign messages');
    return withTimeout(s.signMessage(new TextEncoder().encode(message)), timeoutMs);
  };

  let signature: Uint8Array;
  try {
    try {
      signature = await attempt();
    } catch (e) {
      if (classifyWalletSignError(e) !== 'not_connected') throw e;
      await sleep(input.retryMs ?? NOT_CONNECTED_RETRY_MS);
      signature = await attempt();
    }
  } catch (e) {
    if (e instanceof SignInError) throw e;
    const kind = classifyWalletSignError(e);
    logSignFailure(e, kind);
    throw new SignInError(kind, 'The wallet did not sign');
  }

  const vres = await call(f, SESSION_PATHS.authVerify, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ wallet: input.wallet, message, signature: toBase64(signature) }) });
  if (!vres.ok) throw await failure(vres);
}

export async function signOutRequest(f: Fetch = fetch): Promise<void> {
  await call(f, SESSION_PATHS.authLogout, { method: 'POST' }).catch(() => {});
}
