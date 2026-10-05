/**
 * The HTTP contract: zod schemas (source of truth), inferred types, and a route registry that mirrors
 * the route table below:
 *
 *   - No delegation routes. Consign is a readiness read (`POST /api/lots/:id/readiness`), nothing to sign.
 *   - Settlements are co-signed: `prepare`, `GET` status (lazy finalize), `POST sign {role, signedTxBase64}`.
 *   - The lot closes by itself: no `hammer`, `pass`, `acceptBelowReserve`; the seller may only
 *     `withdraw` or `extend` a lot while it has no bid.
 *
 * All request bodies are `.strict()`. Every amount is a decimal string of USDC base units. Every id
 * is a uuid. Errors use the one shape in errors.ts.
 */
import { z } from 'zod';
import type { ErrorCode } from './errors';
import {
  Amount, AuctionRulesInput, Cluster, ConsignStatus, IsoTime, LotDescription, LotPhase, LotState, NftStandard, OrderMode, PartyRole,
  Signature64, SettlementMode, SettlementStatus, ShowFormat, ShowKind, ShowMode, ShowStatus, TxSignature, Uuid, Wallet,
} from './common';
import { AssetReadiness, PreparedSettlement, ReadinessReason, SettlementView, SignInput, SignResult } from './chain';
import { SnapshotEvent } from './events';
import { PlaybackResponse, ShowVideo, VideoToggleRequest, VideoToggleResponse } from './stream';
import {
  ChatListResponse, ChatMineResponse, ChatModerateRequest, ChatModerateResponse, ChatPostRequest, ChatPostResponse, ChatQueueQuery, ChatQueueResponse,
  ChatReportRequest, ChatReportResponse,
} from './chat';
import {
  AiAgentRequest, AiAgentResponse, AiAskRequest, AiAskResponse, AiCreditsPayRequest, AiCreditsQuoteRequest, AiCreditsQuoteResponse, AiCreditsResponse, AiListingRequest, AiListingResponse, AiPurchaseView,
} from './ai';
import { ShowOrder, VrfAdvanceRequest, VrfKeyResponse, VrfRequestView, VrfShowResponse } from './vrf';
import {
  PackControlRequest, PackControlResponse, PackCreateRequest, PackDeliveriesResponse, PackDetailResponse, PackOperatorAccess, PackDrawView, PackDrawsQuery, PackDrawsResponse, PackOpenRequest, PackOpenResponse, PackPayment, PackSignResponse, PacksResponse,
} from './packs';
import { ProfileResponse, ProfileUpdateRequest, SummaryResponse, WalletResponse } from './profile';
import { TelegramLinkRequest, TelegramLinkResponse, TelegramStatusResponse, TelegramUpdateRequest, TelegramWebhookResponse } from './telegram';

// ---------------------------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------------------------

export const Profile = z.object({ id: Uuid, isSeller: z.boolean(), strikes: z.number().int().min(0) }).strict();

/** A signed bid intent (auth/intent.ts text). `signer: 'session'` means the paddle's session key signed it. */
export const BidIntent = z
  .object({ message: z.string().min(1).max(512), signature: Signature64, signer: z.enum(['wallet', 'session']) })
  .strict();

/** Catalogue row: what does not change during the auction (plus the seller's terms). */
export const CatalogueLot = z
  .object({
    id: Uuid,
    lotNumber: z.number().int().min(1),
    name: z.string(),
    setName: z.string().nullable(),
    gradingCompany: z.string().nullable(),
    grade: z.string().nullable(),
    imageUrl: z.string().nullable(),
    insuredValue: Amount.nullable(),
    reserve: Amount.nullable(),
    increment: Amount,
    openingPrice: Amount,
    buyNowPrice: Amount.nullable(),
    mintAddress: Wallet,
    nftStandard: NftStandard,
    consignStatus: ConsignStatus,
    /** The seller's text per language; null = none. Defaults keep older fixtures and rows valid. */
    description: LotDescription.nullable().default(null),
    /** The seller adopted text from an AI draft (reviewed). The room says so next to the description. */
    aiAssisted: z.boolean().default(false),
  })
  .strict();

export const ShowCore = z
  .object({
    id: Uuid,
    title: z.string(),
    format: ShowFormat,
    mode: ShowMode,
    status: ShowStatus,
    scheduledAt: IsoTime.nullable(),
    startedAt: IsoTime.nullable(),
    endedAt: IsoTime.nullable(),
    settlementMode: SettlementMode,
    cluster: Cluster.nullable(),
    isHouse: z.boolean(),
    kind: ShowKind.default('live'),
    orderMode: OrderMode.default('catalogue'),
    /** Seconds each lot runs before any late-bid extension (the resolved rule: 45 unless the seller chose another length). Default keeps older fixtures valid. */
    lotDurationS: z.number().int().min(10).max(1_209_600).default(45),
    /** The seller's display name when they set one; null otherwise and always null on the house show. Only the catalogue read fills it. */
    sellerName: z.string().max(40).nullable().default(null),
    /** `enabled` = the seller's choice AND FEATURE_VIDEO; never a host, a path or a URL. */
    video: ShowVideo.default({ enabled: false }),
  })
  .strict();

/**
 * The seller's pause, as the room sees it. `paused`: bids are refused and the open lot's clock is frozen at
 * `closesAt - pausedAt`; the pause ends by itself at `resumesBy`. `used` of `max` pauses are spent. Defaults keep older fixtures valid.
 */
export const ShowPause = z
  .object({ paused: z.boolean(), pausedAt: IsoTime.nullable(), resumesBy: IsoTime.nullable(), used: z.number().int().min(0), max: z.number().int().min(0) })
  .strict();
