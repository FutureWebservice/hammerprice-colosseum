/**
 * Room chat (FEATURE_CHAT, default off), contract only. The chat is PRE-MODERATED by the room operator (the show's seller; for the
 * house show the platform operator list): a signed-in bidder posts a message, it is stored `pending` and is NOT public, and the
 * operator publishes (approves) message by message. The public list is identical for every viewer (CDN-cacheable for 1 s): the
 * last 50 `approved` messages, with a bidder number and never a wallet or an author id. The author sees their own pending or
 * rejected message through `chatMine`; the operator sees everything through `chatQueue` and acts through `chatModerate`.
 * Bots never post.
 */
import { z } from 'zod';
import { IsoTime, Uuid, Wallet } from './common';

export const ChatRole = z.enum(['bidder', 'seller', 'house']);
/** pending = waiting for the operator (visible to its author only), approved = public, rejected = never public. */
export const ChatStatus = z.enum(['pending', 'approved', 'rejected']);
/** user = typed by the author; assistant = an AI answer the operator chose to publish (the UI labels it as AI). */
export const ChatSource = z.enum(['user', 'assistant']);

/** A public message (status approved). */
export const ChatMessage = z
  .object({
    id: Uuid,
    /** Strictly increasing per show; clients de-duplicate on it. */
    seq: z.number().int().nonnegative(),
    at: IsoTime,
    paddle: z.number().int().min(1).nullable(),
    /** The author's display name when they set one, else null: the room then shows the bidder number alone. Never for the house. */
    name: z.string().max(40).nullable().default(null),
    role: ChatRole,
    source: ChatSource.default('user'),
    lotNumber: z.number().int().min(1).nullable(),
    body: z.string().min(1).max(200),
  })
  .strict();
export type ChatMessage = z.infer<typeof ChatMessage>;

/** `GET /api/shows/:id/chat`: `enabled: false` (feature or switch off) comes with an empty list. */
export const ChatListResponse = z.object({ enabled: z.boolean(), messages: z.array(ChatMessage).max(50), lastSeq: z.number().int().nonnegative() }).strict();

/** Why a message was refused outright (`validation` with `extra.reason`). */
export const CHAT_REJECT_REASONS = ['link', 'contact_data', 'too_long', 'duplicate', 'shouting'] as const;

/** The author's own message: pending ("waiting for approval", visible to its author only) or rejected, with the operator's reason. */
export const ChatOwnMessage = z
  .object({
    id: Uuid,
    seq: z.number().int().nonnegative(),
    at: IsoTime,
    lotNumber: z.number().int().min(1).nullable(),
    body: z.string().min(1).max(200),
    status: ChatStatus,
    reason: z.string().nullable(),
  })
  .strict();
export type ChatOwnMessage = z.infer<typeof ChatOwnMessage>;

export const ChatPostRequest = z
  .object({ body: z.string().min(1).max(200), clientNonce: Uuid, lotNumber: z.number().int().min(1).optional() })
  .strict();
/** The message comes back as the author's own `pending` one (an operator's own post is approved at once). */
export const ChatPostResponse = z.object({ message: ChatOwnMessage }).strict();

/**
 * `GET /api/shows/:id/chat/mine`: the caller's messages that are not (yet) public, newest last (approved ones are in the public
 * list), and whether the caller is this room's operator (so the panel shows the moderation tools without probing a 403 route).
 */
export const ChatMineResponse = z.object({ messages: z.array(ChatOwnMessage).max(50), operator: z.boolean() }).strict();

/** What the operator sees per message: everything, including the wallet (needed to mute or block) and the report count. */
export const ChatQueueMessage = z
  .object({
    id: Uuid,
    seq: z.number().int().nonnegative(),
    at: IsoTime,
    status: ChatStatus,
    paddle: z.number().int().min(1).nullable(),
    /** The author's display name (null when none), so the operator sees what the room sees. */
    name: z.string().max(40).nullable().default(null),
    wallet: Wallet,
    role: ChatRole,
    source: ChatSource,
    lotNumber: z.number().int().min(1).nullable(),
    body: z.string().min(1).max(200),
    reports: z.number().int().nonnegative(),
    /** The open reports' reason and optional detail (never the reporter). */
    reportDetails: z.array(z.object({ reason: z.string(), detail: z.string().nullable() }).strict()).max(100),
    reason: z.string().nullable(),
    moderatedAt: IsoTime.nullable(),
  })
  .strict();
export const ChatQueueQuery = z
  .object({
    /** 'reported' = any message with an open report; 'all' = every status. Default pending. */
    filter: z.enum(['pending', 'approved', 'rejected', 'reported', 'all']).default('pending'),
    afterSeq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export const ChatQueueResponse = z
  .object({
    messages: z.array(ChatQueueMessage).max(100),
    counts: z.object({ pending: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), rejected: z.number().int().nonnegative(), reported: z.number().int().nonnegative() }).strict(),
    /** Wallets silenced in this show, so the panel can show and lift it. */
    silenced: z.array(z.object({ paddle: z.number().int().min(1).nullable(), wallet: Wallet, kind: z.enum(['mute', 'block']), until: IsoTime.nullable(), reason: z.string() }).strict()),
    lastSeq: z.number().int().nonnegative(),
  })
  .strict();

const messageIds = z.array(Uuid).min(1).max(50);
const reason = z.string().trim().min(3).max(200);
/**
 * One operator action. `approve` and `reject` take several messages at once; `mute` (minutes) and `block` (for the show) target a
 * bidder number; `unsilence` lifts either; `publish` posts a message as the operator (approved at once, role seller or house),
 * which is how an assistant answer reaches the room (`source: 'assistant'`) through the moderated chat.
 */
export const ChatModerateRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), messageIds }).strict(),
  z.object({ action: z.literal('reject'), messageIds, reason }).strict(),
  z.object({ action: z.literal('mute'), paddle: z.number().int().min(1), minutes: z.number().int().min(1).max(7 * 24 * 60), reason }).strict(),
  z.object({ action: z.literal('block'), paddle: z.number().int().min(1), reason }).strict(),
  z.object({ action: z.literal('unsilence'), paddle: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal('publish'), body: z.string().trim().min(1).max(200), source: ChatSource.default('user'), lotNumber: z.number().int().min(1).optional(), clientNonce: Uuid }).strict(),
]);
export const ChatModerateResponse = z.object({ ok: z.literal(true), affected: z.number().int().nonnegative() }).strict();

export const ChatReportReason = z.enum(['illegal', 'spam', 'harassment', 'scam', 'other']);
export const ChatReportRequest = z.object({ reason: ChatReportReason, detail: z.string().trim().max(500).optional() }).strict();
export const ChatReportResponse = z.object({ ok: z.literal(true) }).strict();
