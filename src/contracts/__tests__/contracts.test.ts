import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { ZodTypeAny } from 'zod';
import {
  ROUTES, LiveSnapshot, BidRequest, BidResponse, CreateShowRequest, LotControlRequest, ShowDetail, ShowListResponse,
  MeResponse, PaddleResponse, SellAssetsResponse, ReadinessResponse, HealthResponse, SignInput, PatchLotRequest,
  ERROR_CODES, ERROR_STATUS, ErrorResponseSchema, ApiError, errorBody,
  EVENT_PAYLOADS, EVENT_KINDS, parseEventPayload,
  ExpectedSettlement, PreparedSettlement, SettlementView, SignResult, AssetReadiness, expectedSigners, settlementMemo,
  Amount, Wallet, MAX_BID, LotBidsResponse, ShowCore, AuctionRulesInput, ActivityResponse, HealthConfigErrorResponse,
  VrfRequestView, VrfKeyResponse, VrfShowResponse, PlaybackResponse, VideoToggleResponse, ChatListResponse, ChatPostRequest, ChatPostResponse, ChatMineResponse,
  ChatModerateRequest, ChatReportRequest, AiCreditsResponse, AiCreditsQuoteResponse, AiCreditsPayRequest, AiPurchaseView, AiListingRequest, AiListingResponse,
  PaymentRequiredBody, type RouteDef, AiAskRequest, AiAskResponse, PacksResponse, PackOpenRequest, PackOpenResponse, ChatModerateResponse,
  ChatQueueResponse, ChatQueueQuery, PackDetailResponse, PackCreateRequest, PackControlRequest, PackDrawView, PackSignResponse,
} from '..';

const DIR = path.join(__dirname, '..', 'fixtures');
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'));

// Every fixture is listed here with the schema that must accept it. A new file without an entry fails the test below.
const FIXTURES: Record<string, ZodTypeAny> = {
  'live-snapshot.scheduled': LiveSnapshot,
  'live-snapshot.open': LiveSnapshot,
  'live-snapshot.paused': LiveSnapshot,
  'live-snapshot.going-twice': LiveSnapshot,
  'live-snapshot.awaiting-payment': LiveSnapshot,
  'live-snapshot.settled': LiveSnapshot,
  'bid-request': BidRequest,
  'bid-response': BidResponse,
  'bid-error-too-low': ErrorResponseSchema,
  'error.rate-limited': ErrorResponseSchema,
  'error.tx-mismatch': ErrorResponseSchema,
  'error.round-expired': ErrorResponseSchema,
  'settlement-awaiting': SettlementView,
  'settlement-round-open': SettlementView,
  'settlement-submitted': SettlementView,
  'settlement-settled': SettlementView,
  'settlement-expired': SettlementView,
  'expected-settlement': ExpectedSettlement,
  'settlement-prepare-response': PreparedSettlement,
  'settlement-sign-request': SignInput,
  'settlement-sign-response': SignResult,
  'show-detail': ShowDetail,
  'show-list': ShowListResponse,
  'create-show-request': CreateShowRequest,
  me: MeResponse,
  'paddle-response': PaddleResponse,
  'sell-assets': SellAssetsResponse,
  'readiness-response': ReadinessResponse,
  health: HealthResponse,
  'lot-bids': LotBidsResponse,
  // optional features (all additive; the fixtures above carry none of their fields and must keep parsing)
  'show-detail.features': ShowDetail,
  'live-snapshot.vrf-order': LiveSnapshot,
  'vrf-request.revealed': VrfRequestView,
  'vrf-request.pending': VrfRequestView,
  'vrf-key': VrfKeyResponse,
  'vrf-show': VrfShowResponse,
  'stream-playback': PlaybackResponse,
  'stream-playback.off': PlaybackResponse,
  'video-toggle-response': VideoToggleResponse,
  'chat-list': ChatListResponse,
  'chat-post-request': ChatPostRequest,
  'chat-post-response': ChatPostResponse,
  'chat-mine': ChatMineResponse,
  'chat-moderate-request': ChatModerateRequest,
  'chat-moderate-publish': ChatModerateRequest,
  'chat-moderate-mute': ChatModerateRequest,
  'chat-queue': ChatQueueResponse,
  'chat-report-request': ChatReportRequest,
  'ai-credits': AiCreditsResponse,
  'ai-credits-quote': AiCreditsQuoteResponse,
  'ai-credits-pay-request': AiCreditsPayRequest,
  'ai-purchase-settled': AiPurchaseView,
  'ai-listing-request': AiListingRequest,
  'ai-listing-response': AiListingResponse,
  'ai-ask-request': AiAskRequest,
  'ai-ask-response': AiAskResponse,
  'error.payment-required': PaymentRequiredBody,
  packs: PacksResponse,
  'pack-detail': PackDetailResponse,
  'pack-create-request': PackCreateRequest,
  'pack-control-request': PackControlRequest,
  'pack-open-request': PackOpenRequest,
  'pack-open-response': PackOpenResponse,
  'pack-draw': PackDrawView,
  'pack-sign-response': PackSignResponse,
  'error.mainnet-config-incomplete': ErrorResponseSchema,
  'error.feature-off': ErrorResponseSchema,
  'health.config-error': HealthConfigErrorResponse,
  'activity.bids': ActivityResponse,
};

