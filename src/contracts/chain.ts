/**
 * What ENGINE, AUTH, LIVE, ROOM and CHAIN agree on about the chain and settlement.
 * CHAIN implements; everyone else calls. Types and function signatures only, plus two tiny pure helpers.
 *
 * Settlement rail is CO-SIGN. One transaction, fee payer = settlement authority
 * SA, required signers exactly {SA, buyer, seller}. SA signs only as fee payer and ATA-rent payer and
 * has no authority over any asset. Buyer and seller each sign the SAME unsigned message, in any order;
 * when both signatures are stored the server adds SA's, simulates, sends and finalizes. A round that
 * expires before both signed drops the stored signatures; `prepare` then starts attempt + 1.
 * On the devnet house show the server signs the seller leg itself at `prepare` (house assets are the
 * platform's own test assets), so the buyer sees one wallet signature.
 */
import { z } from 'zod';
import {
  Amount, Cluster, ConsignStatus, IsoTime, NftStandard, PartyRole, SettlementRail, SettlementStatus,
  Sha256Hex, TxBase64, TxSignature, Uuid, Wallet,
} from './common';

// ---------------------------------------------------------------------------------------------
// Expected settlement: the trusted description of the one transaction that may move this lot.
// ---------------------------------------------------------------------------------------------

/** `hp:settle:<settlement uuid>:<sha256 hex of the signed bid log>`: anchors the bid log on chain in the same atomic tx. */
export const settlementMemo = (settlementId: string, bidLogHash: string): string => `hp:settle:${settlementId}:${bidLogHash}`;

export const ExpectedSettlement = z
  .object({
    settlementId: Uuid,
    cluster: Cluster,
    buyer: Wallet,
    seller: Wallet,
    /** The Core asset that changes owner (TransferV1, authority = seller). */
    asset: Wallet,
    collection: Wallet.nullable(),
    usdcMint: Wallet,
    gross: Amount,
    platformFee: Amount,
    royalty: Amount,
    royaltyRecipient: Wallet.nullable(),
    feeWallet: Wallet,
    /** SA. Also the first required signer. */
    feePayer: Wallet,
    bidLogHash: Sha256Hex,
    memo: z.string(),
    /** `nonce` adds advanceNonce as instruction 0 (P1, gated on the wallet test matrix). The builder takes it from day one. */
    lifetime: z.enum(['blockhash', 'nonce']),
    nonceAccount: Wallet.nullable(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.memo !== settlementMemo(e.settlementId, e.bidLogHash)) ctx.addIssue({ code: 'custom', path: ['memo'], message: 'memo must be hp:settle:<id>:<bidLogHash>' });
    if (BigInt(e.platformFee) + BigInt(e.royalty) > BigInt(e.gross)) ctx.addIssue({ code: 'custom', path: ['gross'], message: 'fee plus royalty exceed gross' });
    if ((e.lifetime === 'nonce') !== (e.nonceAccount !== null)) ctx.addIssue({ code: 'custom', path: ['nonceAccount'], message: 'nonceAccount is required exactly when lifetime is nonce' });
    if ((e.royalty !== '0') !== (e.royaltyRecipient !== null)) ctx.addIssue({ code: 'custom', path: ['royaltyRecipient'], message: 'royaltyRecipient is required exactly when royalty > 0' });
  });
export type ExpectedSettlement = z.infer<typeof ExpectedSettlement>;

/** The required signer set, fee payer first: the compiled message must have exactly these three and no other. */
export const expectedSigners = (e: Pick<ExpectedSettlement, 'feePayer' | 'buyer' | 'seller'>): [string, string, string] => [e.feePayer, e.buyer, e.seller];

// ---------------------------------------------------------------------------------------------
// Asset readiness (consign = ownership + readiness read; no delegate, nothing to sign).
// ---------------------------------------------------------------------------------------------

/** What `readAsset` returns. CHAIN may extend it by PR; these are the fields the readiness rules need. */
export const AssetInfo = z
  .object({
    mint: Wallet,
    standard: NftStandard,
    owner: Wallet.nullable(),
    collection: Wallet.nullable(),
    name: z.string(),
    imageUrl: z.string().nullable(),
    frozen: z.boolean(),
    compressed: z.boolean(),
    burnt: z.boolean(),
    /** The Core royalty rule set would refuse a plain owner transfer. */
    royaltyBlocksOwnerTransfer: z.boolean(),
    /** A delegate other than the owner that blocks an owner transfer (for example an active foreign listing lock). */
    blockingDelegate: Wallet.nullable(),
  })
  .strict();
export type AssetInfo = z.infer<typeof AssetInfo>;

export const READINESS_REASONS = ['not_found', 'unsupported_standard', 'not_owner', 'frozen', 'royalty_rules_block_transfer', 'foreign_delegate_blocks', 'already_listed'] as const;
export const ReadinessReason = z.enum(READINESS_REASONS);
export type ReadinessReason = z.infer<typeof ReadinessReason>;

export const AssetReadiness = z
  .object({ eligible: z.boolean(), reasons: z.array(ReadinessReason) })
  .strict()
  .refine((r) => r.eligible === (r.reasons.length === 0), 'eligible must equal "no reasons"');
export type AssetReadiness = z.infer<typeof AssetReadiness>;

