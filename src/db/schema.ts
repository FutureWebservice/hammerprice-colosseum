/**
 * The database, as one source of truth.
 *
 * This replaces a Supabase setup where the generated types and the migrations had drifted:
 * generated-types.ts declared six tables that existed in no migration and omitted four that
 * did. Drizzle's schema is now the only place a table is defined, and drizzle-kit generates
 * the migrations from it.
 *
 * Authorisation moved with it. Supabase enforced 78 RLS policies in the database against a
 * JWT; Neon has no equivalent, so every one of those rules is now an explicit check in the
 * route that performs the write. That is more code, but it is code you can read - the RLS
 * set had accumulated six policies for a table nothing referenced.
 */
import { sql } from 'drizzle-orm';
import {
  customType, pgTable, text, uuid, timestamp, date, boolean, integer, bigint, numeric, jsonb, index, uniqueIndex, primaryKey, pgEnum,
} from 'drizzle-orm/pg-core';

export const showFormat = pgEnum('show_format', ['auction', 'buy_now']);
export const showStatus = pgEnum('show_status', ['scheduled', 'live', 'ended']);
export const lotState = pgEnum('lot_state', ['catalogued', 'open', 'sold', 'passed', 'withdrawn']);

/** Postgres bytea as a Node Buffer (drizzle has no built-in column for it). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** A person, identified by the wallet they sign with. */
export const profiles = pgTable('profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  walletAddress: text('wallet_address').notNull().unique(),
  username: text('username').unique(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  /** An uploaded picture (png, jpeg or webp, at most 200 KB, checked by magic bytes), served by GET /api/avatar/:profileId. Added in 0010. */
  avatar: bytea('avatar'),
  avatarType: text('avatar_type'),
  bio: text('bio'),
  /** Was is_creator. A seller is someone who consigns lots and runs shows. */
  isSeller: boolean('is_seller').default(false).notNull(),
  isBanned: boolean('is_banned').default(false).notNull(),
  bannedReason: text('banned_reason'),
  bannedAt: timestamp('banned_at', { withTimezone: true }),
  /** Non-payment strikes; three and the paddle is suspended. */
  strikes: integer('strikes').default(0).notNull(),
  /** House bidders on the demo house show. Never set on a consigned seller's lots. */
  isBot: boolean('is_bot').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  /** A username is unique without regard to case (0010). */
  usernameLower: uniqueIndex('profiles_username_lower_idx').on(sql`lower(${t.username})`),
}));