describe('fixtures', () => {
  it('has a schema for every fixture file and a file for every schema entry', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    const known = [...Object.keys(FIXTURES), 'events.all-kinds'].sort();
    expect(files.sort()).toEqual(known);
  });

  for (const [name, schema] of Object.entries(FIXTURES)) {
    it(`${name} parses`, () => {
      const r = schema.safeParse(read(name));
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true);
    });
  }

  it('one payload per event kind, each matching its schema', () => {
    const all = read('events.all-kinds') as Record<string, unknown>;
    expect(Object.keys(all).sort()).toEqual([...EVENT_KINDS].sort());
    for (const kind of EVENT_KINDS) expect(parseEventPayload(kind, all[kind]), kind).not.toBeNull();
  });

  it('event payloads carry paddle numbers, never wallet addresses', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const walletLike = (v: unknown) => typeof v === 'string' && !uuid.test(v) && Wallet.safeParse(v).success;
    const events = [
      ...read('live-snapshot.open').events, ...read('live-snapshot.going-twice').events,
      ...read('live-snapshot.awaiting-payment').events, ...read('live-snapshot.settled').events,
      ...Object.values(read('events.all-kinds')).map((payload) => ({ payload })),
    ];
    for (const e of events) for (const v of Object.values(e.payload)) expect(walletLike(v), JSON.stringify(e)).toBe(false);
  });

  it('breaking a fixture breaks its schema', () => {
    const s = read('settlement-round-open');
    delete s.buyerSigned;
    expect(SettlementView.safeParse(s).success).toBe(false);
    expect(SettlementView.safeParse({ ...read('settlement-round-open'), extra: 1 }).success).toBe(false);
    expect(BidRequest.safeParse({ ...read('bid-request'), amount: 120 }).success).toBe(false);
    expect(LiveSnapshot.safeParse({ ...read('live-snapshot.open'), v: 2 }).success).toBe(false);
  });

  it('uses no em dashes (house style)', () => {
    for (const f of fs.readdirSync(DIR)) expect(fs.readFileSync(path.join(DIR, f), 'utf8')).not.toContain('\u2014');
  });
});

