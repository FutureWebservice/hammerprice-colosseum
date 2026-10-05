/**
 * Packs (FEATURE_PACKS, default off), contract only. A pack operator defines a pack with a pool of REAL cards they own and published odds.
 * The pool and the rules are committed up front (`commitment.poolHash`), nobody changes the pool after the first sale, and the draw is an
 * ECVRF draw with a public proof (vrf.ts, verifiable on /verify). There are two flows, by `mode`:
 *
 *  - mode `equal_value` (every card has the same listed value, so there is nothing to cherry-pick; any operator): the ATOMIC co-sign rail of an
 *    auction. The card is drawn when the draw is opened, and the buyer pays the operator and the card moves to the buyer in ONE transaction,
 *    so the platform holds neither money nor card.
 *  - mode `chance` (tiers with published odds, bps add up to 10000; run by a THIRD-PARTY operator who owns the cards, or by the house as the devnet
 *    demo only): PAY FIRST, DRAW AFTER. The buyer pays the pack price DIRECTLY to the operator wallet (plus the platform fee leg to the fee wallet)
 *    first; nothing goes to a platform-held wallet. No card is chosen or revealed anywhere until that payment is finalized on chain; then the draw
 *    runs with an input that contains the payment signature and a block that did not exist at payment time; the OPERATOR delivers the drawn card in a
 *    second transaction that they sign within a deadline. The platform cannot refund (it holds no money): a draw the operator does not deliver is
 *    `undelivered`, strikes the operator and pauses the pack, and the buyer keeps the payment signature and the proof to claim against the operator.
 *
 * Safety rails the contract carries: the 18+ confirmation (`ageConfirmed`), a per-wallet daily cap, odds and pool visible before buying,
 * a paused pack, a pack that stops when its pool is empty.
 */
import { z } from 'zod';
import { Amount, Cluster, IsoTime, Sha256Hex, TxBase64, TxSignature, Uuid, Wallet } from './common';
import { SIGN_STEPS } from './chain';
import { VrfStatus } from './vrf';

export const PackMode = z.enum(['chance', 'equal_value']);
/** draft (operator only) -> live <-> paused -> sold_out (pool empty) or closed (operator ended it). */
export const PackStatus = z.enum(['draft', 'live', 'paused', 'sold_out', 'closed']);
export type PackMode = z.infer<typeof PackMode>;
export type PackStatus = z.infer<typeof PackStatus>;

const Localized = z.object({ de: z.string().trim().min(1).max(120), en: z.string().trim().min(1).max(120) }).strict();
const LocalizedLong = z.object({ de: z.string().trim().min(1).max(600), en: z.string().trim().min(1).max(600) }).strict();
const Tier = z.string().regex(/^[a-z0-9_-]{1,24}$/);
const HttpsUrl = z.string().url().max(500).refine((u) => u.startsWith('https://'), 'https only');

/** One rarity tier with its published odds in basis points. */
export const PackTierOdds = z.object({ tier: Tier, label: Localized, bps: z.number().int().min(1).max(10000) }).strict();
export const PackOddsList = z
  .array(PackTierOdds)
  .min(1)
  .max(8)
  .refine((o) => o.reduce((n, t) => n + t.bps, 0) === 10000, 'the odds must add up to 10000 bps')
  .refine((o) => new Set(o.map((t) => t.tier)).size === o.length, 'duplicate tier');

/** A card an operator puts into the pool (own Core asset). */
export const PackPoolCardInput = z
  .object({
    asset: Wallet,
    tier: Tier,
    name: z.string().trim().min(1).max(120),
    imageUrl: HttpsUrl.optional(),
    /** Listed value in USDC base units: required for 'equal_value' (and then identical for all cards), optional for 'chance'. */
    listedValue: Amount.optional(),
    attributes: z.record(z.unknown()).optional(),
  })
  .strict();

/** `POST /api/packs`: creates a draft. The pool is committed and the pack goes live with `control: publish`. */
export const PackCreateRequest = z
  .object({
    name: Localized,
    description: LocalizedLong.optional(),
    imageUrl: HttpsUrl.optional(),
    mode: PackMode,
    /** USDC base units per pack. */
    price: Amount,
    odds: PackOddsList,
    cards: z.array(PackPoolCardInput).min(1).max(500),
    perWalletDailyCap: z.number().int().min(1).max(50).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const tiers = new Set(p.odds.map((t) => t.tier));
    if (p.price === '0') ctx.addIssue({ code: 'custom', path: ['price'], message: 'the price must be above zero' });
    if (new Set(p.cards.map((c) => c.asset)).size !== p.cards.length) ctx.addIssue({ code: 'custom', path: ['cards'], message: 'a card is in the pool twice' });
    p.cards.forEach((c, i) => { if (!tiers.has(c.tier)) ctx.addIssue({ code: 'custom', path: ['cards', i, 'tier'], message: 'unknown tier' }); });
    if (p.mode === 'equal_value') {
      if (p.odds.length !== 1) ctx.addIssue({ code: 'custom', path: ['odds'], message: 'an equal-value pack has one tier' });
      const values = new Set(p.cards.map((c) => c.listedValue));
      if (values.size !== 1 || values.has(undefined)) ctx.addIssue({ code: 'custom', path: ['cards'], message: 'every card of an equal-value pack carries the same listed value' });
    }
  });

