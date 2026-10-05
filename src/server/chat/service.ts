/**
 * The room chat, server side: PRE-MODERATED by the room operator.
 *
 *   - A signed-in bidder (a paddle in the show) posts; the message is stored `pending`. It is NOT public: only its author sees it
 *     ("waiting for approval") and the operator sees it in the queue. The operator approves (public), rejects (never public, the
 *     author sees the reason), mutes or blocks the wallet. The public list is the last 50 `approved` messages, identical for everyone.
 *   - The operator is the show's seller; for the house show the OPERATOR_WALLETS list (lib/auctioneer.ts isAuctioneer). The operator's
 *     own posts are approved at once. Bots never post (is_bot profiles are refused).
 *   - Nothing here reads or writes anything but chat tables, paddles and profiles; it never touches the auction engine.
 *
 * Time comes in as an optional `now` (tests); routes never pass one. The database is opened lazily so importing this module needs no
 * DATABASE_URL (the schema module is pure).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { ApiError } from '@/contracts/errors';
import type { ChatMessage, ChatOwnMessage } from '@/contracts/chat';
import { auditLogs, chatMessages, chatMutes, chatReports, lots, paddles, profiles, shows } from '@/db/schema';
import { isAuctioneer } from '@/lib/auctioneer';
import { featureOn } from '@/lib/features';
import { telegramHooks } from '@/server/telegram/hooks';
import { checkBody, duplicateKey, DUPLICATE_WINDOW_S, REJECT_TEXT } from './rules';

async function getDb() {
  return (await import('@/db')).db;
}
type Db = Awaited<ReturnType<typeof getDb>>;

/** A message stays writable this long after the show ended (people say goodbye), then the room is closed for new messages. */
export const WRITE_AFTER_END_MS = 10 * 60_000;
/** Messages of one author waiting for approval in one show: more than this and the author waits (a flood must not bury the operator). */
export const MAX_PENDING_PER_AUTHOR = 5;
export const PUBLIC_LIMIT = 50;

export interface Actor { profileId: string; wallet: string }

interface ShowInfo {
  id: string;
  isHouse: boolean;
  status: 'scheduled' | 'live' | 'ended';
  endedAt: Date | null;
  cancelledAt: Date | null;
  sellerWallet: string;
}

/** The chat feature is on (FEATURE_CHAT and the kill switch). Off answers like a route that does not exist. */
export async function assertChatOn(): Promise<void> {
  if (!(await featureOn('CHAT'))) throw new ApiError('feature_off', 'The chat is not available');
}

async function loadShow(db: Db, showId: string): Promise<ShowInfo> {
  const [row] = await db
    .select({ id: shows.id, isHouse: shows.isHouse, status: shows.status, endedAt: shows.endedAt, cancelledAt: shows.cancelledAt, sellerWallet: profiles.walletAddress })
    .from(shows)
    .innerJoin(profiles, eq(profiles.id, shows.sellerId))
    .where(eq(shows.id, showId))
    .limit(1);
  if (!row) throw new ApiError('not_found', 'Show not found');
  return row;
}

export const isOperator = (show: ShowInfo, wallet: string): boolean => isAuctioneer(wallet, show.sellerWallet, { isHouse: show.isHouse });

/** The operator of this show, or `not_seller` (403). Load the show first; throws not_found for an unknown id. */
async function requireOperator(db: Db, showId: string, actor: Actor): Promise<ShowInfo> {
  const show = await loadShow(db, showId);
  if (!isOperator(show, actor.wallet)) throw new ApiError('not_seller', 'Only the room operator can moderate the chat');
  return show;
}

const iso = (d: Date): string => d.toISOString();
const seqOf = (n: number | null): number => n ?? 0;

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * The public list: the last 50 approved messages, oldest first, ordered by when the operator published them (so a message approved a
 * minute late appears at the bottom, where people are reading, and not buried in the middle). Never an author id or a wallet.
 */