/** A broadcast. Was `streams`; all livepeer_* columns are gone with the provider. */
export const shows = pgTable('shows', {
  id: uuid('id').defaultRandom().primaryKey(),
  sellerId: uuid('seller_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  format: showFormat('format').default('auction').notNull(),
  status: showStatus('status').default('scheduled').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** When the room opens. startedAt stays 'when it actually went live'. */
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  /** The API only accepts 'auto' (the lot closes by itself); 'manual' is kept so old rows and the column stay valid. */
  mode: text('mode').default('auto').notNull(),
  /** AuctionRules overrides (lib/auction/rules.ts fills the defaults). */
  rules: jsonb('rules').default(sql`'{}'::jsonb`).notNull(),
  /** 'none' = legacy/simulated rows that never settle; 'onchain' = real DvP settlement. */
  settlementMode: text('settlement_mode').default('none').notNull(),
  /** 'devnet' | 'mainnet-beta'; null on legacy rows. */
  cluster: text('cluster'),
  /** House-run show: may use house bidders and operator wallets. */
  isHouse: boolean('is_house').default(false).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  /** 'live' (a room with a clock per lot) | 'timed' (one lot, hours to days). */
  kind: text('kind').default('live').notNull(),
  /** 'catalogue' (lots open in catalogue order) | 'vrf' (the order is drawn by a verifiable random function, see vrf_requests). */
  orderMode: text('order_mode').default('catalogue').notNull(),
  /** The seller ticked the optional live video for this show. Only effective while FEATURE_VIDEO is on; the host and path never leave the server. */
  videoEnabled: boolean('video_enabled').default(false).notNull(),
  /** The seller paused the room. Null = running. While set, bids are refused and the open lot's clock is frozen; resuming shifts its closes_at by the paused time. */
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  /** How many pauses this show has used (at most 2). Never decreases. */
  pauseCount: integer('pause_count').default(0).notNull(),
}, (t) => ({
  bySeller: index('shows_seller_idx').on(t.sellerId),
  byStatus: index('shows_status_idx').on(t.status),
  bySchedule: index('shows_sched_idx').on(t.status, t.scheduledAt),
}));

/**
 * Ingest credentials, split out so they are never reachable from a query that renders a page.
 * The old schema kept the stream key on the streams row, and a browser-side select handed it
 * to any anonymous visitor.
 */
export const showSecrets = pgTable('show_secrets', {
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).primaryKey(),
  ingestPath: text('ingest_path').notNull(),
  publishToken: text('publish_token').notNull(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** A card offered in a show. Was `nfts`. */
export const lots = pgTable('lots', {
  id: uuid('id').defaultRandom().primaryKey(),
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }),
  sellerId: uuid('seller_id').references(() => profiles.id).notNull(),
  /** Position in the catalogue - the number the auctioneer calls. */
  lotNumber: integer('lot_number').notNull(),
  /** The on-chain asset. This is what moves at the hammer. */
  mintAddress: text('mint_address').notNull(),
  /** 'core' or 'pnft' - decides which settlement instruction applies. */
  nftStandard: text('nft_standard').notNull(),
  vaultRef: text('vault_ref'),
  name: text('name').notNull(),
  setName: text('set_name'),
  gradingCompany: text('grading_company'),
  grade: text('grade'),
  gradingId: text('grading_id'),
  imageUrl: text('image_url'),
  /** All money in USDC base units (6dp) as bigint. Never floats. */
  insuredValue: bigint('insured_value', { mode: 'bigint' }),
  reserve: bigint('reserve', { mode: 'bigint' }),
  increment: bigint('increment', { mode: 'bigint' }).notNull(),
  /** First legal bid on an unbid lot - auction-house convention is ~half the low estimate. */
  openingPrice: bigint('opening_price', { mode: 'bigint' }).notNull(),
  highBid: bigint('high_bid', { mode: 'bigint' }),
  highBidderId: uuid('high_bidder_id').references(() => profiles.id),
  state: lotState('state').default('catalogued').notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** Server-authoritative end of bidding; moves only forward (anti-sniping). */
  closesAt: timestamp('closes_at', { withTimezone: true }),
  /** 'timer' | 'withdrawn' | 'buy_now' ('hammer' only on legacy rows: the close is automatic). */
  closedReason: text('closed_reason'),
  bidCount: integer('bid_count').default(0).notNull(),
  /** Fixed price for the buy_now format (or an auction's optional buy-it-now). */
  buyNowPrice: bigint('buy_now_price', { mode: 'bigint' }),
  /** Asset readiness (owner == seller, not frozen, plain transfer allowed): 'none' (legacy) | 'pending' | 'ready' | 'rejected'. No delegate exists. */
  consignStatus: text('consign_status').default('none').notNull(),
  /** The seller's description, per language: { "de": "...", "en": "..." }. Null = none. */
  description: jsonb('description'),
  /** The seller adopted text from an AI draft (after reviewing it). The room then says so next to the description. */
  aiAssisted: boolean('ai_assisted').default(false).notNull(),
  /** Milliseconds this lot's clock was frozen by the seller's pauses. The extension cap counts from opened_at + paused_ms, so a pause never uses up anti-sniping room. */
  pausedMs: bigint('paused_ms', { mode: 'number' }).default(0).notNull(),
}, (t) => ({
  byShow: index('lots_show_idx').on(t.showId),
  openByClose: index('lots_open_closes_idx').on(t.closesAt).where(sql`state = 'open'`),
  /** At most one lot on the block per show, enforced by the database rather than by a check-then-act. */
  oneOpenPerShow: uniqueIndex('lots_one_open_per_show').on(t.showId).where(sql`state = 'open'`),
  uniqueInShow: uniqueIndex('lots_show_number_idx').on(t.showId, t.lotNumber),
}));

/**
 * A bid. Off-chain and free: the bidder signs an intent, we verify the signature and check
 * their live escrow balance. Nothing is on-chain until the hammer.
 */
export const bids = pgTable('bids', {
  id: uuid('id').defaultRandom().primaryKey(),
  lotId: uuid('lot_id').references(() => lots.id, { onDelete: 'cascade' }).notNull(),
  bidderId: uuid('bidder_id').references(() => profiles.id).notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  /** The signed intent, kept so a disputed hammer can be reconstructed. */
  signature: text('signature').notNull(),
  message: text('message').notNull(),
  nonce: text('nonce').notNull(),
  placedAt: timestamp('placed_at', { withTimezone: true }).defaultNow().notNull(),
  /** 'wallet' (popup per bid) | 'session' (paddle key) | 'house' (demo bot) */
  via: text('via').default('wallet').notNull(),
  paddleId: uuid('paddle_id').references(() => paddles.id),
  /** USDC balance the server read from chain when it accepted this bid. */
  fundedAmount: bigint('funded_amount', { mode: 'bigint' }),
}, (t) => ({
  byLot: index('bids_lot_idx').on(t.lotId),
  byBidder: index('bids_bidder_idx').on(t.bidderId, t.placedAt),
  /** One nonce per bidder, ever - this is what stops a bid being replayed. */
  uniqueNonce: uniqueIndex('bids_bidder_nonce_idx').on(t.bidderId, t.nonce),
}));

/** A completed sale. Was `tips`. */
export const settlements = pgTable('settlements', {
  id: uuid('id').defaultRandom().primaryKey(),
  lotId: uuid('lot_id').references(() => lots.id).notNull(),
  buyerId: uuid('buyer_id').references(() => profiles.id).notNull(),
  sellerId: uuid('seller_id').references(() => profiles.id).notNull(),
  grossAmount: bigint('gross_amount', { mode: 'bigint' }).notNull(),
  platformFee: bigint('platform_fee', { mode: 'bigint' }).notNull(),
  sellerAmount: bigint('seller_amount', { mode: 'bigint' }).notNull(),
  /** Null until the transaction is submitted; verified on chain before status becomes 'settled'. Unique when set. */
  txSignature: text('tx_signature'),
  usdValueAtTime: numeric('usd_value_at_time', { precision: 14, scale: 2 }),
  /** Set when status becomes 'settled'. */
  settledAt: timestamp('settled_at', { withTimezone: true }),
  /** 'awaiting_payment' (= waiting for signatures) | 'awaiting_seller' (cc_marketplace only) | 'submitted' | 'settled' | 'failed' | 'expired'. The partial unique index below lists the live ones. */
  status: text('status').default('awaiting_payment').notNull(),
  /** 'cosign' (server holds only the fee payer key; the house seller is signed server-side) | 'core_delegate' (reserved, not built) | 'cc_marketplace'. */
  rail: text('rail').default('cosign').notNull(),
  cluster: text('cluster'),
  mintAddress: text('mint_address'),
  /** Signing round. A new one starts when the previous round's blockhash window ended unsigned. */
  attempt: integer('attempt').default(1).notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  /** The current round: the unsigned message both parties sign (base64), its blockhash and last valid block height. */
  preparedMessage: text('prepared_message'),
  preparedBlockhash: text('prepared_blockhash'),
  lastValidHeight: bigint('last_valid_height', { mode: 'number' }),
  roundExpiresAt: timestamp('round_expires_at', { withTimezone: true }),
  /** Base64 ed25519 signature over preparedMessage; null until that party signed, cleared when the round expires. "Signed" is derived from these. */
  buyerSignature: text('buyer_signature'),
  sellerSignature: text('seller_signature'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  failureCode: text('failure_code'),
  failureDetail: text('failure_detail'),
  /** sha256 hex of the ordered signed bid log; also inside the memo so the chain anchors it. */
  bidLogHash: text('bid_log_hash'),
  /** `hp:settle:<settlement uuid>:<bidLogHash>`, the memo instruction text of the settlement transaction. */
  memo: text('memo'),
  /** Creator royalty carved out of the seller's proceeds when the asset's Core Royalties plugin asks for one (0 = none). */
  royaltyAmount: bigint('royalty_amount', { mode: 'bigint' }).default(sql`0`).notNull(),
  royaltyRecipient: text('royalty_recipient'),
  /** Round history for strike attribution ({ v: 1, rounds: [{ attempt, buyerSignedAt?, sellerSignedAt? }] }) and rail breadcrumbs. Never holds signatures. */
  railState: jsonb('rail_state'),
}, (t) => ({
  /** The same transaction can never be recorded twice. */
  uniqueTx: uniqueIndex('settlements_tx_idx').on(t.txSignature),
  byLot: index('settlements_lot_idx').on(t.lotId),
  /** One live settlement per lot: two winners for one card cannot both be awaiting payment. */
  oneActivePerLot: uniqueIndex('settlements_one_active_per_lot').on(t.lotId).where(sql`status in ('awaiting_payment','awaiting_seller','submitted','settled')`),
  byStatusDue: index('settlements_status_due_idx').on(t.status, t.dueAt),
}));

/**
 * Room chat (FEATURE_CHAT, default off), PRE-MODERATED by the room operator (the show's seller; for the house show the platform
 * operator list). A message is stored `pending` and is not public. The operator sees everything and approves, rejects, mutes or
 * blocks; the public list shows `approved` only, and the author sees their own pending or rejected message. The table predates the
 * feature (the inherited streaming app never wrote to it); the columns after `createdAt` were added by migration 0003.
 */
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).notNull(),
  authorId: uuid('author_id').references(() => profiles.id).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  /** Strictly increasing read cursor. */
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  lotId: uuid('lot_id').references(() => lots.id),
  /** Shown instead of the wallet. Denormalised so the public list needs no join. */
  paddleNumber: integer('paddle_number'),
  lotNumber: integer('lot_number'),
  /** 'bidder' | 'seller' | 'house'. */
  role: text('role').default('bidder').notNull(),
  /** 'user' (typed by the author) | 'assistant' (an AI answer the operator chose to publish; shown labelled as AI). */
  source: text('source').default('user').notNull(),
  /** 'pending' (waiting for the operator, visible to the author only) | 'approved' (public) | 'rejected'. */
  status: text('status').default('pending').notNull(),
  moderatedAt: timestamp('moderated_at', { withTimezone: true }),
  moderatedBy: uuid('moderated_by').references(() => profiles.id),
  /** The reason shown to the author of a rejected message. */
  hiddenReason: text('hidden_reason'),
  /** Client-chosen id: the same message posted twice (a retry) is stored once. */
  clientNonce: text('client_nonce'),
}, (t) => ({
  byShow: index('chat_show_idx').on(t.showId, t.createdAt),
  bySeq: index('chat_seq_idx').on(t.showId, t.seq),
  /** The public list and the operator queue both read by (show, status, seq). */
  byStatus: index('chat_status_idx').on(t.showId, t.status, t.seq),
  byCreated: index('chat_created_idx').on(t.createdAt),
  oncePerNonce: uniqueIndex('chat_nonce_idx').on(t.authorId, t.clientNonce).where(sql`client_nonce is not null`),
}));