// ---------------------------------------------------------------------------------------------
// Settlement views
// ---------------------------------------------------------------------------------------------

/**
 * The public face of a settlements row. `attempt`, `roundExpiresAt`, `buyerSigned` and `sellerSigned`
 * are columns of the row; `role` is the caller's side, null for a stranger
 * (who gets 403 not_party instead, so in practice always set).
 */
export const SettlementView = z
  .object({
    id: Uuid,
    lotId: Uuid,
    status: SettlementStatus,
    rail: SettlementRail,
    cluster: Cluster,
    attempt: z.number().int().min(1),
    gross: Amount,
    platformFee: Amount,
    sellerAmount: Amount,
    royalty: Amount,
    /** closes_at + SETTLEMENT_WINDOW_S: the whole settlement expires here. */
    dueAt: IsoTime,
    /** End of the current signing round, null when no round is open. */
    roundExpiresAt: IsoTime.nullable(),
    buyerSigned: z.boolean(),
    sellerSigned: z.boolean(),
    role: PartyRole.nullable(),
    txSignature: TxSignature.optional(),
    explorerUrl: z.string().url().optional(),
    failure: z.object({ code: z.string(), detail: z.string().nullable() }).strict().optional(),
  })
  .strict();
export type SettlementView = z.infer<typeof SettlementView>;

/** `POST /api/settlements/:id/prepare`. Idempotent inside a live round (same message). */
export const PreparedSettlement = z
  .object({
    attempt: z.number().int().min(1),
    /** The unsigned message, base64. Both parties sign exactly these bytes; the browser runs assertSettlementTx first. */
    txBase64: TxBase64,
    expected: ExpectedSettlement,
    /** null for lifetime 'nonce'. */
    lastValidBlockHeight: z.number().int().nonnegative().nullable(),
    roundExpiresAt: IsoTime,
    dueAt: IsoTime,
    buyerSigned: z.boolean(),
    /** true at prepare on a house show: the server already signed the seller leg. */
    sellerSigned: z.boolean(),
  })
  .strict();
export type PreparedSettlement = z.infer<typeof PreparedSettlement>;

export const SignInput = z.object({ role: PartyRole, signedTxBase64: TxBase64 }).strict();
export type SignInput = z.infer<typeof SignInput>;

/** `awaiting_counterparty`: stored, the other party has not signed. `submitted`: both stored, SA added, sent. `settled`: confirmed and verified. */
export const SIGN_STEPS = ['awaiting_counterparty', 'submitted', 'settled'] as const;
export const SignResult = z.object({ step: z.enum(SIGN_STEPS), settlement: SettlementView }).strict();
export type SignResult = z.infer<typeof SignResult>;

// ---------------------------------------------------------------------------------------------
// Function signatures (4.3, with the co-sign change). CHAIN implements them.
// ---------------------------------------------------------------------------------------------

/** Pure and browser-safe: rebuilds the expected message from trusted inputs and compares the compiled message byte for byte (blockhash aside). Throws ApiError('tx_mismatch'). */
export type AssertSettlementTx = (txBytes: Uint8Array, expected: ExpectedSettlement, opts?: { tolerated?: string[] }) => void;

export interface ChainApi {
  /** Throws ApiError('balance_unavailable') when every RPC fails; a missing token account is 0n. */
  getUsdcBalance(wallet: string, cluster?: Cluster): Promise<bigint>;
  readAsset(mint: string, cluster?: Cluster): Promise<AssetInfo | null>;
  /** Owner equals `ctx.seller`, not frozen, royalty rules do not block a plain owner transfer, no blocking delegate, Core only for now. */
  evaluateAssetReadiness(info: AssetInfo, ctx: { seller: string }): AssetReadiness;
  assertSettlementTx: AssertSettlementTx;
}

/**
 * server/settlement/service.ts. `actorProfileId` is the signed-in buyer or seller of the settlement;
 * `null` means the cron sweep (allowed to `prepare`, nothing else). ENGINE creates the row inside the
 * closing transaction; CHAIN only drives prepare, sign, finalize and expiry. Methods throw ApiError.
 */
export interface SettlementService {
  /** not_party, wrong_state, insufficient_usdc, asset_not_ready, balance_unavailable, rpc_unavailable. Starts attempt + 1 only when the previous round expired. */
  prepareSettlement(settlementId: string, actorProfileId: string | null): Promise<PreparedSettlement>;
  /** Verifies the role's signature over the prepared message bytes and stores it. With both stored: add SA, simulate, send, poll, finalize. */
  signSettlement(settlementId: string, actorProfileId: string, input: SignInput): Promise<SignResult>;
  /** Idempotent. Also called lazily by GET /api/settlements/:id and by the sweep. */
  finalizeSettlement(settlementId: string): Promise<SettlementView>;
  /** Marks settlements past due_at `expired` (strike on the non-acting party) and drops signatures of expired rounds. Returns how many. */
  expireDue(now?: Date): Promise<number>;
  /** POST /api/lots/:id/readiness: re-read the asset, set lots.consign_status = 'ready' when eligible. */
  checkReadiness(lotId: string, sellerProfileId: string): Promise<{ readiness: AssetReadiness; consign: ConsignStatus }>;
}