export async function listPublic(showId: string): Promise<{ messages: ChatMessage[]; lastSeq: number }> {
  const db = await getDb();
  const rows = await db
    .select({ id: chatMessages.id, seq: chatMessages.seq, at: chatMessages.createdAt, paddle: chatMessages.paddleNumber, name: profiles.displayName, role: chatMessages.role, source: chatMessages.source, lotNumber: chatMessages.lotNumber, body: chatMessages.body })
    .from(chatMessages)
    .leftJoin(profiles, eq(profiles.id, chatMessages.authorId))
    .where(and(eq(chatMessages.showId, showId), eq(chatMessages.status, 'approved')))
    .orderBy(desc(sql`coalesce(${chatMessages.moderatedAt}, ${chatMessages.createdAt})`), desc(chatMessages.seq))
    .limit(PUBLIC_LIMIT);
  const messages: ChatMessage[] = rows.reverse().map((r) => ({
    id: r.id,
    seq: seqOf(r.seq),
    at: iso(r.at),
    paddle: r.paddle,
    name: r.role === 'house' ? null : r.name, // the house speaks as the house; a person speaks under the name they chose, if any
    role: r.role as ChatMessage['role'],
    source: r.source as ChatMessage['source'],
    lotNumber: r.lotNumber,
    body: r.body,
  }));
  return { messages, lastSeq: messages.reduce((m, x) => Math.max(m, x.seq), 0) };
}

/** Does this show exist (the public list answers 404 for an unknown id, not an empty chat). */
export async function showExists(showId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: shows.id }).from(shows).where(eq(shows.id, showId)).limit(1);
  return row != null;
}

const ownOf = (r: { id: string; seq: number | null; at: Date; lotNumber: number | null; body: string; status: string; reason: string | null }): ChatOwnMessage => ({
  id: r.id, seq: seqOf(r.seq), at: iso(r.at), lotNumber: r.lotNumber, body: r.body, status: r.status as ChatOwnMessage['status'], reason: r.reason,
});
const ownCols = { id: chatMessages.id, seq: chatMessages.seq, at: chatMessages.createdAt, lotNumber: chatMessages.lotNumber, body: chatMessages.body, status: chatMessages.status, reason: chatMessages.hiddenReason };