export type ShowPause = z.infer<typeof ShowPause>;
export const NO_PAUSE: ShowPause = { paused: false, pausedAt: null, resumesBy: null, used: 0, max: 2 };

export const ShowSummary = z
  .object({
    id: Uuid,
    title: z.string(),
    status: ShowStatus,
    scheduledAt: IsoTime.nullable(),
    startedAt: IsoTime.nullable(),
    endedAt: IsoTime.nullable(),
    lotCount: z.number().int().min(0),
    soldCount: z.number().int().min(0),
    hammerTotal: Amount,
    cluster: Cluster.nullable(),
    isHouse: z.boolean(),
    thumbs: z.array(z.string()).max(4),
    kind: ShowKind.default('live'),
    /** Deadline of the lot on the block (a timed show's "ends in"); null or absent when no lot is open. */
    closesAt: IsoTime.nullable().optional(),
  })
  .strict();

export const ShowDetail = z.object({ show: ShowCore, lots: z.array(CatalogueLot) }).strict();

/** `GET /api/auctions/:id/live`: only what changes; identical for every viewer (CDN-cacheable for 1 s). */
export const LiveSnapshot = z
  .object({
    v: z.literal(1),
    /** ms epoch from the database clock; the client derives its offset from it and never decides a deadline itself. */
    serverNow: z.number().int().nonnegative(),
    show: z
      .object({
        id: Uuid,
        title: z.string(),
        status: ShowStatus,
        mode: ShowMode,
        scheduledAt: IsoTime.nullable(),
        settlementMode: SettlementMode,
        cluster: z.string().nullable(),
        isHouse: z.boolean(),
        kind: ShowKind.default('live'),
        /** How the lots are ordered and, for a drawn order, where the proof stands (the fairness chip needs no extra request). */
        order: ShowOrder.default({ mode: 'catalogue' }),
        video: ShowVideo.default({ enabled: false }),
        /** The seller's pause. While `paused`, `current.phase` is drawn at the moment of the pause and the countdown is frozen. */
        pause: ShowPause.default(NO_PAUSE),
      })
      .strict(),
    current: z
      .object({
        lotId: Uuid,
        lotNumber: z.number().int().min(1),
        phase: LotPhase,
        closesAt: IsoTime.nullable(),
        nextOpensAt: IsoTime.nullable(),
      })
      .strict()
      .nullable(),
    lots: z.array(
      z
        .object({
          id: Uuid,
          lotNumber: z.number().int().min(1),
          state: LotState,
          highBid: Amount.nullable(),
          highBidder: z.object({ paddle: z.number().int().min(1).nullable() }).strict().nullable(),
          bidCount: z.number().int().min(0),
          closesAt: IsoTime.nullable(),
          settlement: z.object({ id: Uuid, status: SettlementStatus, txSignature: TxSignature.optional() }).strict().optional(),
        })
        .strict(),
    ),
    /** The last 40 events, ascending by id. */
    events: z.array(SnapshotEvent).max(40),
    lastEventId: z.number().int().nonnegative(),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Auth and identity (AUTH)
// ---------------------------------------------------------------------------------------------

export const AuthChallengeRequest = z.object({ wallet: Wallet }).strict();
export const AuthChallengeResponse = z.object({ nonce: z.string().min(8).max(64), message: z.string().max(1024), expiresAt: IsoTime }).strict();
export const AuthVerifyRequest = z.object({ wallet: Wallet, message: z.string().min(1).max(1024), signature: Signature64 }).strict();
export const AuthVerifyResponse = z.object({ wallet: Wallet, profile: Profile }).strict();

export const MeQuery = z.object({ show: Uuid.optional() }).strict();
export const MeResponse = z
  .object({
    wallet: Wallet,
    profile: Profile,
    /** null when the RPC cannot answer; this route never fails because of it. */
    funds: z.object({ usdc: Amount.nullable() }).strict(),
    paddle: z.object({ number: z.number().int().min(1), validUntil: IsoTime, funded: z.boolean() }).strict().optional(),
    standing: z.object({ lotId: Uuid, status: z.enum(['leading', 'outbid']) }).strict().optional(),
    /** Settlements waiting on this wallet's signature or payment: the account page "settlement desk". */
    pending: z.array(
      z.object({ settlementId: Uuid, lotId: Uuid, showId: Uuid, role: PartyRole, status: SettlementStatus, dueAt: IsoTime, gross: Amount, buyerSigned: z.boolean().optional() }).strict(),
    ),
  })
  .strict();

export const ActivityQuery = z
  .object({ tab: z.enum(['bids', 'wins', 'consignments']), cursor: z.string().max(200).optional() })
  .strict();
export const ActivityResponse = z.discriminatedUnion('tab', [
  z.object({
    tab: z.literal('bids'),
    /** `result`: leading or outbid while the lot is open; won, lost or ended (no sale) once it closed. */
    items: z.array(z.object({ bidId: Uuid, lotId: Uuid, lotName: z.string(), amount: Amount, placedAt: IsoTime, leading: z.boolean(), closesAt: IsoTime.nullable(), lotState: LotState, result: z.enum(['leading', 'outbid', 'won', 'lost', 'ended']) }).strict()),
    nextCursor: z.string().nullable(),
  }).strict(),
  z.object({
    tab: z.literal('wins'),
    items: z.array(z.object({ lotId: Uuid, lotName: z.string(), gross: Amount, settlementId: Uuid, status: SettlementStatus, explorerUrl: z.string().nullable() }).strict()),
    nextCursor: z.string().nullable(),
  }).strict(),
  z.object({
    tab: z.literal('consignments'),
    items: z.array(z.object({ lotId: Uuid, lotName: z.string(), mint: Wallet, state: LotState, consign: ConsignStatus }).strict()),
    nextCursor: z.string().nullable(),
  }).strict(),
]);

export const PaddlesResponse = z
  .object({
    paddles: z.array(z.object({ showId: Uuid, showTitle: z.string(), number: z.number().int().min(1), validUntil: IsoTime, funded: z.boolean() }).strict()),
  })
  .strict();


/** `GET /api/lots/:id/bids`: the audit data behind /verify/[lotId]. Public: every bid's signed text, its signature and the key that made it. */
export const LotBidsResponse = z
  .object({
    /** `isHouse`: the lot belongs to the house (demo) room; absent from older answers. */
    lot: z.object({ id: Uuid, number: z.number().int().min(1), name: z.string(), showId: Uuid, isHouse: z.boolean().optional() }).strict(),
    bids: z.array(
      z
        .object({
          id: Uuid,
          amount: Amount,
          placedAt: IsoTime,
          paddle: z.number().int().min(1).nullable(),
          message: z.string(),
          signature: z.string(),
          signer: z.enum(['wallet', 'session']),
          /** base58: the bidder wallet, or the paddle session key that signed. */
          signerPubkey: Wallet,
        })
        .strict(),
    ),
    /** Null when the lot has no settlement (unsold, practice, house stock). */
    settlement: z.object({ id: Uuid, bidLogHash: z.string().regex(/^[0-9a-f]{64}$/), txSignature: z.string().nullable(), cluster: Cluster.nullable() }).strict().nullable(),
  })
  .strict();

export const PaddleRequest = z
  .object({ message: z.string().min(1).max(512), signature: Signature64, sessionPubkey: Wallet.optional(), maxBid: Amount.optional() })
  .strict();
export const PaddleResponse = z.object({ paddleId: Uuid, number: z.number().int().min(1), validUntil: IsoTime }).strict();

// ---------------------------------------------------------------------------------------------
// Shows, lots and bids (LIVE)
// ---------------------------------------------------------------------------------------------

export const ShowsQuery = z
  .object({
    status: ShowStatus.optional(),
    kind: ShowKind.optional(),
    /** 'only' = the house's demo shows (live room, timed auctions), 'exclude' = rooms made by sellers. Absent: both, the demo room pinned first. */
    house: z.enum(['only', 'exclude']).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export const ShowListResponse = z.object({ shows: z.array(ShowSummary), nextCursor: z.string().nullable() }).strict();

const LotTerms = z.object({ reserve: Amount, openingPrice: Amount, increment: Amount, buyNowPrice: Amount }).partial();

export const CreateShowRequest = z
  .object({
    title: z.string().trim().min(3).max(80).regex(/^[\p{L}\p{N} .,:;!?'"&()#+/-]+$/u, 'unsupported characters'),
    format: ShowFormat.default('auction'),
    /** Only 'auto': the lot closes when `closes_at` passes. */
    mode: z.literal('auto').default('auto'),
    scheduledAt: IsoTime.optional(),
    rules: AuctionRulesInput.optional(),
    /** 'timed' needs FEATURE_TIMED and exactly one lot (checked by the service). */
    kind: ShowKind.default('live'),
    /** The seller ticks the optional live video. Only effective while FEATURE_VIDEO is on. */
    videoEnabled: z.boolean().default(false),
    lots: z.array(LotTerms.extend({ mint: Wallet, description: LotDescription.optional(), aiAssisted: z.boolean().optional() }).strict()).min(1).max(30),
  })
  .strict();

export const ShowResponse = z.object({ show: ShowCore }).strict();

export const PatchLotRequest = LotTerms.strict().refine((b) => Object.keys(b).length > 0, 'at least one field');
export const LotResponse = z.object({ lot: CatalogueLot }).strict();

/** The seller may only withdraw or extend a lot that has no bid yet (`wrong_state` otherwise). */
export const LotControlRequest = z
  .object({ action: z.enum(['extend', 'withdraw']), seconds: z.number().int().min(1).max(3600).optional() })
  .strict();
export const LotControlResponse = z.object({ lot: CatalogueLot, live: LiveSnapshot }).strict();

export const BidRequest = z.object({ lotId: Uuid, amount: Amount, intent: BidIntent }).strict();
export const BidResponse = z
  .object({ ok: z.literal(true), bidId: Uuid, amount: Amount, belowReserve: z.boolean(), closesAt: IsoTime, extended: z.boolean(), live: LiveSnapshot })
  .strict();

/** The lot comes from the path; `amount` must equal the lot's buy-now price. */
export const BuyNowRequest = z.object({ amount: Amount, intent: BidIntent }).strict();
export const BuyNowResponse = z.object({ ok: z.literal(true), settlementId: Uuid }).strict();

export const StatusSettlementsQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
export const StatusSettlementsResponse = z
  .object({ items: z.array(z.object({ at: IsoTime, lotName: z.string(), amount: Amount, txSignature: TxSignature, explorerUrl: z.string().url() }).strict()) })
  .strict();

export const SweepResponse = z.object({ advanced: z.number().int().min(0), expired: z.number().int().min(0), finalized: z.number().int().min(0) }).strict();
export const HealthResponse = z
  .object({
    ok: z.literal(true),
    db: z.object({ ms: z.number().nonnegative() }).strict(),
    rpc: z.object({ ms: z.number().nonnegative() }).strict(),
    cluster: Cluster,
    /** Settlement authority SOL balance (fee and rent budget); null when unreadable. */
    sa: z.object({ sol: z.number().nonnegative().nullable() }).strict(),
    /** Kill switches by key; the optional features (vrf, timed, video, ai, chat, packs) show their EFFECTIVE state (FEATURE_<NAME> on AND the row not false). */
    flags: z.record(z.boolean()),
  })
  .strict();

/**
 * `GET /api/health` when the cluster configuration is incomplete or contradicts itself (SOLANA_CLUSTER=mainnet-beta without its RPC,
 * keys or fee wallet, or a devnet value on mainnet and the other way round): status 503, and the money routes answer 503 as well.
 * `missing` and `conflicts` hold environment variable NAMES only, never a value.
 */
export const HealthConfigErrorResponse = z
  .object({
    ok: z.literal(false),
    code: z.enum(['mainnet_config_incomplete', 'cluster_config_conflict']),
    reason: z.string(),
    /** null when the cluster variables themselves are unusable. */
    cluster: Cluster.nullable(),
    missing: z.array(z.string()),
    conflicts: z.array(z.string()),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Sell, settlement and devnet helpers (CHAIN)
// ---------------------------------------------------------------------------------------------

export const SellAssetsQuery = z.object({ cluster: Cluster.optional() }).strict();
export const SellAsset = z
  .object({
    mint: Wallet,
    name: z.string(),
    imageUrl: z.string().nullable(),
    grade: z.string().nullable(),
    standard: NftStandard,
    eligible: z.boolean(),
    reasons: z.array(ReadinessReason),
    consign: ConsignStatus,
    /** Where the card is offered right now (a room or a pack), or null when it is free. Such a card cannot be offered again. */
    listed: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('lot'), showId: z.string().uuid().nullable() }).strict(),
      z.object({ kind: z.literal('pack'), packId: z.string().uuid() }).strict(),
    ]).nullable().optional(),
  })
  .strict();
export const SellAssetsResponse = z.object({ assets: z.array(SellAsset) }).strict();

export const ReadinessRequest = z.object({}).strict();
export const ReadinessResponse = z.object({ ok: z.literal(true), readiness: AssetReadiness, consign: ConsignStatus }).strict();

export const PrepareRequest = z.object({}).strict();

export const FaucetRequest = z.object({}).strict();
export const FaucetResponse = z.object({ mint: Wallet, amount: Amount, signature: TxSignature }).strict();
export const MintCardRequest = z.object({ template: z.string().min(1).max(40).optional() }).strict();
export const MintCardResponse = z.object({ mint: Wallet, name: z.string(), signature: TxSignature }).strict();
/** Metaplex token metadata JSON served for devnet replicas. */
export const DevnetMetadata = z
  .object({
    name: z.string(),
    symbol: z.string(),
    image: z.string(),
    description: z.string().optional(),
    attributes: z.array(z.object({ trait_type: z.string(), value: z.union([z.string(), z.number()]) }).strict()),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Route registry
// ---------------------------------------------------------------------------------------------

/** `webhook`: not a browser call; the caller proves itself with a shared secret header (Telegram's X-Telegram-Bot-Api-Secret-Token). */
export type AuthMode = 'none' | 'session' | 'session_optional' | 'nonce' | 'cron' | 'webhook';
export type Agent = 'AUTH' | 'LIVE' | 'CHAIN' | 'VRF' | 'VIDEO' | 'AI' | 'TIMED' | 'CHAT' | 'PACKS' | 'TELEGRAM';
export interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** `:id` style params; every id is checked with isValidUuid before any query. */
  path: string;
  auth: AuthMode;
  /** The feature package that owns the route. */
  agent: Agent;
  /** `none` = `Cache-Control: no-store`. `{ cdnS }` = `Vercel-CDN-Cache-Control: max-age=<cdnS>` (the browser still gets no-store). */
  cache: 'none' | { cdnS: number };
  status: 200 | 201 | 204;
  /** Only on `session_optional` reads: answered with this status and no body when there is no session (never 401), so an anonymous visitor's console stays clean. */
  anonymousStatus?: 204;
  query?: z.ZodTypeAny;
  request?: z.ZodTypeAny;
  /** A body that is not JSON (WHIP signaling): the content type of the request and/or response. `response` is null then, and `request` may be omitted. */
  raw?: { request?: 'application/sdp'; response?: 'application/sdp' };
  /** null for 204 and for a raw (non-JSON) response. */
  response: z.ZodTypeAny | null;
  /** Notable errors beyond validation, unauthenticated, banned and rate_limited. */
  errors: readonly ErrorCode[];
  /** DB-backed fixed-window limit, for documentation and the rate-limit test. */
  limit?: string;
}

const R = <T extends Record<string, RouteDef>>(routes: T) => routes;

export const ROUTES = R({
  authChallenge: { method: 'POST', path: '/api/auth/challenge', auth: 'none', agent: 'AUTH', cache: 'none', status: 200, request: AuthChallengeRequest, response: AuthChallengeResponse, errors: ['rate_limited'], limit: '10/min/IP' },
  authVerify: { method: 'POST', path: '/api/auth/verify', auth: 'nonce', agent: 'AUTH', cache: 'none', status: 200, request: AuthVerifyRequest, response: AuthVerifyResponse, errors: ['bad_signature', 'nonce_used', 'expired', 'wrong_domain', 'banned'], limit: '10/min/IP' },
  authLogout: { method: 'POST', path: '/api/auth/logout', auth: 'session', agent: 'AUTH', cache: 'none', status: 204, response: null, errors: [] },
  me: { method: 'GET', path: '/api/me', auth: 'session_optional', agent: 'AUTH', cache: 'none', status: 200, anonymousStatus: 204, query: MeQuery, response: MeResponse, errors: [] },
  meActivity: { method: 'GET', path: '/api/me/activity', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, query: ActivityQuery, response: ActivityResponse, errors: [] },
  meProfile: { method: 'GET', path: '/api/me/profile', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, response: ProfileResponse, errors: [], limit: '60/min per wallet, failOpen' },
  meProfileUpdate: { method: 'PATCH', path: '/api/me/profile', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, request: ProfileUpdateRequest, response: ProfileResponse, errors: ['validation', 'rate_limited'], limit: '10/h per wallet' },
  mePaddles: { method: 'GET', path: '/api/me/paddles', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, response: PaddlesResponse, errors: [] },
  meShows: { method: 'GET', path: '/api/me/shows', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, query: ShowsQuery, response: ShowListResponse, errors: [] },
  paddleRegister: { method: 'POST', path: '/api/shows/:id/paddle', auth: 'session', agent: 'AUTH', cache: 'none', status: 201, request: PaddleRequest, response: PaddleResponse, errors: ['insufficient_funds', 'show_ended', 'bad_signature', 'balance_unavailable', 'mainnet_config_incomplete', 'cluster_config_conflict'], limit: '5/min' },
  paddleRelease: { method: 'DELETE', path: '/api/shows/:id/paddle', auth: 'session', agent: 'AUTH', cache: 'none', status: 204, response: null, errors: [] },

  lotBids: { method: 'GET', path: '/api/lots/:id/bids', auth: 'none', agent: 'LIVE', cache: { cdnS: 5 }, status: 200, response: LotBidsResponse, errors: ['not_found'] },
  showsList: { method: 'GET', path: '/api/shows', auth: 'none', agent: 'LIVE', cache: { cdnS: 5 }, status: 200, query: ShowsQuery, response: ShowListResponse, errors: [] },
  showsCreate: { method: 'POST', path: '/api/shows', auth: 'session', agent: 'LIVE', cache: 'none', status: 201, request: CreateShowRequest, response: ShowDetail, errors: ['not_owner', 'unsupported_standard', 'frozen', 'asset_not_ready', 'already_listed', 'seller_not_allowed', 'mainnet_config_incomplete', 'cluster_config_conflict'], limit: '3/day/wallet' },
  showsGet: { method: 'GET', path: '/api/shows/:id', auth: 'none', agent: 'LIVE', cache: { cdnS: 10 }, status: 200, response: ShowDetail, errors: ['not_found'] },
  showGoLive: { method: 'POST', path: '/api/shows/:id/go-live', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, response: ShowResponse, errors: ['not_seller', 'lots_not_ready', 'wrong_state'] },
  showEnd: { method: 'POST', path: '/api/shows/:id/end', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, response: ShowResponse, errors: ['not_seller', 'wrong_state'] },
  showPause: { method: 'POST', path: '/api/shows/:id/pause', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, response: ShowResponse, errors: ['not_seller', 'wrong_state', 'show_paused', 'pause_limit', 'pause_too_late', 'lot_not_open'], limit: '2 pauses per show, each at most 5 minutes, not in the last 10 s of a lot' },
  meAvatarSet: { method: 'POST', path: '/api/me/avatar', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, response: ProfileResponse, errors: ['validation', 'rate_limited'], limit: '10/h per wallet; a raw png, jpeg or webp body of at most 200 KB (not JSON)' },
  meAvatarClear: { method: 'DELETE', path: '/api/me/avatar', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, response: ProfileResponse, errors: ['rate_limited'], limit: '10/h per wallet' },
  meWallet: { method: 'GET', path: '/api/me/wallet', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, response: WalletResponse, errors: [], limit: '30/min per wallet, failOpen' },
  meSummary: { method: 'GET', path: '/api/me/summary', auth: 'session', agent: 'AUTH', cache: 'none', status: 200, response: SummaryResponse, errors: [], limit: '30/min per wallet, failOpen' },
  showResume: { method: 'POST', path: '/api/shows/:id/resume', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, response: ShowResponse, errors: ['not_seller', 'wrong_state'] },
  showCancel: { method: 'POST', path: '/api/shows/:id/cancel', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, response: ShowResponse, errors: ['not_seller', 'wrong_state'] },
  auctionLive: { method: 'GET', path: '/api/auctions/:id/live', auth: 'none', agent: 'LIVE', cache: { cdnS: 1 }, status: 200, response: LiveSnapshot, errors: ['not_found'] },
  bidsPlace: { method: 'POST', path: '/api/bids', auth: 'session_optional', agent: 'LIVE', cache: 'none', status: 200, request: BidRequest, response: BidResponse, errors: ['show_not_live', 'show_paused', 'lot_not_open', 'lot_closed', 'bid_too_low', 'amount_too_large', 'insufficient_funds', 'self_bid', 'already_high_bidder', 'no_paddle', 'bad_signature', 'replay', 'balance_unavailable', 'mainnet_config_incomplete', 'cluster_config_conflict'], limit: '1 per 2 s per wallet, 60/min/IP' },
  lotPatch: { method: 'PATCH', path: '/api/lots/:id', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, request: PatchLotRequest, response: LotResponse, errors: ['not_seller', 'wrong_state'] },
  lotControl: { method: 'POST', path: '/api/lots/:id/control', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, request: LotControlRequest, response: LotControlResponse, errors: ['not_seller', 'wrong_state', 'show_paused'] },
  lotBuyNow: { method: 'POST', path: '/api/lots/:id/buy-now', auth: 'session', agent: 'LIVE', cache: 'none', status: 200, request: BuyNowRequest, response: BuyNowResponse, errors: ['not_buyable', 'show_paused', 'lot_not_open', 'lot_closed', 'insufficient_funds', 'self_bid', 'no_paddle', 'bad_signature', 'replay', 'balance_unavailable', 'mainnet_config_incomplete', 'cluster_config_conflict'] },
  statusSettlements: { method: 'GET', path: '/api/status/settlements', auth: 'none', agent: 'LIVE', cache: { cdnS: 15 }, status: 200, query: StatusSettlementsQuery, response: StatusSettlementsResponse, errors: [] },
  cronSweep: { method: 'GET', path: '/api/cron/sweep', auth: 'cron', agent: 'LIVE', cache: 'none', status: 200, response: SweepResponse, errors: ['unauthenticated'] },
  health: { method: 'GET', path: '/api/health', auth: 'none', agent: 'LIVE', cache: 'none', status: 200, response: HealthResponse, errors: ['rpc_unavailable', 'mainnet_config_incomplete', 'cluster_config_conflict'] },

  sellAssets: { method: 'GET', path: '/api/sell/assets', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, query: SellAssetsQuery, response: SellAssetsResponse, errors: ['rpc_unavailable'] },
  lotReadiness: { method: 'POST', path: '/api/lots/:id/readiness', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, request: ReadinessRequest, response: ReadinessResponse, errors: ['not_seller', 'not_owner', 'frozen', 'unsupported_standard', 'rpc_unavailable'] },
  settlementGet: { method: 'GET', path: '/api/settlements/:id', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, response: SettlementView, errors: ['not_found', 'not_party'] },
  settlementPrepare: { method: 'POST', path: '/api/settlements/:id/prepare', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, request: PrepareRequest, response: PreparedSettlement, errors: ['not_party', 'wrong_state', 'insufficient_usdc', 'asset_not_ready', 'balance_unavailable', 'rpc_unavailable', 'mainnet_config_incomplete', 'cluster_config_conflict'], limit: '6/min' },
  settlementSign: { method: 'POST', path: '/api/settlements/:id/sign', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, request: SignInput, response: SignResult, errors: ['not_party', 'wrong_state', 'tx_mismatch', 'bad_signature', 'round_expired', 'blockhash_expired', 'counterparty_pending', 'simulation_failed', 'rpc_unavailable', 'mainnet_config_incomplete', 'cluster_config_conflict'] },
  devnetFaucet: { method: 'POST', path: '/api/devnet/faucet', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, request: FaucetRequest, response: FaucetResponse, errors: ['faucet_paused', 'rpc_unavailable'], limit: '1/24h/wallet, 3/24h/IP (404 outside devnet)' },
  devnetMintCard: { method: 'POST', path: '/api/devnet/mint-card', auth: 'session', agent: 'CHAIN', cache: 'none', status: 200, request: MintCardRequest, response: MintCardResponse, errors: ['mint_paused', 'rpc_unavailable'], limit: '3/day/wallet (404 outside devnet)' },
  devnetMetadata: { method: 'GET', path: '/api/devnet/metadata/:mint', auth: 'none', agent: 'CHAIN', cache: { cdnS: 3600 }, status: 200, response: DevnetMetadata, errors: ['not_found'] },

  // ---- optional features: each answers feature_off (404) while FEATURE_<NAME> is off ----------------------------------------
  vrfKey: { method: 'GET', path: '/api/vrf/key', auth: 'none', agent: 'VRF', cache: { cdnS: 60 }, status: 200, response: VrfKeyResponse, errors: ['feature_off'], limit: 'failOpen read limit' },
  vrfRequest: { method: 'GET', path: '/api/vrf/requests/:id', auth: 'none', agent: 'VRF', cache: { cdnS: 5 }, status: 200, response: VrfRequestView, errors: ['feature_off', 'not_found'], limit: 'failOpen read limit' },
  vrfShow: { method: 'GET', path: '/api/vrf/shows/:id', auth: 'none', agent: 'VRF', cache: { cdnS: 3 }, status: 200, response: VrfShowResponse, errors: ['feature_off'], limit: 'failOpen read limit' },
  vrfAdvance: { method: 'POST', path: '/api/vrf/requests/:id/advance', auth: 'none', agent: 'VRF', cache: 'none', status: 200, request: VrfAdvanceRequest, response: VrfRequestView, errors: ['feature_off', 'not_found', 'rpc_unavailable', 'mainnet_config_incomplete'], limit: '20/min/IP' },

  streamPlayback: { method: 'GET', path: '/api/streams/:showId/playback', auth: 'none', agent: 'VIDEO', cache: { cdnS: 3 }, status: 200, response: PlaybackResponse, errors: ['not_found'] },
  streamWhip: { method: 'POST', path: '/api/streams/:showId/whip', auth: 'session', agent: 'VIDEO', cache: 'none', status: 201, raw: { request: 'application/sdp', response: 'application/sdp' }, response: null, errors: ['feature_off', 'not_seller', 'wrong_state', 'video_unavailable', 'validation'], limit: '6/min/wallet, 30/min/IP' },
  streamWhipStop: { method: 'DELETE', path: '/api/streams/:showId/whip/:sessionId', auth: 'session', agent: 'VIDEO', cache: 'none', status: 204, response: null, errors: ['feature_off', 'not_seller', 'video_unavailable'] },
  showVideo: { method: 'POST', path: '/api/shows/:id/video', auth: 'session', agent: 'VIDEO', cache: 'none', status: 200, request: VideoToggleRequest, response: VideoToggleResponse, errors: ['feature_off', 'not_seller', 'wrong_state', 'video_unavailable'], limit: '10/h/wallet' },

  chatList: { method: 'GET', path: '/api/shows/:id/chat', auth: 'none', agent: 'CHAT', cache: { cdnS: 1 }, status: 200, response: ChatListResponse, errors: ['not_found'], limit: '120/min/IP, failOpen' },
  chatPost: { method: 'POST', path: '/api/shows/:id/chat', auth: 'session', agent: 'CHAT', cache: 'none', status: 201, request: ChatPostRequest, response: ChatPostResponse, errors: ['feature_off', 'no_paddle', 'muted', 'show_ended', 'validation'], limit: '1 per 3 s and 12/min per wallet, 40/min/IP' },
  chatMine: { method: 'GET', path: '/api/shows/:id/chat/mine', auth: 'session', agent: 'CHAT', cache: 'none', status: 200, response: ChatMineResponse, errors: ['feature_off'], limit: 'one poll per 5 s per wallet' },
  chatQueue: { method: 'GET', path: '/api/shows/:id/chat/queue', auth: 'session', agent: 'CHAT', cache: 'none', status: 200, query: ChatQueueQuery, response: ChatQueueResponse, errors: ['feature_off', 'not_seller', 'not_found'], limit: 'operator only (the show owner, or an operator wallet for the house show)' },
  chatModerate: { method: 'POST', path: '/api/shows/:id/chat/moderate', auth: 'session', agent: 'CHAT', cache: 'none', status: 200, request: ChatModerateRequest, response: ChatModerateResponse, errors: ['feature_off', 'not_seller', 'not_found', 'validation'], limit: 'operator only' },
  chatReport: { method: 'POST', path: '/api/chat/:id/report', auth: 'session', agent: 'CHAT', cache: 'none', status: 201, request: ChatReportRequest, response: ChatReportResponse, errors: ['feature_off', 'not_found'], limit: '5/h' },

  aiCredits: { method: 'GET', path: '/api/ai/credits', auth: 'session', agent: 'AI', cache: 'none', status: 200, response: AiCreditsResponse, errors: ['feature_off'] },
  aiCreditsQuote: { method: 'POST', path: '/api/ai/credits/quote', auth: 'session', agent: 'AI', cache: 'none', status: 200, request: AiCreditsQuoteRequest, response: AiCreditsQuoteResponse, errors: ['feature_off', 'rate_limited', 'rpc_unavailable', 'mainnet_config_incomplete'], limit: '6/min' },
  aiCreditsPay: { method: 'POST', path: '/api/ai/credits/pay', auth: 'session', agent: 'AI', cache: 'none', status: 200, request: AiCreditsPayRequest, response: AiPurchaseView, errors: ['feature_off', 'tx_mismatch', 'round_expired', 'blockhash_expired', 'simulation_failed', 'rpc_unavailable', 'mainnet_config_incomplete'] },
  aiCreditsPurchase: { method: 'GET', path: '/api/ai/credits/purchases/:id', auth: 'session', agent: 'AI', cache: 'none', status: 200, response: AiPurchaseView, errors: ['feature_off', 'not_found', 'rpc_unavailable'] },
  aiListing: { method: 'POST', path: '/api/ai/listing', auth: 'session', agent: 'AI', cache: 'none', status: 200, request: AiListingRequest, response: AiListingResponse, errors: ['feature_off', 'payment_required', 'ai_unavailable', 'ai_budget', 'rate_limited', 'validation'], limit: '3/min and 30/day per wallet, 20/day per IP' },
  aiAsk: { method: 'POST', path: '/api/ai/ask', auth: 'session', agent: 'AI', cache: 'none', status: 200, request: AiAskRequest, response: AiAskResponse, errors: ['feature_off', 'unauthenticated', 'banned', 'ai_budget', 'rate_limited', 'validation'], limit: '6/min per wallet, 40/day per IP' },
  aiAgent: { method: 'POST', path: '/api/ai/agent', auth: 'session', agent: 'AI', cache: 'none', status: 200, request: AiAgentRequest, response: AiAgentResponse, errors: ['feature_off', 'unauthenticated', 'banned', 'ai_budget', 'rate_limited', 'validation'], limit: '6/min per wallet, 40/day per IP' },

  packsList: { method: 'GET', path: '/api/packs', auth: 'none', agent: 'PACKS', cache: { cdnS: 15 }, status: 200, response: PacksResponse, errors: ['feature_off'], limit: 'failOpen read limit' },
  packsMine: { method: 'GET', path: '/api/packs/mine', auth: 'session', agent: 'PACKS', cache: 'none', status: 200, response: PacksResponse, errors: ['feature_off'] },
  packsCreate: { method: 'POST', path: '/api/packs', auth: 'session', agent: 'PACKS', cache: 'none', status: 201, request: PackCreateRequest, response: PackControlResponse, errors: ['feature_off', 'seller_not_allowed', 'asset_not_ready', 'already_listed', 'validation', 'rate_limited', 'mainnet_config_incomplete'], limit: '10/day per wallet' },
  packsOperator: { method: 'GET', path: '/api/packs/operator', auth: 'none', agent: 'PACKS', cache: 'none', status: 200, response: PackOperatorAccess, errors: ['feature_off'] },
  packsDeliveries: { method: 'GET', path: '/api/packs/deliveries', auth: 'session', agent: 'PACKS', cache: 'none', status: 200, response: PackDeliveriesResponse, errors: ['feature_off'] },
  packsDetail: { method: 'GET', path: '/api/packs/:id', auth: 'none', agent: 'PACKS', cache: { cdnS: 5 }, status: 200, response: PackDetailResponse, errors: ['feature_off', 'not_found'], limit: 'failOpen read limit' },
  packsControl: { method: 'POST', path: '/api/packs/:id/control', auth: 'session', agent: 'PACKS', cache: 'none', status: 200, request: PackControlRequest, response: PackControlResponse, errors: ['feature_off', 'not_seller', 'not_found', 'wrong_state', 'asset_not_ready', 'validation', 'paused'] },
  packsOpen: { method: 'POST', path: '/api/packs/:id/open', auth: 'session', agent: 'PACKS', cache: 'none', status: 200, request: PackOpenRequest, response: PackOpenResponse, errors: ['feature_off', 'not_found', 'wrong_state', 'rate_limited', 'vrf_pending', 'asset_not_ready', 'insufficient_usdc', 'rpc_unavailable', 'mainnet_config_incomplete', 'forbidden', 'paused'], limit: 'per-wallet daily cap of the pack, 5/min per wallet' },
  packsDrawSign: { method: 'POST', path: '/api/packs/draws/:id/sign', auth: 'session', agent: 'PACKS', cache: 'none', status: 200, request: SignInput, response: PackSignResponse, errors: ['feature_off', 'not_found', 'not_party', 'tx_mismatch', 'round_expired', 'blockhash_expired', 'simulation_failed', 'rpc_unavailable', 'mainnet_config_incomplete', 'wrong_state', 'insufficient_usdc', 'bad_signature', 'paused'] },
  packsDraw: { method: 'GET', path: '/api/packs/draws/:id', auth: 'none', agent: 'PACKS', cache: { cdnS: 3 }, status: 200, response: PackDrawView, errors: ['feature_off', 'not_found'], limit: 'failOpen read limit' },
  packsDrawPrepare: { method: 'POST', path: '/api/packs/draws/:id/prepare', auth: 'session', agent: 'PACKS', cache: 'none', status: 200, request: PrepareRequest, response: PackPayment, errors: ['feature_off', 'not_found', 'not_party', 'wrong_state', 'insufficient_usdc', 'asset_not_ready', 'rpc_unavailable', 'mainnet_config_incomplete', 'paused'], limit: '6/min' },
  packsDraws: { method: 'GET', path: '/api/packs/:id/draws', auth: 'none', agent: 'PACKS', cache: { cdnS: 3 }, status: 200, query: PackDrawsQuery, response: PackDrawsResponse, errors: ['feature_off', 'not_found'], limit: 'failOpen read limit' },
  telegramStatus: { method: 'GET', path: '/api/telegram/link', auth: 'session', agent: 'TELEGRAM', cache: 'none', status: 200, response: TelegramStatusResponse, errors: [], limit: '60/min per wallet, failOpen' },
  telegramLink: { method: 'POST', path: '/api/telegram/link', auth: 'session', agent: 'TELEGRAM', cache: 'none', status: 200, request: TelegramLinkRequest, response: TelegramLinkResponse, errors: ['feature_off', 'rate_limited'], limit: '5/10 min per wallet' },
  telegramUpdate: { method: 'PATCH', path: '/api/telegram/link', auth: 'session', agent: 'TELEGRAM', cache: 'none', status: 200, request: TelegramUpdateRequest, response: TelegramStatusResponse, errors: ['feature_off', 'not_found', 'rate_limited', 'validation'], limit: '30/min per wallet' },
  telegramUnlink: { method: 'DELETE', path: '/api/telegram/link', auth: 'session', agent: 'TELEGRAM', cache: 'none', status: 204, response: null, errors: ['feature_off', 'rate_limited'], limit: '30/min per wallet' },
  telegramWebhook: { method: 'POST', path: '/api/telegram/webhook', auth: 'webhook', agent: 'TELEGRAM', cache: 'none', status: 200, response: TelegramWebhookResponse, errors: ['feature_off', 'unauthenticated', 'validation'], limit: 'Telegram only: the secret header is checked in constant time' },
} as const satisfies Record<string, RouteDef>);

export type RouteKey = keyof typeof ROUTES;
export type RouteRequest<K extends RouteKey> = (typeof ROUTES)[K] extends { request: infer S extends z.ZodTypeAny } ? z.input<S> : never;
export type RouteResponse<K extends RouteKey> = (typeof ROUTES)[K]['response'] extends infer S extends z.ZodTypeAny ? z.output<S> : never;

// Convenient inferred types for the shapes UI code passes around.
export type LiveSnapshot = z.infer<typeof LiveSnapshot>;
export type CatalogueLot = z.infer<typeof CatalogueLot>;
export type ShowCore = z.infer<typeof ShowCore>;
export type ShowSummary = z.infer<typeof ShowSummary>;
export type ShowDetail = z.infer<typeof ShowDetail>;
export type BidRequest = z.infer<typeof BidRequest>;
export type BidResponse = z.infer<typeof BidResponse>;
export type BidIntent = z.infer<typeof BidIntent>;
export type CreateShowRequest = z.input<typeof CreateShowRequest>;
export type MeResponse = z.infer<typeof MeResponse>;
export type PaddleResponse = z.infer<typeof PaddleResponse>;
export type SellAsset = z.infer<typeof SellAsset>;
export type HealthResponse = z.infer<typeof HealthResponse>;