/** A user's report of a chat message (DSA notice, small). The operator sees the count next to the message. */
export const chatReports = pgTable('chat_reports', {
  id: uuid('id').defaultRandom().primaryKey(),
  messageId: uuid('message_id').references(() => chatMessages.id, { onDelete: 'cascade' }).notNull(),
  reporterId: uuid('reporter_id').references(() => profiles.id),
  /** 'illegal' | 'spam' | 'harassment' | 'scam' | 'other'. */
  reason: text('reason').notNull(),
  detail: text('detail'),
  /** 'open' | 'actioned' | 'dismissed'. */
  status: text('status').default('open').notNull(),
  handledBy: uuid('handled_by').references(() => profiles.id),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  oncePerReporter: uniqueIndex('chat_reports_once_idx').on(t.messageId, t.reporterId),
}));

/**
 * The operator silenced one wallet in one show. kind 'mute' lasts until `until`; kind 'block' has no end (`until` is null) and
 * lasts for the show. A muted or blocked wallet can still read, and posts nothing.
 */
export const chatMutes = pgTable('chat_mutes', {
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).notNull(),
  profileId: uuid('profile_id').references(() => profiles.id).notNull(),
  kind: text('kind').default('mute').notNull(),
  until: timestamp('until', { withTimezone: true }),
  reason: text('reason').notNull(),
  by: uuid('by').references(() => profiles.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: uniqueIndex('chat_mutes_pk').on(t.showId, t.profileId),
}));