describe('errors', () => {
  it('gives every code a status', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const s of Object.values(ERROR_STATUS)) expect([400, 401, 402, 403, 404, 409, 429, 503]).toContain(s);
  });

  it('has the co-sign codes and no discretionary hammer', () => {
    for (const c of ['round_expired', 'not_party', 'counterparty_pending', 'not_buyer']) expect(ERROR_CODES).toContain(c);
    expect(ERROR_CODES).not.toContain('below_floor');
  });

  it('builds one body shape and one exception type', () => {
    const body = errorBody('bid_too_low', 'too low', { minNext: '125000000' });
    expect(ErrorResponseSchema.parse(body)).toMatchObject({ ok: false, code: 'bid_too_low', minNext: '125000000' });
    const e = new ApiError('rate_limited', 'slow down', { retryAfterS: 2 });
    expect(e.status).toBe(429);
    expect(e.extra).toEqual({ retryAfterS: 2 });
  });
});

describe('route registry', () => {
  const routes: readonly RouteDef[] = Object.values(ROUTES);

  it('has unique method and path pairs', () => {
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has no delegation route and no settlement submit route', () => {
    for (const r of routes) {
      expect(r.path).not.toContain('delegation');
      expect(r.path).not.toMatch(/\/settlements\/:id\/submit$/);
    }
  });

  it('settlements are prepare, GET status, sign', () => {
    const keys = routes.filter((r) => r.path.startsWith('/api/settlements')).map((r) => `${r.method} ${r.path}`).sort();
    expect(keys).toEqual(['GET /api/settlements/:id', 'POST /api/settlements/:id/prepare', 'POST /api/settlements/:id/sign']);
    expect(ROUTES.settlementSign.request).toBe(SignInput);
  });

  it('only declares error codes that exist', () => {
    for (const r of routes) for (const c of r.errors) expect(ERROR_CODES, `${r.method} ${r.path}`).toContain(c);
  });

  it('caches live reads at the CDN for 1 s and everything that writes not at all', () => {
    expect(ROUTES.auctionLive.cache).toEqual({ cdnS: 1 });
    for (const r of routes.filter((x) => x.method !== 'GET')) expect(r.cache).toBe('none');
  });

  it('gives an anonymousStatus only to session_optional GETs', () => {
    for (const r of routes.filter((x) => 'anonymousStatus' in x)) {
      expect(r.auth).toBe('session_optional');
      expect(r.method).toBe('GET');
    }
  });

  it('has a response schema unless it answers 204 or a raw (non-JSON) body', () => {
    for (const r of routes) expect(r.response === null, `${r.method} ${r.path}`).toBe(r.status === 204 || r.raw?.response !== undefined);
  });

  it('registers the optional-feature routes, each under its own agent, and only the WHIP signaling is raw', () => {
    const byAgent = (a: string) => routes.filter((r) => r.agent === a).map((r) => `${r.method} ${r.path}`).sort();
    expect(byAgent('VRF')).toEqual(['GET /api/vrf/key', 'GET /api/vrf/requests/:id', 'GET /api/vrf/shows/:id', 'POST /api/vrf/requests/:id/advance']);
    expect(byAgent('VIDEO')).toEqual(['DELETE /api/streams/:showId/whip/:sessionId', 'GET /api/streams/:showId/playback', 'POST /api/shows/:id/video', 'POST /api/streams/:showId/whip']);
    expect(byAgent('AI')).toEqual(['GET /api/ai/credits', 'GET /api/ai/credits/purchases/:id', 'POST /api/ai/agent', 'POST /api/ai/ask', 'POST /api/ai/credits/pay', 'POST /api/ai/credits/quote', 'POST /api/ai/listing']);
    expect(byAgent('CHAT')).toEqual(['GET /api/shows/:id/chat', 'GET /api/shows/:id/chat/mine', 'GET /api/shows/:id/chat/queue', 'POST /api/chat/:id/report', 'POST /api/shows/:id/chat', 'POST /api/shows/:id/chat/moderate']);
    expect(byAgent('PACKS')).toEqual([
      'GET /api/packs', 'GET /api/packs/:id', 'GET /api/packs/:id/draws', 'GET /api/packs/deliveries', 'GET /api/packs/draws/:id', 'GET /api/packs/mine', 'GET /api/packs/operator', 'POST /api/packs', 'POST /api/packs/:id/control', 'POST /api/packs/:id/open', 'POST /api/packs/draws/:id/prepare', 'POST /api/packs/draws/:id/sign',
    ]);
    expect(routes.filter((r) => r.raw).map((r) => r.path)).toEqual(['/api/streams/:showId/whip']);
    expect(ROUTES.streamWhip.raw).toEqual({ request: 'application/sdp', response: 'application/sdp' });
  });

  it('every optional-feature route can answer feature_off, except the ones that read nothing of their own', () => {
    for (const r of routes.filter((x) => ['VRF', 'VIDEO', 'AI', 'CHAT', 'PACKS'].includes(x.agent))) {
      if (r.path === '/api/streams/:showId/playback' || r.path === '/api/shows/:id/chat') continue; // these answer { enabled: false } instead
      expect(r.errors, `${r.method} ${r.path}`).toContain('feature_off');
    }
  });

  it('the money routes can answer the cluster-configuration 503s', () => {
    for (const k of ['bidsPlace', 'lotBuyNow', 'paddleRegister', 'showsCreate', 'settlementPrepare', 'settlementSign', 'aiCreditsQuote', 'aiCreditsPay', 'health'] as const) {
      expect(ROUTES[k].errors, k).toContain('mainnet_config_incomplete');
    }
  });
});

