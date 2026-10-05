/**
 * AI features (FEATURE_AI, default off), contract only. The provider is Google Gemini, called from the server only, either the Gemini
 * API with an API key (AI_PROVIDER=gemini-api, the default) or Vertex AI with a service account (AI_PROVIDER=vertex);
 * nothing here carries a key, a prompt or an image beyond the request that sends it. Every AI text is an AI draft that the
 * seller reviews, and the answers say so (`label`).
 *
 * Listing drafts are paid with prepaid credits (1 USDC buys 10): the credit purchase is an on-chain co-signed payment, verified
 * before the ledger books it. A call without credit answers 402 with `PaymentRequiredBody` (x402-style terms; the transport
 * headers of the x402 specification are not claimed).
 */
import { z } from 'zod';
import { Amount, Cluster, IsoTime, TxBase64, TxSignature, Uuid, Wallet } from './common';

/** What one pack costs and gives: 1 USDC = 10 listing drafts. The price is in USDC base units (6 dp). */
export const AI_PACK_CREDITS = 10;
export const AI_PACK_PRICE_USDC = '1000000';

export const AiCreditsResponse = z
  .object({
    balance: z.number().int().nonnegative(),
    pack: z.object({ credits: z.number().int().positive(), priceUsdc: Amount }).strict(),
    /** null = no daily pack limit on this cluster. */
    packsLeftToday: z.number().int().nonnegative().nullable(),
    cluster: Cluster,
    /** A model key is configured here; without one drafts come from a template and cost no credit. */
    configured: z.boolean(),
    /** AI_FREE: AI costs no credits (judging period). The balance and the purchase are not shown. */
    free: z.boolean().optional(),
  })
  .strict();

/** `POST /api/ai/credits/quote`: an unsigned transaction (fee payer = the settlement authority) the buyer checks and signs. */
export const AiCreditsQuoteRequest = z.object({}).strict();
export const AiCreditsQuoteResponse = z
  .object({
    purchaseId: Uuid,
    txBase64: TxBase64,
    expected: z
      .object({ feePayer: Wallet, buyer: Wallet, feeWallet: Wallet, mint: Wallet, amount: Amount, memo: z.string().min(1).max(120) })
      .strict(),
    roundExpiresAt: IsoTime,
  })
  .strict();

export const AiPurchaseStatus = z.enum(['quoted', 'submitted', 'settled', 'failed', 'expired']);
export const AiCreditsPayRequest = z.object({ purchaseId: Uuid, signedTxBase64: TxBase64 }).strict();
/** `POST /api/ai/credits/pay` and `GET /api/ai/credits/purchases/:id` (the GET finalises lazily). */
export const AiPurchaseView = z
  .object({
    purchaseId: Uuid,
    status: AiPurchaseStatus,
    balance: z.number().int().nonnegative(),
    txSignature: TxSignature.optional(),
    explorerUrl: z.string().url().optional(),
  })
  .strict();

const Text = (max: number) => z.string().trim().max(max);
export const AiListingFields = z
  .object({
    name: Text(120).min(1),
    setName: Text(120).optional(),
    gradingCompany: Text(60).optional(),
    grade: Text(20).optional(),
    gradingId: Text(60).optional(),
    /** The seller's own estimate, USDC base units. The opening-price suggestion is computed from it only. */
    estimateUsdc: Amount.optional(),
    notes: Text(600).optional(),
    locale: z.enum(['de', 'en']),
  })
  .strict();