/** The caller's own messages that are not public (pending or rejected), oldest first, and whether the caller is this room's operator. */
export async function listMine(showId: string, actor: Actor): Promise<{ messages: ChatOwnMessage[]; operator: boolean }> {
  const db = await getDb();
  const show = await loadShow(db, showId);
  const rows = await db
    .select(ownCols)
    .from(chatMessages)
    .where(and(eq(chatMessages.showId, showId), eq(chatMessages.authorId, actor.profileId), ne(chatMessages.status, 'approved')))
    .orderBy(desc(chatMessages.seq))
    .limit(PUBLIC_LIMIT);
  return { messages: rows.reverse().map(ownOf), operator: isOperator(show, actor.wallet) };
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export interface PostInput {
  showId: string;
  actor: Actor;
  body: string;
  clientNonce: string;
  lotNumber?: number | null;
  /** 'assistant' only for the operator (an AI answer the operator chose to publish; the room shows it labelled as AI). */
  source?: 'user' | 'assistant';
}

const isUniqueViolation = (e: unknown): boolean => {
  const code = (x: unknown) => (x && typeof x === 'object' && 'code' in x ? (x as { code?: string }).code : undefined);
  return code(e) === '23505' || code((e as { cause?: unknown } | null)?.cause) === '23505';
};

/**
 * Post a message. A bidder's message comes back `pending`; the operator's own is approved at once. The same (author, clientNonce) twice is
 * one message (a retry returns the stored one). Refusals are ApiErrors: `validation` with `extra.reason` (empty, too_long, link, contact_data,
 * shouting, duplicate, lot), `no_paddle`, `muted`, `show_ended`, `rate_limited` (too many waiting), `forbidden` (a bot, or an assistant source from a non-operator).
 */
export async function postMessage(input: PostInput, now: Date = new Date()): Promise<ChatOwnMessage> {
  const db = await getDb();
  const { showId, actor } = input;
  const show = await loadShow(db, showId);

  const [existing] = await db.select(ownCols).from(chatMessages).where(and(eq(chatMessages.authorId, actor.profileId), eq(chatMessages.clientNonce, input.clientNonce))).limit(1);
  if (existing) return ownOf(existing);

  const [me] = await db.select({ isBot: profiles.isBot, isBanned: profiles.isBanned }).from(profiles).where(eq(profiles.id, actor.profileId)).limit(1);
  if (!me || me.isBanned) throw new ApiError('banned', 'This account is suspended');
  if (me.isBot) throw new ApiError('forbidden', 'Bots do not write in the chat');

  if (show.cancelledAt != null || (show.status === 'ended' && show.endedAt != null && now.getTime() - show.endedAt.getTime() > WRITE_AFTER_END_MS)) {
    throw new ApiError('show_ended', 'This show has ended, the chat is closed');
  }

  const operator = isOperator(show, actor.wallet);
  const source = input.source ?? 'user';
  if (source === 'assistant' && !operator) throw new ApiError('forbidden', 'Only the room operator can publish an assistant answer');

  let paddleNumber: number | null = null;
  if (!operator) {
    const [paddle] = await db
      .select({ number: paddles.number })
      .from(paddles)
      .where(and(eq(paddles.showId, showId), eq(paddles.profileId, actor.profileId), isNull(paddles.revokedAt), gt(paddles.validUntil, now)))
      .limit(1);
    if (!paddle) throw new ApiError('no_paddle', 'Get a bidder number first to write in the chat');
    paddleNumber = paddle.number;

    const [silenced] = await db
      .select({ kind: chatMutes.kind, until: chatMutes.until })
      .from(chatMutes)
      .where(and(eq(chatMutes.showId, showId), eq(chatMutes.profileId, actor.profileId), or(eq(chatMutes.kind, 'block'), gt(chatMutes.until, now))))
      .limit(1);
    if (silenced) throw new ApiError('muted', silenced.kind === 'block' ? 'The room operator has blocked you from the chat' : 'The room operator has muted you for now', { until: silenced.until ? iso(silenced.until) : null });
  }

  const checked = checkBody(input.body);
  if (!checked.ok) throw new ApiError('validation', REJECT_TEXT[checked.reason], { reason: checked.reason });
  const body = checked.body;

  if (!operator) {
    const key = duplicateKey(body);
    const recent = await db
      .select({ ...ownCols, nonce: chatMessages.clientNonce })
      .from(chatMessages)
      .where(and(eq(chatMessages.showId, showId), eq(chatMessages.authorId, actor.profileId), gt(chatMessages.createdAt, new Date(now.getTime() - DUPLICATE_WINDOW_S * 1000))));
    const same = recent.find((r) => r.nonce === input.clientNonce);
    if (same) return ownOf(same); // a parallel retry of the very same post: it won the race, answer with its message
    if (recent.some((r) => duplicateKey(r.body) === key)) throw new ApiError('validation', 'You already wrote this a moment ago', { reason: 'duplicate' });
    const [waiting] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(chatMessages)
      .where(and(eq(chatMessages.showId, showId), eq(chatMessages.authorId, actor.profileId), eq(chatMessages.status, 'pending')));
    if (waiting.n >= MAX_PENDING_PER_AUTHOR) throw new ApiError('rate_limited', 'You have several messages waiting for approval, please wait', { retryAfterS: 10 });
  }

  let lotId: string | null = null;
  let lotNumber: number | null = null;
  if (input.lotNumber != null) {
    const [lot] = await db.select({ id: lots.id }).from(lots).where(and(eq(lots.showId, showId), eq(lots.lotNumber, input.lotNumber))).limit(1);
    if (!lot) throw new ApiError('validation', 'There is no such lot in this show', { reason: 'lot' });
    lotId = lot.id;
    lotNumber = input.lotNumber;
  }

  try {
    const [row] = await db
      .insert(chatMessages)
      .values({
        showId,
        authorId: actor.profileId,
        body,
        lotId,
        lotNumber,
        paddleNumber,
        role: operator ? (show.isHouse ? 'house' : 'seller') : 'bidder',
        source,
        status: operator ? 'approved' : 'pending',
        moderatedAt: operator ? now : null,
        moderatedBy: operator ? actor.profileId : null,
        clientNonce: input.clientNonce,
        createdAt: now,
      })
      .returning(ownCols);
    if (!operator) telegramHooks.chatPending(row.id); // the room operators who linked Telegram get it with Approve / Reject / Mute (never throws)
    return ownOf(row);
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const [again] = await db.select(ownCols).from(chatMessages).where(and(eq(chatMessages.authorId, actor.profileId), eq(chatMessages.clientNonce, input.clientNonce))).limit(1);
    if (again) return ownOf(again);
    throw e;
  }
}

/**
 * The operator posts as the operator (approved at once, role seller or house). `source: 'assistant'` marks an AI answer the operator chose to
 * publish; the room then labels it as AI. Same text rules as any message. Throws `not_seller` for anyone else.
 */
export async function publish(input: { showId: string; actor: Actor; body: string; lotNumber?: number | null; clientNonce: string; source?: 'user' | 'assistant' }, now: Date = new Date()): Promise<ChatOwnMessage> {
  const db = await getDb();
  await requireOperator(db, input.showId, input.actor);
  const message = await postMessage(input, now);
  await audit('chat.publish', input.actor.wallet, input.showId, { messageId: message.id, source: input.source ?? 'user' });
  return message;
}

/**
 * For the AI package (WP6b, the assistant): publish an assistant answer into the room chat on behalf of the room operator. The operator
 * decides (a button next to the private answer); the message goes through the SAME rules as any other (no links, no contact data, 200
 * characters), is approved at once because the operator is the moderator, and carries `source: 'assistant'` so the room labels it as AI.
 * Throws `feature_off` when the chat is off, `not_seller` when `actor` is not this room's operator, `validation` (`extra.reason`) when the text
 * breaks a rule. The same `clientNonce` twice is one message.
 */
export async function publishAssistantAnswer(input: { showId: string; actor: Actor; body: string; lotNumber?: number | null; clientNonce?: string }, now: Date = new Date()): Promise<ChatOwnMessage> {
  await assertChatOn();
  return publish({ ...input, clientNonce: input.clientNonce ?? randomUUID(), source: 'assistant' }, now);
}

// ---------------------------------------------------------------------------------------------
// The operator
// ---------------------------------------------------------------------------------------------

async function audit(action: string, actorWallet: string, target: string, detail: unknown): Promise<void> {
  const db = await getDb();
  await db.insert(auditLogs).values({ action, actorWallet, target, detail });
}

export type QueueFilter = 'pending' | 'approved' | 'rejected' | 'reported' | 'all';

export interface QueueMessage {
  id: string; seq: number; at: string; status: 'pending' | 'approved' | 'rejected'; paddle: number | null; name: string | null; wallet: string;
  role: 'bidder' | 'seller' | 'house'; source: 'user' | 'assistant'; lotNumber: number | null; body: string; reports: number; reportDetails: { reason: string; detail: string | null }[]; reason: string | null; moderatedAt: string | null;
}
export interface QueueResult {
  messages: QueueMessage[];
  counts: { pending: number; approved: number; rejected: number; reported: number };
  silenced: { paddle: number | null; wallet: string; kind: 'mute' | 'block'; until: string | null; reason: string }[];
  lastSeq: number;
}

/**
 * Everything, for the operator only. `pending` is oldest first from `afterSeq` (the work list); every other filter is the newest `limit`
 * (oldest first on screen) unless `afterSeq` is given. Wallets appear here and nowhere else.
 */
export async function queue(showId: string, actor: Actor, q: { filter: QueueFilter; afterSeq?: number; limit: number }): Promise<QueueResult> {
  const db = await getDb();
  await requireOperator(db, showId, actor);

  // Qualified by hand: drizzle drops the table name in a single-table select, and inside a subquery a bare "id" would be the report's.
  const openReports = sql<number>`(select count(*)::int from chat_reports r where r.message_id = chat_messages.id and r.status = 'open')`;
  const reportDetails = sql<{ reason: string; detail: string | null }[]>`coalesce((select json_agg(json_build_object('reason', r.reason, 'detail', r.detail) order by r.created_at) from chat_reports r where r.message_id = chat_messages.id and r.status = 'open'), '[]'::json)`;
  const where = [eq(chatMessages.showId, showId)];
  if (q.filter === 'pending' || q.filter === 'approved' || q.filter === 'rejected') where.push(eq(chatMessages.status, q.filter));
  if (q.filter === 'reported') where.push(sql`exists (select 1 from chat_reports r where r.message_id = chat_messages.id and r.status = 'open')`);
  if (q.afterSeq != null) where.push(gt(chatMessages.seq, q.afterSeq));
  const oldestFirst = q.filter === 'pending' || q.afterSeq != null;
  const rows = await db
    .select({
      id: chatMessages.id, seq: chatMessages.seq, at: chatMessages.createdAt, status: chatMessages.status, paddle: chatMessages.paddleNumber, name: profiles.displayName, wallet: profiles.walletAddress,
      role: chatMessages.role, source: chatMessages.source, lotNumber: chatMessages.lotNumber, body: chatMessages.body, reports: openReports, reportDetails, reason: chatMessages.hiddenReason, moderatedAt: chatMessages.moderatedAt,
    })
    .from(chatMessages)
    .innerJoin(profiles, eq(profiles.id, chatMessages.authorId))
    .where(and(...where))
    .orderBy(oldestFirst ? asc(chatMessages.seq) : desc(chatMessages.seq))
    .limit(q.limit);
  if (!oldestFirst) rows.reverse();

  const [counts] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${chatMessages.status} = 'pending')::int`,
      approved: sql<number>`count(*) filter (where ${chatMessages.status} = 'approved')::int`,
      rejected: sql<number>`count(*) filter (where ${chatMessages.status} = 'rejected')::int`,
      reported: sql<number>`count(*) filter (where exists (select 1 from chat_reports r where r.message_id = chat_messages.id and r.status = 'open'))::int`,
      lastSeq: sql<number>`coalesce(max(${chatMessages.seq}), 0)::int`,
    })
    .from(chatMessages)
    .where(eq(chatMessages.showId, showId));

  const now = new Date();
  const silencedRows = await db
    .select({ paddle: paddles.number, wallet: profiles.walletAddress, kind: chatMutes.kind, until: chatMutes.until, reason: chatMutes.reason })
    .from(chatMutes)
    .innerJoin(profiles, eq(profiles.id, chatMutes.profileId))
    .leftJoin(paddles, and(eq(paddles.showId, chatMutes.showId), eq(paddles.profileId, chatMutes.profileId)))
    .where(and(eq(chatMutes.showId, showId), or(eq(chatMutes.kind, 'block'), gt(chatMutes.until, now))));

  return {
    messages: rows.map((r) => ({
      id: r.id, seq: seqOf(r.seq), at: iso(r.at), status: r.status as QueueMessage['status'], paddle: r.paddle, name: r.role === 'house' ? null : r.name, wallet: r.wallet, role: r.role as QueueMessage['role'],
      source: r.source as QueueMessage['source'], lotNumber: r.lotNumber, body: r.body, reports: r.reports, reportDetails: r.reportDetails, reason: r.reason, moderatedAt: r.moderatedAt ? iso(r.moderatedAt) : null,
    })),
    counts: { pending: counts.pending, approved: counts.approved, rejected: counts.rejected, reported: counts.reported },
    silenced: silencedRows.map((s) => ({ paddle: s.paddle, wallet: s.wallet, kind: s.kind as 'mute' | 'block', until: s.until ? iso(s.until) : null, reason: s.reason })),
    lastSeq: counts.lastSeq,
  };
}

export type ModerateAction =
  | { action: 'approve'; messageIds: string[] }
  | { action: 'reject'; messageIds: string[]; reason: string }
  | { action: 'mute'; paddle: number; minutes: number; reason: string }
  | { action: 'block'; paddle: number; reason: string }
  | { action: 'unsilence'; paddle: number };

/** One operator action. Returns how many rows changed (messages for approve and reject, wallets for the rest). Every action is written to audit_logs. */
export async function moderate(showId: string, actor: Actor, a: ModerateAction, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const show = await requireOperator(db, showId, actor);

  if (a.action === 'approve' || a.action === 'reject') {
    const approve = a.action === 'approve';
    const changed = await db
      .update(chatMessages)
      .set({ status: approve ? 'approved' : 'rejected', moderatedAt: now, moderatedBy: actor.profileId, hiddenReason: approve ? null : a.reason })
      .where(and(eq(chatMessages.showId, showId), inArray(chatMessages.id, a.messageIds), ne(chatMessages.status, approve ? 'approved' : 'rejected')))
      .returning({ id: chatMessages.id });
    if (changed.length > 0) {
      // A decision settles the reports on those messages: removing a reported message actions them, keeping one dismisses them.
      await db
        .update(chatReports)
        .set({ status: approve ? 'dismissed' : 'actioned', handledBy: actor.profileId, handledAt: now })
        .where(and(eq(chatReports.status, 'open'), inArray(chatReports.messageId, changed.map((c) => c.id))));
    }
    await audit(`chat.${a.action}`, actor.wallet, showId, { messageIds: changed.map((c) => c.id), reason: approve ? undefined : a.reason });
    return changed.length;
  }

  const [target] = await db
    .select({ profileId: paddles.profileId, wallet: profiles.walletAddress })
    .from(paddles)
    .innerJoin(profiles, eq(profiles.id, paddles.profileId))
    .where(and(eq(paddles.showId, showId), eq(paddles.number, a.paddle)))
    .limit(1);
  if (!target) throw new ApiError('not_found', 'There is no such bidder number in this show');
  if (isAuctioneer(target.wallet, show.sellerWallet, { isHouse: show.isHouse })) throw new ApiError('validation', 'The operator cannot be silenced', { reason: 'operator' });

  if (a.action === 'unsilence') {
    const gone = await db.delete(chatMutes).where(and(eq(chatMutes.showId, showId), eq(chatMutes.profileId, target.profileId))).returning({ p: chatMutes.profileId });
    await audit('chat.unsilence', actor.wallet, showId, { paddle: a.paddle });
    return gone.length;
  }

  const until = a.action === 'mute' ? new Date(now.getTime() + a.minutes * 60_000) : null;
  await db
    .insert(chatMutes)
    .values({ showId, profileId: target.profileId, kind: a.action, until, reason: a.reason, by: actor.profileId, createdAt: now })
    .onConflictDoUpdate({ target: [chatMutes.showId, chatMutes.profileId], set: { kind: a.action, until, reason: a.reason, by: actor.profileId, createdAt: now } });
  if (a.action === 'block') {
    // A blocked wallet's waiting messages are not worth the operator's clicks: reject them with the block's reason.
    await db
      .update(chatMessages)
      .set({ status: 'rejected', moderatedAt: now, moderatedBy: actor.profileId, hiddenReason: a.reason })
      .where(and(eq(chatMessages.showId, showId), eq(chatMessages.authorId, target.profileId), eq(chatMessages.status, 'pending')));
  }
  await audit(`chat.${a.action}`, actor.wallet, showId, { paddle: a.paddle, minutes: a.action === 'mute' ? a.minutes : undefined, reason: a.reason });
  return 1;
}

// ---------------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------------

/**
 * A signed-in viewer reports a PUBLIC message (the only ones they can see besides their own). The same message twice from one reporter is one
 * report. Nothing is removed automatically: the operator decides, and the count shows next to the message in the queue.
 */
export async function reportMessage(messageId: string, actor: Actor, input: { reason: string; detail?: string }): Promise<void> {
  const db = await getDb();
  const [msg] = await db.select({ id: chatMessages.id, showId: chatMessages.showId }).from(chatMessages).where(and(eq(chatMessages.id, messageId), eq(chatMessages.status, 'approved'))).limit(1);
  if (!msg) throw new ApiError('not_found', 'Message not found');
  await db.insert(chatReports).values({ messageId, reporterId: actor.profileId, reason: input.reason, detail: input.detail ?? null }).onConflictDoNothing();
  await audit('chat.report', actor.wallet, msg.showId, { messageId, reason: input.reason });
}