describe('additive contract changes: older data keeps parsing, new fields default', () => {
  it('an older show detail (no kind, order, video, description) parses to the live, catalogue, no-video defaults', () => {
    const d = ShowDetail.parse(read('show-detail'));
    expect(d.show).toMatchObject({ kind: 'live', orderMode: 'catalogue', video: { enabled: false } });
    expect(d.lots[0]).toMatchObject({ description: null, aiAssisted: false });
  });

  it('an older live snapshot gets kind live, a catalogue order and no video', () => {
    const snap = LiveSnapshot.parse(read('live-snapshot.open'));
    expect(snap.show).toMatchObject({ kind: 'live', order: { mode: 'catalogue' }, video: { enabled: false } });
    expect(ShowCore.safeParse({ ...read('show-detail').show, kind: 'weekly' }).success).toBe(false);
  });

  it('the superset of rule limits keeps every older fixture valid, and tight values stay refused', () => {
    expect(CreateShowRequest.safeParse(read('create-show-request')).success).toBe(true);
    expect(AuctionRulesInput.safeParse({ lotDurationS: 86_400, callOnceS: 300, snipeWindowS: 300, snipeExtendS: 300, maxExtensionS: 86_400 }).success).toBe(true);
    expect(AuctionRulesInput.safeParse({ lotDurationS: 1_209_601 }).success).toBe(false);
    expect(AuctionRulesInput.safeParse({ lotDurationS: 9 }).success).toBe(false);
    expect(AuctionRulesInput.safeParse({ maxExtensionS: 604_801 }).success).toBe(false);
  });

  it('a show request carries kind, the video choice and a description per lot, defaults being a live show without video', () => {
    const show = read('create-show-request');
    expect(CreateShowRequest.parse(show)).toMatchObject({ kind: 'live', videoEnabled: false });
    const timed = CreateShowRequest.parse({ ...show, kind: 'timed', videoEnabled: true, lots: [{ ...show.lots[0], description: { de: 'Text', en: 'Text' }, aiAssisted: true }] });
    expect(timed).toMatchObject({ kind: 'timed', videoEnabled: true });
    expect(CreateShowRequest.safeParse({ ...show, lots: [{ ...show.lots[0], description: { de: 'Nur Deutsch' } }] }).success).toBe(false);
    expect(CreateShowRequest.safeParse({ ...show, kind: 'timed ' }).success).toBe(false);
  });

  it('a seller may extend by up to an hour; the activity list carries when a bid ends and the lot state', () => {
    expect(LotControlRequest.safeParse({ action: 'extend', seconds: 3600 }).success).toBe(true);
    expect(LotControlRequest.safeParse({ action: 'extend', seconds: 3601 }).success).toBe(false);
    const a = read('activity.bids');
    expect(ActivityResponse.safeParse(a).success).toBe(true);
    delete a.items[0].lotState;
    expect(ActivityResponse.safeParse(a).success).toBe(false);
  });

  it('the new error codes have their statuses: 402 for payment, 404 when a feature is off, 503 for a bad cluster configuration', () => {
    expect(ERROR_STATUS).toMatchObject({
      payment_required: 402, feature_off: 404, muted: 403, vrf_pending: 409, ai_budget: 429, ai_unavailable: 503, video_unavailable: 503,
      mainnet_config_incomplete: 503, cluster_config_conflict: 503,
    });
    expect(new ApiError('payment_required', 'pay').status).toBe(402);
  });
});