/** What the public sees of a tier: its odds and how many cards are left in it. */
export const PackTierView = z
  .object({ tier: Tier, label: Localized, bps: z.number().int().min(1).max(10000), remaining: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
  .strict();

/** The public delivery record of a pack operator (all their chance packs on this network): what a buyer checks before paying them directly. */
export const PackOperatorRecord = z
  .object({
    /** Cards delivered (includes the late ones). */
    delivered: z.number().int().nonnegative(),
    /** Of those, delivered after the deadline had passed. */
    late: z.number().int().nonnegative(),
    /** Draws not delivered (deadline missed, or the card was moved away) and still not delivered. */
    undelivered: z.number().int().nonnegative(),
    /** Median seconds from the finalized payment to the delivered card; null until there is a delivery. */
    medianDeliverySeconds: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type PackOperatorRecord = z.infer<typeof PackOperatorRecord>;

export const PackView = z
  .object({
    id: Uuid,
    name: Localized,
    description: LocalizedLong.nullable(),
    imageUrl: z.string().nullable(),
    mode: PackMode,
    status: PackStatus,
    cluster: Cluster,
    /** USDC base units per pack. */
    price: Amount,
    operator: z.object({ wallet: Wallet, isHouse: z.boolean() }).strict(),
    odds: z.array(PackTierView).min(1),
    pool: z.object({ total: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() }).strict(),
    /** The hashes published before the first sale; null while the pack is a draft. */
    commitment: z.object({ poolHash: Sha256Hex.nullable(), oddsHash: Sha256Hex.nullable(), committedAt: IsoTime.nullable() }).strict(),
    perWalletDailyCap: z.number().int().positive(),
    /** Additive (A14): the operator's public delivery record on this network, shown before a buyer pays. Null for the house demo and for packs read without it. */
    operatorRecord: PackOperatorRecord.nullable().optional(),
    /** The ECVRF public key the draws verify against (null while the VRF is off). */
    vrfPublicKey: Wallet.nullable(),
    createdAt: IsoTime,
  })
  .strict();
export type PackView = z.infer<typeof PackView>;
export type PackPoolCardView = z.infer<typeof PackPoolCardView>;

/** `GET /api/packs` and `GET /api/packs/mine` (the latter includes the caller's drafts). */
export const PacksResponse = z.object({ packs: z.array(PackView) }).strict();

export const PackPoolCardView = z
  .object({
    id: Uuid,
    position: z.number().int().nonnegative(),
    asset: Wallet,
    tier: Tier,
    name: z.string(),
    imageUrl: z.string().nullable(),
    listedValue: Amount.nullable(),
    /** Additive: grading company and grade when the operator gave them. */
    grade: z.string().nullable().optional(),
    /** `removed` (additive, PACKS): the operator no longer held the card when it was drawn, so it was taken out of the pool. A card reserved for a buyer still waiting to pay shows as `available`. */
    status: z.enum(['available', 'reserved', 'drawn', 'removed']),
  })
  .strict();

/** `GET /api/packs/:id`: the pack, its full pool (once committed) and the odds table. Visible before anyone buys. */
export const PackDetailResponse = z.object({ pack: PackView, cards: z.array(PackPoolCardView) }).strict();

export const PackControlRequest = z.object({ action: z.enum(['publish', 'pause', 'resume', 'close']) }).strict();
export const PackControlResponse = z.object({ pack: PackView }).strict();

/** `POST /api/packs/:id/open`. The 18+ confirmation is part of the request and is stored with the draw. */
export const PackOpenRequest = z.object({ clientSeed: z.string().regex(/^[0-9a-f]{32}$/), ageConfirmed: z.literal(true) }).strict();

/** Where a purchase is, in both flows. The pay_first states (additive, migration 0005) are listed after the atomic ones. `settled` means the card was delivered. */
export const PACK_DRAW_STATUSES = [
  'reserved', 'submitted', 'settled', 'failed', 'expired',
  'awaiting_payment', 'confirming', 'paid', 'drawn', 'delivering',
  /** A14: the operator did not deliver in time (or moved the card). It can still be delivered late unless the card is gone. */
  'undelivered',
  /** The devnet house DEMO: the payment was real (test USDC), the draw is real (ECVRF), the pool card stays in the house wallet and a COPY of it is minted into the buyer's wallet (its transaction is `deliverySignature`). Terminal; nothing waits, no strike, no deadline. */
  'demo_revealed',
] as const;
export const PackDrawStatus = z.enum(PACK_DRAW_STATUSES);
export type PackDrawStatus = z.infer<typeof PackDrawStatus>;

/** The verifiable draw: anyone recomputes the tier and the card from `vrf` and the committed pool (page /verify/random/:id). */
export const PackDrawView = z
  .object({
    id: Uuid,
    packId: Uuid,
    /** Null until the draw is made (pay_first: after the payment is finalized). */
    drawIndex: z.number().int().nonnegative().nullable(),
    status: PackDrawStatus,
    cluster: Cluster,
    buyer: Wallet,
    clientSeed: z.string().regex(/^[0-9a-f]{32}$/),
    poolHash: Sha256Hex,
    vrf: z
      .object({
        requestId: Uuid.nullable(),
        status: VrfStatus.nullable(),
        /** The exact text the proof was made over (the six-line alpha of lib/vrf/alpha.ts). null while the draw is hidden (see `revealed`). */
        input: z.string().nullable(),
        proofHex: z.string().regex(/^[0-9a-f]{160}$/).nullable(),
        outputHex: z.string().regex(/^[0-9a-f]{128}$/).nullable(),
        /** Additive (PACKS): what the alpha's `params` hash commits to (pack, pool hash, buyer, seed, index, the positions taken at that moment), its hash, the beacon and the key. */
        params: z.record(z.unknown()).nullable().optional(),
        paramsHash: Sha256Hex.nullable().optional(),
        beacon: z.object({ slot: z.number().int().positive(), blockhash: z.string().min(32).max(44) }).strict().nullable().optional(),
        publicKey: Wallet.nullable().optional(),
      })
      .strict(),
    /** Additive (PACKS): false while the draw is still waiting for the payment signatures. The result is fixed from the moment of the draw but is shown only after the payment settled (or the draw ended unpaid). */
    revealed: z.boolean().optional(),
    tier: Tier.nullable(),
    card: z.object({ asset: Wallet, name: z.string(), imageUrl: z.string().nullable(), tier: Tier, /** Additive: grading company and grade when the operator gave them (for example `PSA 10`). */ grade: z.string().nullable().optional() }).strict().nullable(),
    /** USDC base units. */
    price: Amount,
    /** `hp:pack:<draw uuid>:<pool hash>`, also the memo of the settlement transaction. */
    settlementRef: z.string().nullable(),
    /** The payment (pay_first) or the one atomic transaction (atomic). */
    txSignature: TxSignature.nullable(),
    createdAt: IsoTime,
    /** The moment the card was delivered. */
    settledAt: IsoTime.nullable(),
    /** Additive (migration 0005). 'pay_first': the buyer pays first and the card does not exist before that payment is finalized. */
    flow: z.enum(['atomic', 'pay_first']).optional(),
    /** pay_first: the delivery transaction (card, operator to buyer); null until it exists. Demo draw: the transaction that minted the copy into the buyer's wallet (null when none was minted). */
    deliverySignature: TxSignature.nullable().optional(),
    paidAt: IsoTime.nullable().optional(),
    /** pay_first: the slot the payment landed in (public chain data, shown before the result so the order of the draws can be checked while cards are not delivered yet). */
    paymentSlot: z.number().int().positive().nullable().optional(),
    /** pay_first: when the unpaid purchase lapses (`awaiting_payment` only). */
    expiresAt: IsoTime.nullable().optional(),
    /** Additive (A14). The operator the buyer paid directly: for an undelivered draw this is who to claim against, with `txSignature` (the payment) and the proof. */
    operator: z.object({ wallet: Wallet, isHouse: z.boolean() }).strict().optional(),
    /** pay_first, third-party: the operator must deliver before this time. */
    deliverBy: IsoTime.nullable().optional(),
    undeliveredAt: IsoTime.nullable().optional(),
    /** `deadline`, `asset_moved`, `asset_not_transferable` or `pool_empty`. */
    undeliveredReason: z.string().nullable().optional(),
  })
  .strict();
export type PackDrawView = z.infer<typeof PackDrawView>;

/** The one transaction both parties sign: buyer pays the operator and the platform fee, the operator's card moves to the buyer, the settlement authority pays fees. */
export const PackExpectedPayment = z
  .object({
    drawId: Uuid,
    cluster: Cluster,
    buyer: Wallet,
    operator: Wallet,
    asset: Wallet,
    collection: Wallet.nullable(),
    usdcMint: Wallet,
    gross: Amount,
    platformFee: Amount,
    royalty: Amount,
    royaltyRecipient: Wallet.nullable(),
    feeWallet: Wallet,
    feePayer: Wallet,
    memo: z.string(),
  })
  .strict();
/**
 * The PAY FIRST payment: the buyer pays the pack price to the operator (the house wallet) and the platform fee to the fee wallet, with a memo naming the
 * draw. There is NO card in it (no `asset`, no `collection`): at this point no card has been chosen. Required signers are exactly {fee payer, buyer}.
 */
export const PackPayExpected = z
  .object({
    drawId: Uuid,
    cluster: Cluster,
    buyer: Wallet,
    operator: Wallet,
    usdcMint: Wallet,
    gross: Amount,
    platformFee: Amount,
    feeWallet: Wallet,
    feePayer: Wallet,
    memo: z.string(),
  })
  .strict();
export type PackPayExpected = z.infer<typeof PackPayExpected>;

/**
 * The DELIVERY the pack operator signs (A14): the drawn card moves from the operator to the buyer, the settlement authority only pays the network fee.
 * Required signers are exactly {fee payer, operator}. `kind` tells it apart from the payments.
 */
export const PackDeliveryToSign = z
  .object({
    kind: z.literal('delivery'),
    drawId: Uuid,
    cluster: Cluster,
    buyer: Wallet,
    operator: Wallet,
    asset: Wallet,
    collection: Wallet.nullable(),
    feePayer: Wallet,
    memo: z.string(),
  })
  .strict();
export type PackDeliveryToSign = z.infer<typeof PackDeliveryToSign>;

export const PackPayment = z
  .object({
    /** The unsigned message, base64. The browser checks it against `expected` before it signs. */
    txBase64: TxBase64,
    /** The atomic payment (with the card), the pay-first payment (without any card), or the operator's delivery of the drawn card. */
    expected: z.union([PackExpectedPayment, PackPayExpected, PackDeliveryToSign]),
    lastValidBlockHeight: z.number().int().nonnegative(),
    roundExpiresAt: IsoTime,
    buyerSigned: z.boolean(),
    /** true for a house pack: the server already signed the operator leg. */
    operatorSigned: z.boolean(),
  })
  .strict();

export type PackExpectedPayment = z.infer<typeof PackExpectedPayment>;
export type PackPayment = z.infer<typeof PackPayment>;

/** The draw is made and the card reserved for this buyer; `payment` is the transaction to sign. */
export const PackOpenResponse = z.object({ draw: PackDrawView, payment: PackPayment }).strict();

/** `POST /api/packs/draws/:id/sign`: the same two-party signing as a settlement (`role: 'seller'` is the pack operator). */
export const PackSignResponse = z.object({ step: z.enum(SIGN_STEPS), draw: PackDrawView }).strict();
export type PackOpenResponse = z.infer<typeof PackOpenResponse>;
export type PackSignResponse = z.infer<typeof PackSignResponse>;

/** `GET /api/packs/:id/draws`: the public log of a pack's draws, newest first (additive, PACKS). Draws still waiting for signatures show no result. */
export const PackDrawsQuery = z.object({ cursor: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).strict();
export const PackDrawsResponse = z.object({ draws: z.array(PackDrawView), nextCursor: z.string().nullable() }).strict();
export type PackDrawsResponse = z.infer<typeof PackDrawsResponse>;

/** One sale the operator still has to deliver (A14): the card is visible to the operator only, after the draw. `GET /api/packs/deliveries`. */
export const PackDeliveryItem = z
  .object({
    draw: PackDrawView,
    packName: Localized,
    card: z.object({ asset: Wallet, name: z.string(), imageUrl: z.string().nullable(), tier: Tier }).strict(),
    deliverBy: IsoTime.nullable(),
    /** true once the deadline passed: it is `undelivered` and can still be delivered late. */
    late: z.boolean(),
  })
  .strict();
/** `GET /api/packs/operator`: who may offer a pack here (the same rules as the create route). `allowed` is null when nobody is signed in. */
export const PackOperatorAccess = z.object({ mode: z.enum(['open', 'invited', 'closed']), allowed: z.boolean().nullable() }).strict();
export type PackOperatorAccess = z.infer<typeof PackOperatorAccess>;
export const PackDeliveriesResponse = z.object({ deliveries: z.array(PackDeliveryItem) }).strict();
export type PackDeliveryItem = z.infer<typeof PackDeliveryItem>;
export type PackDeliveriesResponse = z.infer<typeof PackDeliveriesResponse>;

export type PackCreateRequest = z.infer<typeof PackCreateRequest>;
export type PackControlRequest = z.infer<typeof PackControlRequest>;
export type PackOpenRequest = z.infer<typeof PackOpenRequest>;
export type PackDetailResponse = z.infer<typeof PackDetailResponse>;
export type PacksResponse = z.infer<typeof PacksResponse>;
