/**
 * The two texts a wallet (or its paddle session key) signs to act in an auction, and their strict parsers.
 * Pure: no database, no clock of its own, browser and Edge safe, so the room builds the exact string the
 * server verifies.
 *
 *   BidIntentV1     "hammerprice bid v1"    one bid: cluster, show, lot, amount, bidder, paddle, nonce, issued
 *   PaddleAuthV1    "hammerprice paddle v1" one wallet signature that lets an ephemeral key bid in ONE show,
 *                                           up to `max`, until `valid`
 *
 * Each purpose has its own first line and its own field list, so a signature for one can never be read as
 * the other (nor as the login text, which starts with the host). The parsers accept exactly one spelling:
 * fixed order, one field per line, lowercase canonical uuids and numbers, printable ASCII, no trailing
 * newline. Anything else is null. The wallet signs the text bytes, so "parse, then compare the fields" is
 * the whole check and there is no second representation to disagree about.
 */
import type { BidRequest } from '@/contracts';
import type { ShowKind } from '@/contracts/common';
import { configuredCluster } from './config';
import { decodePubkey, verifySigned } from './ed25519';

/** A bid intent is fresh for this long either side of the server clock (clock skew plus a slow phone). */
export const INTENT_WINDOW_MS = 120_000;
/** A paddle session key may be authorised for at most this long (a live show). */
export const PADDLE_MAX_VALIDITY_MS = 6 * 3_600_000;
/** ... and in a timed show (one lot for hours or days), as long as the lot can run. */
export const PADDLE_MAX_VALIDITY_TIMED_MS = 7 * 86_400_000;

export const paddleMaxValidityMs = (kind: ShowKind | undefined): number => (kind === 'timed' ? PADDLE_MAX_VALIDITY_TIMED_MS : PADDLE_MAX_VALIDITY_MS);

/**
 * What is wrong with the validity of a paddle authorisation in a show of this kind, if anything: `too_long` (past the kind's maximum) or
 * `max_required` (it lasts longer than a live paddle could, and such a key must carry a maximum bid amount: the longer a key lives, the smaller what it can
 * ever sign has to be).
 */
export function paddleValidityIssue(kind: ShowKind | undefined, f: { valid: number; max: bigint | null }, nowMs: number): 'too_long' | 'max_required' | null {
  if (f.valid > nowMs + paddleMaxValidityMs(kind)) return 'too_long';
  if (f.valid > nowMs + PADDLE_MAX_VALIDITY_MS && f.max === null) return 'max_required';
  return null;
}

const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UINT = '(?:0|[1-9][0-9]{0,19})';
const CLUSTER = '(devnet|mainnet-beta)';
const MS = '([1-9][0-9]{12})';

const BID_RE = new RegExp(
  `^hammerprice bid v1\\ncluster: ${CLUSTER}\\nshow: (${UUID})\\nlot: (${UUID})\\namount: (${UINT})\\nbidder: (${B58})\\npaddle: (${UUID}|-)\\nnonce: ([0-9a-f]{16})\\nissued: ${MS}$`,
);
const PADDLE_RE = new RegExp(
  `^hammerprice paddle v1\\ncluster: ${CLUSTER}\\nshow: (${UUID})\\nwallet: (${B58})\\nsession: (${B58})\\nmax: (${UINT}|-)\\nvalid: ${MS}$`,
);

export interface BidIntentFields {
  cluster: string;
  show: string;
  lot: string;
  amount: string;
  bidder: string;
  paddle: string | null;
  nonce: string;
  issued: number;
}

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

/** Strict parse. null on any deviation, including a cluster other than the configured one. */
export function parseBidIntent(message: string, cluster: string = configuredCluster()): BidIntentFields | null {
  const m = BID_RE.exec(message);
  if (!m || m[1] !== cluster || !decodePubkey(m[5])) return null;
  return { cluster: m[1], show: m[2], lot: m[3], amount: m[4], bidder: m[5], paddle: m[6] === '-' ? null : m[6], nonce: m[7], issued: Number(m[8]) };
}