describe('optional-feature shapes', () => {
  it('a playback URL appears only for a show with video that is live', () => {
    expect(PlaybackResponse.safeParse({ enabled: false, live: true, hlsUrl: 'https://h.example/x.m3u8' }).success).toBe(false);
    expect(PlaybackResponse.safeParse({ enabled: true, live: false, hlsUrl: 'https://h.example/x.m3u8' }).success).toBe(false);
    expect(PlaybackResponse.safeParse(read('stream-playback')).success).toBe(true);
  });

  it('a draw is revealed with a proof and output, or it has none; the proof and output have fixed lengths', () => {
    const r = read('vrf-request.revealed');
    expect(VrfRequestView.safeParse({ ...r, proofHex: 'ab' }).success).toBe(false);
    expect(VrfRequestView.safeParse({ ...r, outputHex: r.outputHex.slice(2) }).success).toBe(false);
    expect(VrfRequestView.safeParse({ ...r, txBytes: 'x' }).success).toBe(false); // server-only fields never appear
  });

  it('the public chat list has no author and no wallet, and only the operator queue carries a wallet', () => {
    const list = read('chat-list');
    expect(ChatListResponse.safeParse({ ...list, messages: [{ ...list.messages[0], authorId: list.messages[0].id }] }).success).toBe(false);
    expect(ChatListResponse.safeParse({ ...list, messages: [{ ...list.messages[0], wallet: 'x' }] }).success).toBe(false);
    expect(ChatListResponse.safeParse({ ...list, messages: [{ ...list.messages[0], status: 'pending' }] }).success).toBe(false); // the public shape has no status: only approved messages are in it
    expect(ChatPostRequest.safeParse({ body: 'x'.repeat(201), clientNonce: read('chat-post-request').clientNonce }).success).toBe(false);
    expect(ChatModerateRequest.safeParse({ action: 'ban', paddle: 1 }).success).toBe(false);
    expect(ChatModerateResponse.safeParse({ ok: true, affected: 2 }).success).toBe(true);
    expect(ChatQueueResponse.safeParse(read('chat-queue')).success).toBe(true);
  });

  it('chat is pre-moderated: a message starts pending, the author sees it as such, and moderation takes batches and reasons', () => {
    expect(read('chat-post-response').message.status).toBe('pending');
    expect(ChatPostResponse.safeParse({ message: { ...read('chat-post-response').message, status: 'visible' } }).success).toBe(false);
    expect(ChatModerateRequest.safeParse({ action: 'reject', messageIds: read('chat-moderate-request').messageIds }).success).toBe(false); // a reason is required
    expect(ChatModerateRequest.safeParse({ action: 'approve', messageIds: [] }).success).toBe(false);
    expect(ChatModerateRequest.safeParse({ action: 'block', paddle: 7, reason: 'Harassment' }).success).toBe(true);
    expect(ChatQueueQuery.parse({}).filter).toBe('pending');
  });

  it('the AI draft is labelled as one, and a draft request takes at most three images', () => {
    expect(AiListingResponse.safeParse({ ...read('ai-listing-response'), label: 'final' }).success).toBe(false);
    const req = read('ai-listing-request');
    const img = { mediaType: 'image/jpeg', dataBase64: 'AAAA' };
    expect(AiListingRequest.safeParse({ ...req, images: [img, img, img] }).success).toBe(true);
    expect(AiListingRequest.safeParse({ ...req, images: [img, img, img, img] }).success).toBe(false);
    expect(AiListingRequest.safeParse({ ...req, images: [{ mediaType: 'image/gif', dataBase64: 'AAAA' }] }).success).toBe(false);
    expect(AiAskResponse.safeParse({ ...read('ai-ask-response'), source: 'model' }).success).toBe(false);
  });

  it('a pack is an intermediary offer: committed pool, published odds, 18+ confirmation, atomic payment and card', () => {
    const create = read('pack-create-request');
    expect(PackCreateRequest.safeParse(create).success).toBe(true);
    // odds must add up, tiers must exist, equal-value packs carry one value and one tier, a card is in the pool once
    expect(PackCreateRequest.safeParse({ ...create, mode: 'chance', odds: [{ ...create.odds[0], bps: 9000 }] }).success).toBe(false);
    expect(PackCreateRequest.safeParse({ ...create, cards: [{ ...create.cards[0], tier: 'missing' }, create.cards[1]] }).success).toBe(false);
    expect(PackCreateRequest.safeParse({ ...create, cards: [create.cards[0], { ...create.cards[1], listedValue: '1' }] }).success).toBe(false);
    expect(PackCreateRequest.safeParse({ ...create, cards: [create.cards[0], create.cards[0]] }).success).toBe(false);
    expect(PackCreateRequest.safeParse({ ...create, price: '0' }).success).toBe(false);
    expect(PackCreateRequest.safeParse({ ...create, surprise: 1 }).success).toBe(false);
    // the 18+ confirmation is part of the open request and cannot be false
    expect(PackOpenRequest.safeParse({ ...read('pack-open-request'), ageConfirmed: false }).success).toBe(false);
    expect(PackOpenRequest.safeParse({ clientSeed: read('pack-open-request').clientSeed }).success).toBe(false);
    // the draw carries its verifiable pieces; proof and output have fixed lengths
    const draw = read('pack-draw');
    expect(PackDrawView.safeParse({ ...draw, vrf: { ...draw.vrf, proofHex: 'ab' } }).success).toBe(false);
    expect(read('pack-detail').pack.commitment.poolHash).toMatch(/^[0-9a-f]{64}$/);
    // the platform fee and the operator's card move in one payment: the expected payment names buyer, operator, card, fee wallet and the memo
    const exp = read('pack-open-response').payment.expected;
    for (const k of ['buyer', 'operator', 'asset', 'feeWallet', 'feePayer', 'memo', 'gross', 'platformFee']) expect(exp[k], k).toBeTruthy();
    expect(exp.memo).toBe(draw.settlementRef);
  });
});

