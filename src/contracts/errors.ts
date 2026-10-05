/**
 * The one error shape every API route answers with: `{ ok: false, code, reason, ...extra }`.
 *
 * The co-sign settlement adds
 * `round_expired`, `not_party` and `counterparty_pending`; discretionary hammering is gone, so
 * `below_floor` is gone too. `nonce_used`, `expired`, `wrong_domain` and `show_ended` are named in the
 * route table and so belong in the list.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  // request and identity
  'validation', 'unauthenticated', 'bad_signature', 'replay', 'banned', 'forbidden', 'not_found', 'wrong_state',
  'nonce_used', 'expired', 'wrong_domain',
  // limits and dependencies
  'rate_limited', 'paused', 'balance_unavailable', 'rpc_unavailable',
  // bidding
  'insufficient_funds', 'show_not_live', 'show_ended', 'lot_not_open', 'lot_closed', 'bid_too_low', 'amount_too_large',
  'self_bid', 'already_high_bidder', 'no_paddle', 'not_buyable',
  // the seller's pause: bids are refused while the room is paused; a pause is limited per show
  'show_paused', 'pause_limit', 'pause_too_late',
  // selling
  'not_seller', 'not_owner', 'frozen', 'unsupported_standard', 'lots_not_ready', 'seller_not_allowed',
  // the card is already in a room, a sale or a pack pool (src/server/assets/listed.ts)
  'already_listed',
  // settlement
  'not_buyer', 'not_party', 'asset_not_ready', 'tx_mismatch', 'blockhash_expired', 'round_expired',
  'counterparty_pending', 'simulation_failed', 'insufficient_usdc',
  // devnet helpers
  'faucet_paused', 'mint_paused',
  // optional features (each behind FEATURE_<NAME>; a switched-off feature answers feature_off as if it did not exist)
  'feature_off', 'payment_required', 'ai_unavailable', 'ai_budget', 'vrf_pending', 'video_unavailable', 'muted',
  // cluster configuration (SOLANA_CLUSTER is the one switch; an incomplete or contradictory environment fails closed)
  'mainnet_config_incomplete', 'cluster_config_conflict',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** HTTP status per code. 400 validation, 401 identity, 402 payment required, 403 forbidden or banned, 404, 409 state conflict, 429, 503 dependency. */
export const ERROR_STATUS: Record<ErrorCode, 400 | 401 | 402 | 403 | 404 | 409 | 429 | 503> = {
  validation: 400, amount_too_large: 400, tx_mismatch: 400,
  unauthenticated: 401, bad_signature: 401, nonce_used: 401, expired: 401, wrong_domain: 401,
  banned: 403, forbidden: 403, self_bid: 403, no_paddle: 403, not_seller: 403, not_owner: 403, seller_not_allowed: 403,
  not_buyer: 403, not_party: 403,
  not_found: 404,
  replay: 409, wrong_state: 409, insufficient_funds: 409, show_not_live: 409, show_ended: 409, lot_not_open: 409,
  lot_closed: 409, bid_too_low: 409, already_high_bidder: 409, not_buyable: 409, frozen: 409, unsupported_standard: 409,
  lots_not_ready: 409, already_listed: 409, asset_not_ready: 409, blockhash_expired: 409, round_expired: 409, counterparty_pending: 409,
  simulation_failed: 409, insufficient_usdc: 409, show_paused: 409, pause_limit: 409, pause_too_late: 409,
  rate_limited: 429,
  paused: 503, balance_unavailable: 503, rpc_unavailable: 503, faucet_paused: 503, mint_paused: 503,
  // 402 is for a paid call without credit (AI listing); the body carries the payment terms (contracts/ai.ts PaymentRequiredBody).
  payment_required: 402, feature_off: 404, muted: 403, vrf_pending: 409, ai_budget: 429,
  ai_unavailable: 503, video_unavailable: 503, mainnet_config_incomplete: 503, cluster_config_conflict: 503,
};

/** `...extra` is open on purpose; the two extras callers rely on are typed. */
export const ErrorResponseSchema = z
  .object({
    ok: z.literal(false),
    code: ErrorCodeSchema,
    reason: z.string(),
    /** bid_too_low: the smallest amount that would be accepted now (USDC base units). */
    minNext: z.string().optional(),
    /** rate_limited: mirrors the Retry-After header. */
    retryAfterS: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/** Thrown by services and helpers; the route layer turns it into an ErrorResponse with `ERROR_STATUS[code]`. */
export class ApiError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, reason?: string, readonly extra: Record<string, unknown> = {}) {
    super(reason ?? code);
    this.name = 'ApiError';
    this.status = ERROR_STATUS[code];
  }
}

export function errorBody(code: ErrorCode, reason: string, extra: Record<string, unknown> = {}): ErrorResponse {
  return { ok: false, code, reason, ...extra };
}