/**
 * The event log the live feed reads from.
 *
 * Replaces Supabase Realtime. Clients hold an SSE connection and poll this table by cursor,
 * which is strictly better than the postgres_changes subscription it replaces: EventSource
 * reconnects on its own and replays from Last-Event-ID, so a viewer who drops out for ten
 * seconds catches up instead of silently missing the bids in between.
 */
export const showEvents = pgTable('show_events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byShowCursor: index('show_events_cursor_idx').on(t.showId, t.id) }));

/**
 * Presence as rows, not a counter.
 *
 * The old implementation wrote `streamViewers.size` from a module-scope Map inside a
 * serverless function, so each instance reported only the viewers it happened to hold. It was
 * already wrong on Vercel; next to a live auction it would be indefensible.
 */
export const showPresence = pgTable('show_presence', {
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).notNull(),
  viewerKey: text('viewer_key').notNull(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: uniqueIndex('presence_pk').on(t.showId, t.viewerKey),
  bySeen: index('presence_seen_idx').on(t.showId, t.lastSeen),
}));

/** Single-use login challenges. The piece the old wallet auth never had. */
export const authNonces = pgTable('auth_nonces', {
  nonce: text('nonce').primaryKey(),
  walletAddress: text('wallet_address').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({ byExpiry: index('auth_nonces_expiry_idx').on(t.expiresAt) }));

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorWallet: text('actor_wallet'),
  action: text('action').notNull(),
  target: text('target'),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** A bidder's registration for one show. Optionally carries a session key so bids need no popup. */
export const paddles = pgTable('paddles', {
  id: uuid('id').defaultRandom().primaryKey(),
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).notNull(),
  profileId: uuid('profile_id').references(() => profiles.id).notNull(),
  /** The number the room shows instead of the wallet. */
  number: integer('number').notNull(),
  /** ed25519 public key (base58) the wallet authorised to sign bids; null = popup per bid. */
  sessionPubkey: text('session_pubkey'),
  /** Ceiling the wallet signed for that key, USDC base units; null = balance is the only limit. */
  maxBid: bigint('max_bid', { mode: 'bigint' }),
  validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  /** The wallet-signed PaddleAuthV1 message and signature, kept so a disputed bid can be rebuilt. */
  authMessage: text('auth_message').notNull(),
  authSignature: text('auth_signature').notNull(),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
  onePerShow: uniqueIndex('paddles_show_profile_idx').on(t.showId, t.profileId),
  numberInShow: uniqueIndex('paddles_show_number_idx').on(t.showId, t.number),
}));