describe('request strictness', () => {
  const show = read('create-show-request');

  it('rejects unknown keys, manual mode and out-of-range lot counts', () => {
    expect(CreateShowRequest.safeParse(show).success).toBe(true);
    expect(CreateShowRequest.safeParse({ ...show, surprise: 1 }).success).toBe(false);
    expect(CreateShowRequest.safeParse({ ...show, mode: 'manual' }).success).toBe(false);
    expect(CreateShowRequest.safeParse({ ...show, lots: [] }).success).toBe(false);
    expect(CreateShowRequest.safeParse({ ...show, lots: Array.from({ length: 31 }, () => show.lots[0]) }).success).toBe(false);
    expect(CreateShowRequest.safeParse({ ...show, rules: { lotDurationS: 5 } }).success).toBe(false);
  });

  it('gives the seller no hammer: only extend and withdraw', () => {
    expect(LotControlRequest.safeParse({ action: 'withdraw' }).success).toBe(true);
    for (const action of ['hammer', 'pass', 'open', 'accept_below_reserve']) expect(LotControlRequest.safeParse({ action }).success).toBe(false);
    expect(PatchLotRequest.safeParse({}).success).toBe(false);
    expect(PatchLotRequest.safeParse({ reserve: '100000000' }).success).toBe(true);
  });

  it('takes amounts as unsigned integer strings only', () => {
    for (const ok of ['0', '1', '120000000']) expect(Amount.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['', '-1', '01', '1.5', '1e6', ' 5', 5]) expect(Amount.safeParse(bad).success, String(bad)).toBe(false);
    expect(MAX_BID).toBe(10n ** 12n);
  });

  it('signs as buyer or seller, never as the platform', () => {
    const tx = read('settlement-sign-request').signedTxBase64;
    expect(SignInput.safeParse({ role: 'seller', signedTxBase64: tx }).success).toBe(true);
    expect(SignInput.safeParse({ role: 'sa', signedTxBase64: tx }).success).toBe(false);
    expect(SignInput.safeParse({ role: 'buyer' }).success).toBe(false);
  });
});