export interface VerifyBidIntentInput {
  request: BidRequest;
  showId: string;
  /** The wallet the caller is already established as (cookie session, or the paddle's owner), or null for a bare self-authenticating intent. */
  sessionWallet: string | null;
  /** The paddle's registered session key. Only used when `request.intent.signer` is 'session'. */
  paddleSessionPubkey: string | null;
  nowMs: number;
}

/**
 * Shape, binding and signature of one bid. Everything the signed text claims must equal what the request
 * says: show, lot and amount; the bidder must be the established wallet; the intent must be fresh.
 * 'wallet' is verified by the bidder's own key; 'session' by the paddle's key (and needs a paddle in the text).
 *
 * Not checked here, because the caller holds the rows: that `fields.paddle` is the paddle registered for
 * (show, bidder), that it is not revoked or expired and that the amount is within its `max` (see
 * `paddleAllows`), and nonce uniqueness (`bids_bidder_nonce_idx`).
 */
export function verifyBidIntent({ request, showId, sessionWallet, paddleSessionPubkey, nowMs }: VerifyBidIntentInput): boolean {
  const { message, signature, signer } = request.intent;
  const f = parseBidIntent(message);
  if (!f) return false;
  if (f.show !== showId.toLowerCase() || f.lot !== request.lotId.toLowerCase() || f.amount !== request.amount) return false;
  if (Math.abs(nowMs - f.issued) > INTENT_WINDOW_MS) return false;
  if (sessionWallet !== null && f.bidder !== sessionWallet) return false;
  if (signer === 'wallet') return verifySigned(message, signature, f.bidder);
  if (signer === 'session') return paddleSessionPubkey !== null && f.paddle !== null && verifySigned(message, signature, paddleSessionPubkey);
  return false;
}

export interface PaddleAuthFields {
  cluster: string;
  show: string;
  wallet: string;
  /** base58 ed25519 public key generated in the browser. */
  session: string;
  /** Ceiling in USDC base units the wallet signed for that key; null = the balance is the only limit. */
  max: bigint | null;
  /** Unix ms expiry. */
  valid: number;
}

export function buildPaddleAuth(f: PaddleAuthFields): string {
  return [
    'hammerprice paddle v1',
    `cluster: ${f.cluster}`,
    `show: ${f.show}`,
    `wallet: ${f.wallet}`,
    `session: ${f.session}`,
    `max: ${f.max === null ? '-' : f.max.toString()}`,
    `valid: ${f.valid}`,
  ].join('\n');
}

export function parsePaddleAuth(message: string, cluster: string = configuredCluster()): PaddleAuthFields | null {
  const m = PADDLE_RE.exec(message);
  if (!m || m[1] !== cluster || !decodePubkey(m[3]) || !decodePubkey(m[4])) return null;
  return { cluster: m[1], show: m[2], wallet: m[3], session: m[4], max: m[5] === '-' ? null : BigInt(m[5]), valid: Number(m[6]) };
}

/**
 * The wallet signed this paddle authorisation for this show, and it is still in force: not past, at most 6 h ahead in a live show (the default
 * when `kind` is absent), at most 7 days ahead in a timed show, and a maximum bid amount for anything past 6 h.
 */
export function verifyPaddleAuth(input: { message: string; signature: string; wallet: string; showId: string; nowMs: number; kind?: ShowKind }): boolean {
  const f = parsePaddleAuth(input.message);
  if (!f) return false;
  if (f.wallet !== input.wallet || f.show !== input.showId.toLowerCase()) return false;
  if (f.valid <= input.nowMs || paddleValidityIssue(input.kind, f, input.nowMs) !== null) return false;
  return verifySigned(input.message, input.signature, f.wallet);
}

/** A registered paddle may sign this bid through its session key: not revoked, not expired, amount within the signed ceiling. */
/** The `detail` of a `no_paddle` rejection that means "above the spending limit of this bidder number" (the person is ready; the amount is too high). */
export const PADDLE_LIMIT_DETAIL = 'paddle_limit';

export function paddleAllows(paddle: { validUntil: Date; maxBid: bigint | null; revokedAt: Date | null }, amount: bigint, nowMs: number): boolean {
  if (paddle.revokedAt !== null || paddle.validUntil.getTime() <= nowMs) return false;
  return paddle.maxBid === null || amount <= paddle.maxBid;
}