export const AiImage = z.object({ mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']), dataBase64: z.string().min(1).max(820_000) }).strict();

export const AiListingRequest = z.object({ requestId: Uuid, fields: AiListingFields, images: z.array(AiImage).max(3).optional() }).strict();
export const AiListingDraft = z
  .object({
    titleDe: z.string().min(3).max(80),
    titleEn: z.string().min(3).max(80),
    descriptionDe: z.string().min(1).max(1500),
    descriptionEn: z.string().min(1).max(1500),
    suggestedOpeningUsdc: Amount.nullable(),
    rationale: z.string().max(400),
  })
  .strict();
export const AiListingResponse = z
  .object({ draft: AiListingDraft, source: z.enum(['model', 'template']), creditsLeft: z.number().int().nonnegative(), label: z.literal('ai_draft') })
  .strict();

/** The 402 body of `POST /api/ai/listing` without credit: pay `amount` of `asset` to `payTo` via the quote route. */
export const PaymentRequiredBody = z
  .object({
    ok: z.literal(false),
    code: z.literal('payment_required'),
    reason: z.string(),
    scheme: z.literal('exact'),
    network: z.string().min(1).max(40),
    amount: Amount,
    asset: Wallet,
    payTo: Wallet,
    maxTimeoutSeconds: z.number().int().positive(),
    extra: z.object({ feePayer: Wallet, memo: z.string().max(256).optional() }).strict(),
    quoteUrl: z.string().regex(/^\/api\//),
  })
  .strict();

/** `POST /api/ai/ask` (the room assistant): the model picks a FAQ key, the server returns the fixed FAQ text, never model prose. */
export const AiAskRequest = z.object({ question: Text(300).min(1), locale: z.enum(['de', 'en']) }).strict();
export const AiAskResponse = z
  .object({ answer: z.string().min(1).max(2000), faqKey: z.string().max(60).nullable(), source: z.enum(['ai', 'keyword']), label: z.enum(['ai', 'faq']) })
  .strict();

/**
 * `POST /api/ai/agent` (the chat agent on /ai). One message in, one answer out; the server keeps no history. The model only CHOOSES one of
 * three tools and their arguments; every sentence of the answer is composed by the server, and the cards carry public facts or the user's
 * own typed values. No tool changes anything: a bid proposal and a draft proposal are cards the user confirms with a click (the bid in the
 * room with the wallet, the draft through `POST /api/ai/listing`).
 */
export const AiAgentRequest = z
  .object({
    message: Text(300).min(1),
    locale: z.enum(['de', 'en']),
    /** The lots of the last search card the browser still shows, so "the second one" can be resolved. Public ids and names only. */
    lastResults: z.array(z.object({ lotId: Uuid, name: Text(120), lotNumber: z.number().int().positive().optional() }).strict()).max(8).optional(),
  })
  .strict();
const AgentLot = z
  .object({
    lotId: Uuid, showId: Uuid, showTitle: z.string().max(200), showStatus: z.enum(['live', 'scheduled']), lotNumber: z.number().int().positive(),
    name: z.string().max(200), setName: z.string().max(200).nullable(), grading: z.string().max(80).nullable(),
    state: z.enum(['open', 'catalogued']), priceUsdc: Amount, hasBid: z.boolean(),
    /** For the card: the lot's picture, when the bidding closes (open lots) and when the room starts (null when unscheduled). */
    imageUrl: z.string().max(500).nullable(), closesAt: z.string().max(40).nullable(), startsAt: z.string().max(40).nullable(),
  })
  .strict();
export const AiAgentCard = z.discriminatedUnion('type', [
  z.object({ type: z.literal('lots'), lots: z.array(AgentLot).max(8) }).strict(),
  /** A proposal only. Nothing is bid until the user confirms in the room with their own wallet. */
  z
    .object({
      type: z.literal('bid'), lotId: Uuid, showId: Uuid, lotNumber: z.number().int().positive(), name: z.string().max(200),
      currentBidUsdc: Amount.nullable(), amountUsdc: Amount, limitUsdc: Amount, incrementUsdc: Amount,
    })
    .strict(),
  /** A proposal only. No credit is spent until the user presses the button, which calls `POST /api/ai/listing` (creditCost 0 while AI_FREE is on). */
  z.object({ type: z.literal('draft'), fields: AiListingFields.omit({ locale: true }), creditCost: z.union([z.literal(0), z.literal(1)]) }).strict(),
]);
export const AiAgentResponse = z
  .object({
    text: z.string().min(1).max(2000),
    /** `ai`: a model chose the tool or the FAQ entry. `faq`: no model was used (a fixed or keyword answer). The agent never returns model prose. */
    label: z.enum(['ai', 'faq']),
    cards: z.array(AiAgentCard).max(2),
  })
  .strict();
