/**
 * Verifiable randomness (FEATURE_VRF, default off), contract only. One ECVRF key, published once; every draw commits its
 * input first, reveals later, and anyone can recompute it from the data below (the check page /verify/random/[id]).
 * Transaction bytes and leases are server-only and never appear here.
 */
import { z } from 'zod';
import { Cluster, IsoTime, Sha256Hex, TxSignature, Uuid, Wallet } from './common';

/** lot_order = the order of a show's lots; raffle = a thank-you draw among bidders; pack_draw = the draw of one pack purchase (subject = the draw id). */
export const VrfPurpose = z.enum(['lot_order', 'raffle', 'pack_draw']);
export const VrfSubjectType = z.enum(['show', 'pack_draw']);
/** pending (no final commit yet) -> committed -> revealed, or defaulted when the reveal missed its deadline. */
export const VrfStatus = z.enum(['pending', 'committed', 'revealed', 'defaulted']);
export type VrfPurpose = z.infer<typeof VrfPurpose>;
export type VrfStatus = z.infer<typeof VrfStatus>;

export const VRF_SUITE = 'ECVRF-EDWARDS25519-SHA512-TAI' as const;

/** The result per purpose; `applied: false` when the show had already opened a lot, so the order was only recorded. */
export const VrfLotOrderResult = z.object({ order: z.array(Uuid), applied: z.boolean() }).strict();
export const VrfRaffleResult = z.object({ winnerPaddle: z.number().int().min(1), entrants: z.array(z.number().int().min(1)) }).strict();

export const VrfRequestView = z
  .object({
    id: Uuid,
    purpose: VrfPurpose,
    subject: z.object({ type: VrfSubjectType, id: z.string().min(1).max(64) }).strict(),
    status: VrfStatus,
    cluster: Cluster,
    publicKey: Wallet,
    params: z.record(z.unknown()),
    paramsHash: Sha256Hex,
    /** The exact text the proof was made over; null until the beacon is known. */
    alphaText: z.string().nullable(),
    beacon: z.object({ slot: z.number().int().nonnegative(), blockhash: z.string().min(32).max(44) }).strict().nullable(),
    commitTx: TxSignature.nullable(),
    commitSlot: z.number().int().nonnegative().nullable(),
    revealBy: IsoTime,
    proofHex: z.string().regex(/^[0-9a-f]{160}$/).nullable(),
    outputHex: z.string().regex(/^[0-9a-f]{128}$/).nullable(),
    revealTx: TxSignature.nullable(),
    result: z.record(z.unknown()).nullable(),
  })
  .strict();
export type VrfRequestView = z.infer<typeof VrfRequestView>;

/** `GET /api/vrf/key`: the public key, where it was announced, and the counters (a commit that is never revealed stays visible). */
export const VrfKeyResponse = z
  .object({
    publicKey: Wallet,
    suite: z.literal(VRF_SUITE),
    cluster: Cluster,
    registrationTx: TxSignature.nullable(),
    stats: z.object({ commits: z.number().int().nonnegative(), reveals: z.number().int().nonnegative(), defaults: z.number().int().nonnegative() }).strict(),
  })
  .strict();

/** `GET /api/vrf/shows/:id`: the draws that belong to a show. */
export const VrfShowResponse = z
  .object({
    lotOrder: z.object({ requestId: Uuid, status: VrfStatus }).strict().nullable(),
    raffle: z.object({ requestId: Uuid, status: VrfStatus }).strict().nullable(),
  })
  .strict();

/** `POST /api/vrf/requests/:id/advance`: public and idempotent, it only moves a draw along its own state machine. */
export const VrfAdvanceRequest = z.object({}).strict();

/** `LiveSnapshot.show.order` and `ShowCore.orderMode`'s companion: the chip in the room needs no extra request. */
export const ShowOrder = z
  .object({ mode: z.enum(['catalogue', 'vrf']), status: VrfStatus.optional(), requestId: Uuid.optional() })
  .strict();
export type ShowOrder = z.infer<typeof ShowOrder>;
