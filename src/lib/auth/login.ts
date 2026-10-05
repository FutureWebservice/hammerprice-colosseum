/**
 * Sign in with a Solana wallet (SIWS text, single-use server nonce). Replaces the 65-minute bearer signature.
 *
 *   1. `issueChallenge`  stores a 5-minute nonce for the wallet and returns the exact text to sign.
 *   2. The wallet signs that text (signMessage).
 *   3. `completeLogin`   parses the text strictly, checks domain, cluster, wallet and time, verifies the
 *                        signature, THEN burns the nonce with one DELETE ... RETURNING, then upserts the
 *                        profile and refuses a banned one. A replayed signature finds no nonce.
 *
 * The text is the Sign-In-With-Solana layout, so a wallet that understands it can show the domain. The
 * nonce is burned after the signature check on purpose: a forged request must not be able to use up
 * somebody else's challenge. The cookie itself is session.ts.
 */
import bs58 from 'bs58';
import { ApiError, type Cluster } from '@/contracts';
import { configuredCluster } from './config';
import { verifySigned } from './ed25519';
import * as store from './store';

export const LOGIN_TTL_MS = 5 * 60_000;
/** How far ahead of our clock a signed "Issued At" may be (a phone with a fast clock). */
const SKEW_MS = 2 * 60_000;
const STATEMENT = 'Sign in to Hammerprice. This costs nothing and moves no funds.';

const HOST = '[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?';
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const ISO = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z';
const LOGIN_RE = new RegExp(
  `^(${HOST}) wants you to sign in with your Solana account:\\n(${B58}{32,44})\\n\\n${STATEMENT.replaceAll('.', '\\.')}\\n\\nURI: (https?)://(${HOST})\\nVersion: 1\\nChain ID: (devnet|mainnet-beta)\\nNonce: (${B58}{16,32})\\nIssued At: (${ISO})\\nExpiration Time: (${ISO})$`,
);

// A wallet compares the URI with the page's origin, and localhost is served over http: a local `next dev` must name http://localhost:3000, every other host https.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const uriScheme = (host: string): 'http' | 'https' => (LOCAL_HOST.test(host) ? 'http' : 'https');

export interface LoginFields { host: string; wallet: string; chain: Cluster; nonce: string; issuedAt: string; expiresAt: string }

export function buildLoginMessage(f: LoginFields): string {
  return [
    `${f.host} wants you to sign in with your Solana account:`,
    f.wallet,
    '',
    STATEMENT,
    '',
    `URI: ${uriScheme(f.host)}://${f.host}`,
    'Version: 1',
    `Chain ID: ${f.chain}`,
    `Nonce: ${f.nonce}`,
    `Issued At: ${f.issuedAt}`,
    `Expiration Time: ${f.expiresAt}`,
  ].join('\n');
}

const isInstant = (t: string): boolean => {
  const d = new Date(t);
  return !Number.isNaN(d.getTime()) && d.toISOString() === t;
};

/** Strict parse: one spelling only. The URI host must repeat the header host, and both times must be real ISO instants. */
export function parseLoginMessage(message: string): LoginFields | null {
  const m = LOGIN_RE.exec(message);
  if (!m || m[1] !== m[4] || m[3] !== uriScheme(m[1])) return null;
  if (!isInstant(m[7]) || !isInstant(m[8])) return null;
  return { host: m[1], wallet: m[2], chain: m[5] as Cluster, nonce: m[6], issuedAt: m[7], expiresAt: m[8] };
}

export interface Challenge { nonce: string; message: string; expiresAt: string }

export async function issueChallenge(input: { wallet: string; host: string; nowMs?: number; cluster?: Cluster }): Promise<Challenge> {
  const nowMs = input.nowMs ?? Date.now();
  const nonce = bs58.encode(crypto.getRandomValues(new Uint8Array(16)));
  const fields: LoginFields = {
    host: input.host,
    wallet: input.wallet,
    chain: input.cluster ?? configuredCluster(),
    nonce,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + LOGIN_TTL_MS).toISOString(),
  };
  await store.insertNonce(nonce, input.wallet, new Date(nowMs + LOGIN_TTL_MS), new Date(nowMs - 3_600_000));
  return { nonce, message: buildLoginMessage(fields), expiresAt: fields.expiresAt };
}

export interface LoginResult { wallet: string; profile: { id: string; isSeller: boolean; strikes: number } }

/** Throws ApiError: validation, wrong_domain, bad_signature, expired, nonce_used, banned. */
export async function completeLogin(input: {
  wallet: string;
  message: string;
  signature: string;
  /** From `loginHosts(req)`. */
  hosts: string[];
  nowMs?: number;
  cluster?: Cluster;
}): Promise<LoginResult> {
  const nowMs = input.nowMs ?? Date.now();
  const f = parseLoginMessage(input.message);
  if (!f) throw new ApiError('validation', 'Malformed sign-in message');
  const cluster = input.cluster ?? configuredCluster();
  if (f.chain !== cluster) throw new ApiError('validation', `Wrong cluster: this site uses ${cluster}`);
  if (!input.hosts.includes(f.host)) throw new ApiError('wrong_domain', 'The sign-in message names a different site');
  if (f.wallet !== input.wallet) throw new ApiError('bad_signature', 'The message was written for another wallet');
  const issued = Date.parse(f.issuedAt);
  const expires = Date.parse(f.expiresAt);
  if (expires <= nowMs) throw new ApiError('expired', 'The sign-in request has expired, start again');
  if (issued > nowMs + SKEW_MS || expires - issued > LOGIN_TTL_MS) throw new ApiError('bad_signature', 'The sign-in message has invalid times');
  if (!verifySigned(input.message, input.signature, f.wallet)) throw new ApiError('bad_signature', 'Signature does not match the message');
  if (!(await store.consumeNonce(f.nonce, f.wallet, new Date(nowMs)))) throw new ApiError('nonce_used', 'This sign-in request was already used or has expired');

  const profile = await store.upsertProfile(f.wallet);
  if (profile.isBanned) throw new ApiError('banned', 'This account is suspended');
  await store.audit('login', f.wallet, profile.id);
  return { wallet: f.wallet, profile: { id: profile.id, isSeller: profile.isSeller, strikes: profile.strikes } };
}