/** Fixed-window counters for routes that must not be hammered (bid, auth, faucet, mint). */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  count: integer('count').default(0).notNull(),
}, (t) => ({
  pk: uniqueIndex('rate_limits_pk').on(t.key, t.windowStart),
}));

/** Devnet demo cards minted by /api/devnet/mint-card, so the seller's picker and the metadata URI need no storage account. */
export const devnetAssets = pgTable('devnet_assets', {
  mint: text('mint').primaryKey(),
  ownerWallet: text('owner_wallet').notNull(),
  name: text('name').notNull(),
  imageUrl: text('image_url'),
  attributes: jsonb('attributes').notNull(),
  mintedAt: timestamp('minted_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ byOwner: index('devnet_assets_owner_idx').on(t.ownerWallet) }));

/** Kill switches and knobs that must change without a redeploy (env vars only apply to new deployments). */
export const appFlags = pgTable('app_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Verifiable randomness (FEATURE_VRF). One row per draw: the committed input, the beacon, the proof and the result.
 * Unique per (purpose, subject), so a draw cannot be repeated until it comes out right. Tx bytes and lease are server-only
 * (never in an API answer). purpose: lot_order | raffle | pack_draw. status: pending | committed | revealed | defaulted.
 */
export const vrfRequests = pgTable('vrf_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  purpose: text('purpose').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  cluster: text('cluster').notNull(),
  publicKey: text('public_key').notNull(),
  params: jsonb('params').notNull(),
  paramsHash: text('params_hash').notNull(),
  status: text('status').default('pending').notNull(),
  revealBy: timestamp('reveal_by', { withTimezone: true }).notNull(),
  attempts: integer('attempts').default(0).notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  commitTxB64: text('commit_tx_b64'),
  commitSignature: text('commit_signature'),
  commitSlot: bigint('commit_slot', { mode: 'number' }),
  beaconSlot: bigint('beacon_slot', { mode: 'number' }),
  beaconBlockhash: text('beacon_blockhash'),
  alphaText: text('alpha_text'),
  proofHex: text('proof_hex'),
  outputHex: text('output_hex'),
  revealTxB64: text('reveal_tx_b64'),
  revealSignature: text('reveal_signature'),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revealedAt: timestamp('revealed_at', { withTimezone: true }),
  defaultedAt: timestamp('defaulted_at', { withTimezone: true }),
}, (t) => ({
  uniqueSubject: uniqueIndex('vrf_requests_subject_idx').on(t.purpose, t.subjectType, t.subjectId),
  open: index('vrf_requests_open_idx').on(t.status, t.revealBy),
}));

/**
 * Packs (FEATURE_PACKS). Hammerprice is the technical INTERMEDIARY: a pack operator (a seller, or the house) defines a pack with
 * a pool of REAL cards they own and published odds. The pool and the rules are committed up front (`pool_hash`), the draw is an
 * ECVRF draw with a public proof, and delivery uses the same atomic co-sign rail as an auction (the buyer pays USDC to the
 * operator and the drawn card moves from the operator's wallet to the buyer in ONE transaction), so the platform holds neither
 * the money nor the card. mode: 'chance' (tiers with published odds) | 'equal_value' (every card has the same listed value,
 * reveal-only entertainment). status: draft | live | paused | sold_out | closed. After `committed_at` nobody changes the pool.
 */
export const packDefinitions = pgTable('pack_definitions', {
  id: uuid('id').defaultRandom().primaryKey(),
  operatorProfileId: uuid('operator_profile_id').references(() => profiles.id).notNull(),
  operatorWallet: text('operator_wallet').notNull(),
  /** True for the platform's own packs (the operator wallet is then the house seller). */
  isHouse: boolean('is_house').default(false).notNull(),
  /** { de, en } */
  name: jsonb('name').notNull(),
  description: jsonb('description'),
  imageUrl: text('image_url'),
  mode: text('mode').notNull(),
  cluster: text('cluster').notNull(),
  /** USDC base units per pack. */
  price: bigint('price', { mode: 'bigint' }).notNull(),
  /** [{ tier, label: { de, en }, bps }]; for 'chance' the bps add up to 10000, for 'equal_value' there is one tier. */
  odds: jsonb('odds').notNull(),
  oddsHash: text('odds_hash'),
  /** sha256 over the canonical list of (asset, tier, value) plus the odds, price and mode: the commitment published before the first sale. */
  poolHash: text('pool_hash'),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  status: text('status').default('draft').notNull(),
  /** How many packs one wallet may buy per UTC day from this definition. */
  perWalletDailyCap: integer('per_wallet_daily_cap').default(5).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byStatus: index('pack_definitions_status_idx').on(t.status, t.createdAt),
  byOperator: index('pack_definitions_operator_idx').on(t.operatorProfileId),
}));

/** One real card in a pack's pool. status: available | reserved (a draw is waiting for its signatures) | drawn | removed (before the commitment only). */
export const packPoolCards = pgTable('pack_pool_cards', {
  id: uuid('id').defaultRandom().primaryKey(),
  packId: uuid('pack_id').references(() => packDefinitions.id, { onDelete: 'cascade' }).notNull(),
  /** The Core asset address; the operator must own it at draw time. */
  asset: text('asset').notNull(),
  tier: text('tier').notNull(),
  name: text('name').notNull(),
  imageUrl: text('image_url'),
  /** Listed value in USDC base units; the same for every card of an 'equal_value' pack, optional for 'chance'. */
  listedValue: bigint('listed_value', { mode: 'bigint' }),
  attributes: jsonb('attributes'),
  /** The place in the committed list. */
  position: integer('position').notNull(),
  status: text('status').default('available').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  oncePerPack: uniqueIndex('pack_pool_cards_asset_idx').on(t.packId, t.asset),
  byTier: index('pack_pool_cards_tier_idx').on(t.packId, t.status, t.tier),
}));

/**
 * One purchase and draw. Carries the verifiable draw (input, proof, output, the card it selected) and its own signing round.
 * Two flows (`flow`):
 *  - 'atomic' (equal_value packs, and draws made before migration 0005): the buyer and the operator sign one message, the settlement authority
 *    only pays fees. status: reserved (card reserved, waiting for signatures) | submitted | settled | failed | expired.
 *  - 'pay_first' (chance packs; third-party operators, or the devnet house demo): the buyer pays first and NO card exists until that payment is finalized on chain.
 *    status: awaiting_payment (no card, no draw) | confirming (payment sent) | paid (payment finalized, draw pending) | drawn (card chosen, delivery
 *    pending) | delivering (delivery transaction sent) | settled (delivered) | refund_pending | refunding | refunded | expired (never paid) | failed |
 *    undelivered (A14: the third-party operator did not deliver in time or moved the card; it can still be delivered late unless the card is gone).
 * `draw_index` is null until the draw is made (pay_first), so the indexes of made draws are gapless and in draw order.
 */
export const packDraws = pgTable('pack_draws', {
  id: uuid('id').defaultRandom().primaryKey(),
  packId: uuid('pack_id').references(() => packDefinitions.id).notNull(),
  buyerProfileId: uuid('buyer_profile_id').references(() => profiles.id).notNull(),
  buyerWallet: text('buyer_wallet').notNull(),
  cluster: text('cluster').notNull(),
  /** Per pack and strictly increasing: the nth draw of this pack. Null for a pay_first purchase until its draw is made. */
  drawIndex: integer('draw_index'),
  /** The buyer's 18+ confirmation, recorded before the draw. */
  ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }).notNull(),
  clientSeed: text('client_seed').notNull(),
  vrfRequestId: uuid('vrf_request_id').references(() => vrfRequests.id),
  /** The exact text the proof was made over (it names the pool hash, the buyer, the seed, the index and the beacon). */
  vrfInput: text('vrf_input'),
  proofHex: text('proof_hex'),
  outputHex: text('output_hex'),
  tier: text('tier'),
  cardId: uuid('card_id').references(() => packPoolCards.id),
  asset: text('asset'),
  /** USDC base units paid. */
  price: bigint('price', { mode: 'bigint' }).notNull(),
  status: text('status').default('reserved').notNull(),
  /** `hp:pack:<draw uuid>:<pool hash>`, the memo of the settlement transaction (the reference between draw and chain). */
  settlementRef: text('settlement_ref'),
  attempt: integer('attempt').default(1).notNull(),
  preparedMessage: text('prepared_message'),
  preparedBlockhash: text('prepared_blockhash'),
  lastValidHeight: bigint('last_valid_height', { mode: 'number' }),
  roundExpiresAt: timestamp('round_expires_at', { withTimezone: true }),
  buyerSignature: text('buyer_signature'),
  operatorSignature: text('operator_signature'),
  txSignature: text('tx_signature'),
  failureCode: text('failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  /** 'atomic' | 'pay_first' (migration 0005). */
  flow: text('flow').default('atomic').notNull(),
  /** The slot the payment landed in (pay_first); the beacon of the draw is the first block after it. */
  paymentSlot: bigint('payment_slot', { mode: 'number' }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  drawnAt: timestamp('drawn_at', { withTimezone: true }),
  refundedAt: timestamp('refunded_at', { withTimezone: true }),
  /** The card transfer operator -> buyer (house signed) and the USDC return house -> buyer; each id is unique, so one transaction can end one draw only. */
  deliverySignature: text('delivery_signature'),
  refundSignature: text('refund_signature'),
  /** The wire bytes (base64) and last valid height of the delivery or refund transaction currently in flight; only one is ever in flight. */
  serverTx: text('server_tx'),
  serverLastValid: bigint('server_last_valid', { mode: 'number' }),
  deliveryAttempts: integer('delivery_attempts').default(0).notNull(),
  refundAttempts: integer('refund_attempts').default(0).notNull(),
  /** Back-off for the retries of the server side steps (draw, delivery, refund); null means now. */
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  refundReason: text('refund_reason'),
  /** A14 (migration 0006): the operator must deliver the drawn card before this time (third-party chance packs; null for the house demo and the atomic flow). */
  deliverBy: timestamp('deliver_by', { withTimezone: true }),
  /** Set when the draw was marked `undelivered` (stays set when the card was delivered late) and why: deadline | asset_moved | asset_not_transferable | pool_empty. */
  undeliveredAt: timestamp('undelivered_at', { withTimezone: true }),
  undeliveredReason: text('undelivered_reason'),
  /** Set when this draw cost its operator a strike (at most one strike per operator per delivery deadline). */
  strikeAt: timestamp('strike_at', { withTimezone: true }),
}, (t) => ({
  oncePerIndex: uniqueIndex('pack_draws_index_idx').on(t.packId, t.drawIndex),
  /** One live draw per card: two buyers cannot both be waiting to receive the same card. */
  oneActivePerCard: uniqueIndex('pack_draws_card_idx').on(t.cardId).where(sql`status in ('reserved','submitted','settled')`),
  uniqueTx: uniqueIndex('pack_draws_tx_idx').on(t.txSignature),
  /** pay_first: a card is held by one draw from the moment it is chosen until it is delivered or the buyer is refunded. */
  oneLivePerCard: uniqueIndex('pack_draws_card_live_idx').on(t.cardId).where(sql`status in ('drawn','delivering','settled','refund_pending','refunding')`),
  /** A14: the same rule including `undelivered` (a reserved card of a draw the operator has not delivered yet is held by that draw only). */
  oneHeldPerCard: uniqueIndex('pack_draws_card_held_idx').on(t.cardId).where(sql`status in ('drawn','delivering','settled','refund_pending','refunding','undelivered')`),
  byDeliverBy: index('pack_draws_deliver_by_idx').on(t.status, t.deliverBy),
  uniqueDelivery: uniqueIndex('pack_draws_delivery_tx_idx').on(t.deliverySignature),
  uniqueRefund: uniqueIndex('pack_draws_refund_tx_idx').on(t.refundSignature),
  byStatus: index('pack_draws_status_idx').on(t.status, t.nextAttemptAt),
  byBuyer: index('pack_draws_buyer_idx').on(t.buyerProfileId, t.createdAt),
}));

/** Packs bought per wallet, pack and UTC day: the per-wallet daily cap reads and increments this. */
export const packPurchaseCounts = pgTable('pack_purchase_counts', {
  wallet: text('wallet').notNull(),
  packId: uuid('pack_id').references(() => packDefinitions.id).notNull(),
  day: date('day', { mode: 'string' }).notNull(),
  count: integer('count').default(0).notNull(),
}, (t) => ({
  pk: uniqueIndex('pack_purchase_counts_pk').on(t.wallet, t.packId, t.day),
}));

/**
 * AI listing credits (FEATURE_AI). `credit_ledger` is the only source of a balance (the sum of `delta`); purchases are
 * bookkeeping for the on-chain payment, usage rows are budget bookkeeping. No prompt and no image is ever stored.
 */
export const creditPurchases = pgTable('credit_purchases', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').references(() => profiles.id).notNull(),
  wallet: text('wallet').notNull(),
  cluster: text('cluster').notNull(),
  credits: integer('credits').notNull(),
  /** USDC base units. */
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  /** quoted | submitted | settled | failed | expired */
  status: text('status').default('quoted').notNull(),
  preparedMessage: text('prepared_message'),
  preparedBlockhash: text('prepared_blockhash'),
  lastValidHeight: bigint('last_valid_height', { mode: 'number' }),
  roundExpiresAt: timestamp('round_expires_at', { withTimezone: true }),
  txSignature: text('tx_signature'),
  memo: text('memo'),
  failureCode: text('failure_code'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => ({
  uniqueTx: uniqueIndex('credit_purchases_tx_idx').on(t.txSignature),
}));

export const creditLedger = pgTable('credit_ledger', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').references(() => profiles.id).notNull(),
  delta: integer('delta').notNull(),
  /** purchase | usage | refund | grant */
  reason: text('reason').notNull(),
  /** The purchase id or the request id. */
  ref: text('ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  /** Idempotency: the same (reason, ref) is booked once. */
  uniqueRef: uniqueIndex('credit_ledger_ref_idx').on(t.reason, t.ref),
  byProfile: index('credit_ledger_profile_idx').on(t.profileId),
}));

export const aiUsage = pgTable('ai_usage', {
  id: uuid('id').defaultRandom().primaryKey(),
  profileId: uuid('profile_id').references(() => profiles.id),
  requestId: text('request_id').notNull(),
  /** listing | ask | agent */
  kind: text('kind').notNull(),
  model: text('model').notNull(),
  /** 'gemini-api' | 'vertex' (AI_PROVIDER); null for a template draft. */
  provider: text('provider'),
  cluster: text('cluster'),
  /** reserved | ok | error | refused | template */
  status: text('status').notNull(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  /** Gemini bills thinking tokens as output. */
  thinkingTokens: integer('thinking_tokens'),
  /** The reservation first, then the actual cost, in millionths of a US dollar. */
  costMicroUsd: integer('cost_micro_usd').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqueRequest: uniqueIndex('ai_usage_req_idx').on(t.kind, t.requestId),
  byDay: index('ai_usage_day_idx').on(t.createdAt),
}));

/**
 * Telegram (FEATURE_TELEGRAM, migration 0004). A wallet's profile is bound to ONE private chat; only the chat id, the language and the
 * opt-in switches are stored, never a name, a phone number or a message. Created when the user taps Start on the one-time deep link.
 */
export const telegramLinks = pgTable('telegram_links', {
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).primaryKey(),
  /** Telegram chat ids fit in 52 bits, so a JS number is exact. One profile per chat. */
  chatId: bigint('chat_id', { mode: 'number' }).notNull(),
  /** 'en' | 'de', the language of the messages (the UI language when the link was made, kept in step by the account page). */
  locale: text('locale').default('en').notNull(),
  /** { outbid, ending_soon, won, settled, show_start, deadline, moderation, pack_delivery }: booleans, opt-in per type (contracts/telegram.ts). */
  prefs: jsonb('prefs').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byChat: uniqueIndex('telegram_links_chat_idx').on(t.chatId),
}));