describe('expected settlement (signer set {feePayer, buyer, seller})', () => {
  const e = read('expected-settlement');

  it('lists the fee payer first, then buyer, then seller', () => {
    expect(expectedSigners(e)).toEqual([e.feePayer, e.buyer, e.seller]);
    expect(new Set(expectedSigners(e)).size).toBe(3);
  });

  it('anchors the bid log in the memo', () => {
    expect(e.memo).toBe(settlementMemo(e.settlementId, e.bidLogHash));
    expect(ExpectedSettlement.safeParse({ ...e, memo: `hp:settle:${e.settlementId}` }).success).toBe(false);
  });

  it('refuses inconsistent inputs', () => {
    expect(ExpectedSettlement.safeParse({ ...e, platformFee: '999999999999' }).success).toBe(false);
    expect(ExpectedSettlement.safeParse({ ...e, lifetime: 'nonce' }).success).toBe(false);
    expect(ExpectedSettlement.safeParse({ ...e, lifetime: 'nonce', nonceAccount: e.feeWallet }).success).toBe(true);
    expect(ExpectedSettlement.safeParse({ ...e, royalty: '1000000' }).success).toBe(false);
    expect(ExpectedSettlement.safeParse({ ...e, royalty: '1000000', royaltyRecipient: e.seller }).success).toBe(true);
  });

  it('prepare carries both signature flags and the round end', () => {
    const p = read('settlement-prepare-response');
    expect(p.expected).toEqual(e);
    expect(typeof p.buyerSigned).toBe('boolean');
    expect(typeof p.sellerSigned).toBe('boolean');
    expect(p.roundExpiresAt).toBeTruthy();
  });
});

describe('asset readiness', () => {
  it('is eligible exactly when there are no reasons', () => {
    expect(AssetReadiness.safeParse({ eligible: true, reasons: [] }).success).toBe(true);
    expect(AssetReadiness.safeParse({ eligible: false, reasons: ['frozen'] }).success).toBe(true);
    expect(AssetReadiness.safeParse({ eligible: true, reasons: ['frozen'] }).success).toBe(false);
    expect(AssetReadiness.safeParse({ eligible: false, reasons: [] }).success).toBe(false);
  });
});

describe('event schemas', () => {
  it('reject a wallet in place of a paddle number and any extra key', () => {
    const p = read('events.all-kinds')['bid.placed'];
    expect(EVENT_PAYLOADS['bid.placed'].safeParse(p).success).toBe(true);
    expect(EVENT_PAYLOADS['bid.placed'].safeParse({ ...p, paddle: 'So11111111111111111111111111111111111111112' }).success).toBe(false);
    expect(EVENT_PAYLOADS['bid.placed'].safeParse({ ...p, walletAddress: 'x' }).success).toBe(false);
    expect(parseEventPayload('bid.placed', { lotId: 'nope' })).toBeNull();
  });
});
