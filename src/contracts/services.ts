/**
 * Signatures ENGINE and AUTH implement and LIVE, ROOM and CHAIN call. The lot closes automatically, so there is no hammer, no
 * accept-below-reserve and no operator override. Types only; the server-only implementations live in
 * src/server/auction/service.ts and src/lib/auth/**. CHAIN's interfaces are in chain.ts.
 *
 * Settlement rows are created by ENGINE inside the closing transaction (`closeDueLot`): "lot sold" and
 * "settlement exists" are atomic, and ENGINE never calls the chain.
 */
import type { BidRequest, CatalogueLot, CreateShowRequest, LiveSnapshot, ShowDetail, ShowSummary } from './api';
import type { AssetReadiness } from './chain';
import type { ErrorCode } from './errors';

export interface PlaceBidInput {
  lotId: string;
  amount: bigint;
  bidderProfileId: string;
  bidderWallet: string;
  paddleId: string | null;
  via: 'wallet' | 'session' | 'house';
  /** The signed intent text and signature, stored as-is so the hammer can be re-verified. */
  message: string;
  signature: string;
  nonce: string;
  /** USDC balance read BEFORE the transaction (no row lock spans a network call); commitments are read inside it. */
  fundsBalance: bigint;
  now?: Date;
}

export type PlaceBidResult =
  | { ok: true; bidId: string; belowReserve: boolean; closesAt: string; extended: boolean; live: LiveSnapshot }
  | { ok: false; code: ErrorCode; reason: string; minNext?: string };

export interface AdvanceResult { showId: string; wentLive: boolean; closed: number; opened: number; ended: boolean }

export interface ListShowsQuery { status?: 'scheduled' | 'live' | 'ended'; kind?: 'live' | 'timed'; house?: 'only' | 'exclude'; limit: number; cursor?: string }
export interface ShowList { shows: ShowSummary[]; nextCursor: string | null }

export interface Paddle { id: string; number: number; validUntil: string; revokedAt: string | null }

/** server/auction/service.ts. All server-only. */
export interface AuctionService {
  placeBid(input: PlaceBidInput): Promise<PlaceBidResult>;
  /** Idempotent and lazy: opens a due show, closes due lots, opens the next lot, ends the show. Cheap path is one indexed query. */
  advanceShow(showId: string, now?: Date): Promise<AdvanceResult>;
  sweep(now?: Date): Promise<{ advanced: number; expired: number }>;
  getLiveSnapshot(showId: string): Promise<LiveSnapshot | null>;
  getCatalogue(showId: string): Promise<ShowDetail | null>;
  listShows(query: ListShowsQuery): Promise<ShowList>;
  /** Show and lots in ONE transaction. `readiness` is keyed by mint and comes from CHAIN. */
  createShow(input: CreateShowRequest & { sellerProfileId: string; readiness: Record<string, AssetReadiness> }): Promise<ShowDetail>;
  /** Only `withdraw` and `extend`, and only while the lot has no bid (`wrong_state` otherwise). */
  controlLot(input: { lotId: string; actorProfileId: string; action: 'extend' | 'withdraw'; seconds?: number }): Promise<{ lot: CatalogueLot; live: LiveSnapshot }>;
  buyNow(input: { lotId: string; buyerProfileId: string; buyerWallet: string; amount: bigint; fundsBalance: bigint; message: string; signature: string; nonce: string }): Promise<{ settlementId: string }>;
  registerPaddle(input: { showId: string; profileId: string; sessionPubkey: string; maxBid: bigint | null; validUntil: Date; authMessage: string; authSignature: string }): Promise<Paddle>;
  /** Sum of the profile's leading high bids on other open lots plus gross of its awaiting_payment/submitted settlements. */
  commitmentsFor(profileId: string, excludeLotId?: string): Promise<bigint>;
}

export interface Session { wallet: string; profileId: string; issuedAt: number; expiresAt: number }

export interface BidIntentFields {
  cluster: string; show: string; lot: string; amount: string; bidder: string; paddle: string | null; nonce: string; issued: number;
}

/** lib/auth/**. `requireSession` throws ApiError('unauthenticated' | 'banned'). */
export interface AuthApi {
  getSession(req: Request): Promise<Session | null>;
  requireSession(req: Request): Promise<Session>;
  /** Strict parse of the fixed-order text; null on any deviation (extra line, reorder, non-ASCII). */
  parseBidIntent(message: string): BidIntentFields | null;
  verifyBidIntent(input: { request: BidRequest; showId: string; sessionWallet: string | null; paddleSessionPubkey: string | null; nowMs: number }): boolean;
  verifyPaddleAuth(input: { message: string; signature: string; wallet: string; showId: string; nowMs: number }): boolean;
  rateLimit(key: string, limit: number, windowS: number): Promise<{ ok: boolean; retryAfterS: number }>;
}