/** The one-time link token: only its sha-256 is stored, it lives 10 minutes and works once. The wallet is bound by `profile_id`. */
export const telegramLinkTokens = pgTable('telegram_link_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  locale: text('locale').default('en').notNull(),
  prefs: jsonb('prefs').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  byProfile: index('telegram_link_tokens_profile_idx').on(t.profileId),
  byExpiry: index('telegram_link_tokens_expiry_idx').on(t.expiresAt),
}));

/** "This notification was sent" markers (kind + our own object id, no text), so a retry, a sweep and a hook never send one twice. Deleted when the user unlinks. */
export const telegramSent = pgTable('telegram_sent', {
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),
  ref: text('ref').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  once: uniqueIndex('telegram_sent_once_idx').on(t.profileId, t.kind, t.ref),
  bySent: index('telegram_sent_at_idx').on(t.sentAt),
}));

/**
 * "Alert me when the next lots of this room open" (Telegram /watch, migration 0008). One row per profile and show. `remaining` is how many
 * more lot alerts to send (null = every lot until the show ends); the row goes when it reaches 0, when the show ends, or on /unwatch. No lot is
 * ever bid on from here: this table only says who gets a message.
 */
export const telegramWatches = pgTable('telegram_watches', {
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  showId: uuid('show_id').references(() => shows.id, { onDelete: 'cascade' }).notNull(),
  remaining: integer('remaining'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.profileId, t.showId] }),
  byShow: index('telegram_watches_show_idx').on(t.showId),
}));

/**
 * Waiting list (migration 0009): an email address left on the landing page, with the language it was left in. Consent (Art. 6(1)(a) GDPR)
 * is the act of submitting the form; the row is deleted on request. The unique index is on lower(email), so one address is one row.
 */
export const waitlist = pgTable('waitlist', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(),
  locale: text('locale').notNull(),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqueEmail: uniqueIndex('waitlist_email_lower_idx').on(sql`lower(${t.email})`),
}));

/*
 * Dropped from the Supabase schema, deliberately:
 *   chat_emotes        cosmetic, two references
 *   chat_rate_limits   zero references in src; rate limiting was an in-memory Map anyway,
 *                      and the table carried six RLS policies for nothing
 *   stream_likes       engagement fluff plus two triggers
 *   platform_fees      a table for a number that never changes; now one constant
 *   platform_videos    part of the deleted tipping/showcase surface
 *   video_archives     no archive product in v1
 *   feature_flags      env vars until there is a reason (the reason arrived: kill switches, see app_flags)
 *   system_settings    same
 */
