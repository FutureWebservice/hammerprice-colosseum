/**
 * Primitives and enums shared by the contract files. Nothing here knows about a route.
 *
 * Money is always a decimal STRING of USDC base units (6 dp), never a number: a bigint does not
 * survive JSON and a float would lose cents. Times are ISO-8601 strings on the wire; the
 * snapshot's `serverNow` is epoch milliseconds from the database clock.
 */
import { z } from 'zod';
import { isValidUuid } from '@/lib/uuid';

export const Uuid = z.string().refine(isValidUuid, 'not a uuid');

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
/** A Solana public key in base58 (32 to 44 characters). */
export const Wallet = z.string().min(32).max(44).regex(BASE58, 'not base58');
/** A transaction signature in base58 (64 bytes encode to 86 to 88 characters). */
export const TxSignature = z.string().min(64).max(90).regex(BASE58, 'not base58');
/** An ed25519 signature, base64 (64 bytes encode to 88 characters). */
export const Signature64 = z.string().min(86).max(100).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64');
/** A serialized transaction, base64. A legacy transaction is at most 1,232 bytes (1,644 characters). */
export const TxBase64 = z.string().min(1).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'not base64');
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'not a sha-256 hex digest');
export const IsoTime = z.string().datetime({ offset: true });

/** USDC base units as a decimal string (no sign, no leading zero, at most 20 digits). The per-bid cap MAX_BID is enforced by the engine. */
export const Amount = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, 'not an unsigned integer string');
/** 10^12 base units = 1,000,000 USDC: the largest bid the engine accepts (`amount_too_large` above it). */
export const MAX_BID = 1_000_000_000_000n;

export const Cluster = z.enum(['devnet', 'mainnet-beta']);
export type Cluster = z.infer<typeof Cluster>;

export const ShowStatus = z.enum(['scheduled', 'live', 'ended']);
export const ShowFormat = z.enum(['auction', 'buy_now']);
/** The API accepts only 'auto' (the lot closes by itself); 'manual' survives in old rows. */
export const ShowMode = z.enum(['auto', 'manual']);
export const SettlementMode = z.enum(['none', 'onchain']);
/** 'live' = a room with a clock per lot; 'timed' = one lot that runs for hours or days (FEATURE_TIMED). */
export const ShowKind = z.enum(['live', 'timed']);
/** 'catalogue' = lots open in catalogue order; 'vrf' = the order is drawn once by a verifiable random function (FEATURE_VRF). */
export const OrderMode = z.enum(['catalogue', 'vrf']);
/** A lot description per language (the seller's own text, or an AI draft the seller reviewed). */
export const LotDescription = z.object({ de: z.string().trim().max(1500), en: z.string().trim().max(1500) }).strict();
export type LotDescription = z.infer<typeof LotDescription>;
export const LotState = z.enum(['catalogued', 'open', 'sold', 'passed', 'withdrawn']);
export const LotPhase = z.enum([
  'queued', 'open', 'going_once', 'going_twice', 'hammered',
  'sold_awaiting_payment', 'sold_paying', 'settled', 'lapsed', 'passed', 'withdrawn',
]);
/** `awaiting_payment` also covers "waiting for signatures" in the co-sign flow; `awaiting_seller` is reserved for the cc_marketplace rail. */
export const SettlementStatus = z.enum(['awaiting_payment', 'awaiting_seller', 'submitted', 'settled', 'expired', 'failed']);
export const SettlementRail = z.enum(['cosign', 'core_delegate', 'cc_marketplace']);
/** Readiness flag set after the ownership read: no delegate step. 'none' = legacy or not checked yet. */
export const ConsignStatus = z.enum(['none', 'pending', 'ready', 'rejected']);
export const NftStandard = z.enum(['core', 'pnft', 'nft', 'cnft', 'unknown']);
export const PartyRole = z.enum(['buyer', 'seller']);

export type ShowStatus = z.infer<typeof ShowStatus>;
export type ShowKind = z.infer<typeof ShowKind>;
export type OrderMode = z.infer<typeof OrderMode>;
export type LotState = z.infer<typeof LotState>;
export type LotPhase = z.infer<typeof LotPhase>;
export type SettlementStatus = z.infer<typeof SettlementStatus>;
export type SettlementRail = z.infer<typeof SettlementRail>;
export type ConsignStatus = z.infer<typeof ConsignStatus>;
export type NftStandard = z.infer<typeof NftStandard>;
export type PartyRole = z.infer<typeof PartyRole>;

/**
 * `shows.rules`: every key optional on input, clamped by `resolveRules()` (ENGINE), which is the only reader.
 * The maxima here are the UNION over the show kinds (a timed show runs for days); `resolveRules(raw, defaults, kind)` then
 * clamps to the range of the show's own kind, so a live show is still limited to the old, tighter ranges.
 */
export const AuctionRulesInput = z
  .object({
    lotDurationS: z.number().int().min(10).max(1_209_600),
    callOnceS: z.number().int().min(1).max(1_209_600),
    callTwiceS: z.number().int().min(1).max(1_209_600),
    snipeWindowS: z.number().int().min(0).max(3600),
    snipeExtendS: z.number().int().min(0).max(3600),
    maxExtensionS: z.number().int().min(0).max(604_800),
    gapS: z.number().int().min(0).max(600),
    /** Seconds after the hammer in which buyer and seller must both sign (config SETTLEMENT_WINDOW_S, default 900). */
    settlementWindowS: z.number().int().min(60).max(7 * 86400),
  })
  .partial()
  .strict();
export type AuctionRulesInput = z.infer<typeof AuctionRulesInput>;
