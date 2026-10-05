/**
 * What the webhook does with an update from Telegram. Only three kinds matter:
 *
 *   message          /start <token> (link), /start, /stop (unlink), /status, /help, anything else gets the short list. Private chats only.
 *   callback_query   the Approve / Reject / Mute buttons of a pending chat message. The data must carry our signature for THIS chat (callback.ts),
 *                    the chat must be linked, and the linked wallet must be the room operator: the decision is made by the chat service itself
 *                    (`moderate` throws not_seller for anyone else), the same code the operator panel uses.
 *   my_chat_member   the user blocked or removed the bot: the chat is unlinked at once.
 *
 * Everything else is ignored. Handlers are idempotent (Telegram retries an update when we do not answer in time): a link token works once, a
 * moderation decision on an already decided message says so. Replies are plain text.
 */
import { z } from 'zod';
import { and, eq, gt, ne, sql } from 'drizzle-orm';
import { DEMO_SHOW_ID } from '@/lib/demo-show';
import { ApiError } from '@/contracts/errors';
import { bids, chatMessages, lots, profiles, settlements, shows } from '@/db/schema';
import { featureOn } from '@/lib/features';
import { rateLimit } from '@/lib/http/ratelimit';
import type { BotApi, ReplyMarkup } from './api';
import { verifyCallback } from './callback';
import type { BotConfig } from './config';
import { accountLink, localeFromTelegram, payLink, t, usdc, when, type BotKey } from './copy';
import { consumeLinkToken, getLinkByChat, unlinkChat, type Link } from './links';
import { CHAT_LIMIT_PER_MIN, MUTE_MINUTES } from './notify';
import { WATCH_BUTTON_COUNTS, clearWatches, listWatches, parseWatchArg, parseWatchCallback, pickWatchShow, setWatch, watchCallback, type WatchCount } from './watch';
import type { TelegramLocale } from '@/contracts/telegram';

async function getDb() {
  return (await import('@/db')).db;
}

const User = z.object({ id: z.number(), language_code: z.string().optional() }).passthrough();
const Chat = z.object({ id: z.number(), type: z.string() }).passthrough();
const Update = z
  .object({
    message: z.object({ message_id: z.number(), text: z.string().max(4096).optional(), chat: Chat, from: User.optional() }).passthrough().optional(),
    callback_query: z
      .object({ id: z.string(), from: User, data: z.string().max(256).optional(), message: z.object({ message_id: z.number(), text: z.string().optional(), chat: Chat }).passthrough().optional() })
      .passthrough()
      .optional(),
    my_chat_member: z.object({ chat: Chat, new_chat_member: z.object({ status: z.string() }).passthrough() }).passthrough().optional(),
  })
  .passthrough();

export interface BotDeps { api: BotApi; cfg: BotConfig; now?: Date }

/** Runs one update. Never throws for a malformed update (it is ignored); a failing database call propagates so the route can log it. */
export async function handleUpdate(raw: unknown, deps: BotDeps): Promise<void> {
  const parsed = Update.safeParse(raw);
  if (!parsed.success) return;
  const u = parsed.data;
  if (u.callback_query) return handleCallback(u.callback_query, deps);
  if (u.my_chat_member) {
    const { chat, new_chat_member } = u.my_chat_member;
    if (chat.type === 'private' && (new_chat_member.status === 'kicked' || new_chat_member.status === 'left')) await unlinkChat(chat.id);
    return;
  }
  if (u.message?.text && u.message.chat.type === 'private') return handleMessage(u.message as { text: string; chat: { id: number }; from?: { language_code?: string } }, deps);
}

/** A reply in a private chat, within the per-chat limit (over it, the reply is dropped: the user is not waiting on a robot's second answer). */
async function reply(deps: BotDeps, chatId: number, text: string, markup?: ReplyMarkup): Promise<void> {
  if (!(await rateLimit(`tg:chat:${chatId}`, CHAT_LIMIT_PER_MIN, 60, { failOpen: true })).ok) return;
  await deps.api.sendMessage(chatId, text, markup);
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

const COMMAND = /^\/([A-Za-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+(.*))?$/s;

async function handleMessage(m: { text: string; chat: { id: number }; from?: { language_code?: string } }, deps: BotDeps): Promise<void> {
  const chatId = m.chat.id;
  const link = await getLinkByChat(chatId);
  const locale: TelegramLocale = link?.locale ?? localeFromTelegram(m.from?.language_code);
  const say = (key: BotKey, vars: Record<string, string | number> = {}) => reply(deps, chatId, t(locale, key, { account: accountLink(locale), ...vars }));

  const cmd = COMMAND.exec(m.text.trim());
  if (!cmd) return say('unknown');
  if (cmd[2] && cmd[2].toLowerCase() !== deps.cfg.username.toLowerCase()) return; // a command for another bot in the same chat
  const name = cmd[1].toLowerCase();
  const arg = (cmd[3] ?? '').trim();

  if (name === 'start') {
    if (arg) {
      const bound = await consumeLinkToken(arg, chatId, deps.now);
      if (!bound) return say('linkInvalid');
      return reply(deps, chatId, t(bound.locale, 'welcome', { account: accountLink(bound.locale) }));
    }
    return say(link ? 'alreadyLinked' : 'notLinked');
  }
  if (name === 'stop') {
    const was = await unlinkChat(chatId);
    return say(was ? 'stopped' : 'stopNotLinked');
  }
  if (name === 'help') return say('help');
  if (name === 'watch') return link ? watchCommand(deps, link, arg) : say('notLinked');
  if (name === 'unwatch') return link ? say((await clearWatches(link.profileId)) > 0 ? 'unwatched' : 'unwatchNone') : say('notLinked');
  if (name === 'status') {
    if (!link) return say('notLinked');
    return reply(deps, chatId, await statusText(link, deps.now ?? new Date()));
  }
  return say('unknown');
}

/** /status: the open bids (leading or outbid) and the payments still to make, with their pay links. */
export async function statusText(link: Link, now: Date): Promise<string> {
  const db = await getDb();
  const mine = await db
    .select({ lotId: lots.id, name: lots.name, highBid: lots.highBid, highBidderId: lots.highBidderId, myBid: sql<bigint>`max(${bids.amount})` })
    .from(bids)
    .innerJoin(lots, eq(lots.id, bids.lotId))
    .where(and(eq(bids.bidderId, link.profileId), eq(lots.state, 'open')))
    .groupBy(lots.id)
    .limit(10);
  const owed = await db
    .select({ id: settlements.id, lotId: settlements.lotId, gross: settlements.grossAmount, dueAt: settlements.dueAt, lotName: lots.name, showId: lots.showId })
    .from(settlements)
    .innerJoin(lots, eq(lots.id, settlements.lotId))
    .where(and(eq(settlements.buyerId, link.profileId), eq(settlements.status, 'awaiting_payment'), gt(settlements.dueAt, now)))
    .orderBy(settlements.dueAt)
    .limit(10);
  const watching = await listWatches(link.profileId);
  if (mine.length === 0 && owed.length === 0 && watching.length === 0) return t(link.locale, 'statusEmpty');
  const parts: string[] = [];
  if (mine.length) {
    parts.push(t(link.locale, 'statusBids'));
    for (const b of mine) {
      const leading = b.highBidderId === link.profileId;
      parts.push(t(link.locale, leading ? 'statusBidLeading' : 'statusBidOutbid', { lot: b.name, amount: usdc(leading ? BigInt(b.myBid) : (b.highBid ?? 0n)) }));
    }
  }
  if (owed.length) {
    if (parts.length) parts.push('');
    parts.push(t(link.locale, 'statusPay'));
    for (const o of owed) parts.push(t(link.locale, 'statusPayLine', { lot: o.lotName, amount: usdc(o.gross), due: when(o.dueAt!, link.locale), link: payLink(link.locale, o.showId, o.id, o.lotId) }));
  }
  if (watching.length) {
    if (parts.length) parts.push('');
    parts.push(t(link.locale, 'statusWatch'));
    for (const w of watching) parts.push(t(link.locale, 'statusWatchLine', { show: w.title, left: w.remaining === null ? t(link.locale, 'watchLeftAll') : t(link.locale, 'watchLeft', { n: w.remaining }) }));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Watch a room (/watch, the "Watch this room" button of the show-start message)
// ---------------------------------------------------------------------------------------------

/** The question "how many of the next lots?" for one room, with the four buttons. The text says plainly that nothing is ever bid for the person. */
function watchAsk(link: Link, show: { id: string; title: string }): { text: string; markup: ReplyMarkup } {
  const buttons = [...WATCH_BUTTON_COUNTS.map((n) => ({ text: t(link.locale, 'watchNext', { n }), callback_data: watchCallback(n, show.id) })), { text: t(link.locale, 'watchAll'), callback_data: watchCallback(null, show.id) }];
  return { text: t(link.locale, 'watchAsk', { show: show.title }), markup: { inline_keyboard: [buttons] } };
}

const watchedText = (link: Link, show: { title: string }, count: WatchCount): string => t(link.locale, count === null ? 'watchOnAll' : 'watchOn', { n: count ?? 0, show: show.title });

/** /watch (pick the room and ask how many), /watch 5 or /watch all (start at once). Only a linked chat gets here. */
async function watchCommand(deps: BotDeps, link: Link, arg: string): Promise<void> {
  const count = parseWatchArg(arg);
  if (count === false) return reply(deps, link.chatId, t(link.locale, 'watchBad'));
  const show = await pickWatchShow(link.profileId, deps.now);
  if (!show) return reply(deps, link.chatId, t(link.locale, 'watchNone'));
  if (count === undefined) { const a = watchAsk(link, show); return reply(deps, link.chatId, a.text, a.markup); }
  const started = await setWatch(link, show.id, count, deps.now);
  return reply(deps, link.chatId, started ? watchedText(link, started, count) : t(link.locale, 'watchNone'));
}

/** A press on one of the watch buttons. Not signed (see watch.ts): all it can do is start or restart the pressing chat's own watch of a room that exists. */
async function handleWatchCallback(q: CallbackQuery, w: NonNullable<ReturnType<typeof parseWatchCallback>>, deps: BotDeps): Promise<void> {
  const chat = q.message?.chat;
  const answer = (text: string) => deps.api.answerCallbackQuery(q.id, text);
  const locale = localeFromTelegram(q.from.language_code);
  if (!chat || chat.type !== 'private' || chat.id !== q.from.id) { await answer(t(locale, 'cbInvalid')); return; }
  const link = await getLinkByChat(chat.id);
  if (!link) { await answer(t(locale, 'cbNotLinked')); return; }
  const db = await getDb();
  const [show] = await db.select({ id: shows.id, title: shows.title }).from(shows).where(and(eq(shows.id, w.showId), sql`${shows.status} <> 'ended'`, eq(shows.kind, 'live'), ne(shows.id, DEMO_SHOW_ID))).limit(1);
  if (!show) { await answer(t(link.locale, 'watchGone')); return; }
  if (w.step === 'pick') {
    await answer('');
    const a = watchAsk(link, show);
    await reply(deps, chat.id, a.text, a.markup);
    return;
  }
  const started = await setWatch(link, show.id, w.count, deps.now);
  if (!started) { await answer(t(link.locale, 'watchGone')); return; }
  await answer(t(link.locale, 'cbSaved'));
  if (q.message) await deps.api.editMessageText(chat.id, q.message.message_id, watchedText(link, started, w.count)); // removes the buttons
}

// ---------------------------------------------------------------------------------------------
// The moderation buttons
// ---------------------------------------------------------------------------------------------

type CallbackQuery = NonNullable<z.infer<typeof Update>['callback_query']>;

async function handleCallback(q: CallbackQuery, deps: BotDeps): Promise<void> {
  const watch = parseWatchCallback(q.data);
  if (watch) return handleWatchCallback(q, watch, deps);
  const chat = q.message?.chat;
  const answer = (text: string) => deps.api.answerCallbackQuery(q.id, text);
  const locale = localeFromTelegram(q.from.language_code);
  if (!chat || chat.type !== 'private' || chat.id !== q.from.id) { await answer(t(locale, 'cbInvalid')); return; }

  const link = await getLinkByChat(chat.id);
  if (!link) { await answer(t(locale, 'cbNotLinked')); return; }
  const signed = verifyCallback(deps.cfg.webhookSecret, q.data, chat.id);
  if (!signed) { await answer(t(link.locale, 'cbInvalid')); return; }
  if (!(await featureOn('CHAT'))) { await answer(t(link.locale, 'cbOff')); return; }

  const db = await getDb();
  const [msg] = await db.select({ id: chatMessages.id, showId: chatMessages.showId, body: chatMessages.body, paddle: chatMessages.paddleNumber }).from(chatMessages).where(eq(chatMessages.id, signed.messageId)).limit(1);
  const [me] = await db.select({ wallet: profiles.walletAddress }).from(profiles).where(eq(profiles.id, link.profileId)).limit(1);
  if (!msg || !me) { await answer(t(link.locale, 'cbInvalid')); return; }

  const chatSvc = await import('@/server/chat/service');
  const actor = { profileId: link.profileId, wallet: me.wallet };
  let done: 'approved' | 'rejected' | 'muted' | 'handled';
  try {
    if (signed.action === 'approve') {
      done = (await chatSvc.moderate(msg.showId, actor, { action: 'approve', messageIds: [msg.id] }, deps.now)) > 0 ? 'approved' : 'handled';
    } else if (signed.action === 'reject') {
      done = (await chatSvc.moderate(msg.showId, actor, { action: 'reject', messageIds: [msg.id], reason: 'Rejected by the room operator' }, deps.now)) > 0 ? 'rejected' : 'handled';
    } else {
      if (msg.paddle != null) await chatSvc.moderate(msg.showId, actor, { action: 'mute', paddle: msg.paddle, minutes: MUTE_MINUTES, reason: 'Muted by the room operator' }, deps.now);
      done = (await chatSvc.moderate(msg.showId, actor, { action: 'reject', messageIds: [msg.id], reason: 'Muted by the room operator' }, deps.now)) > 0 ? 'muted' : 'handled';
    }
  } catch (e) {
    if (e instanceof ApiError && (e.code === 'not_seller' || e.code === 'validation')) { await answer(t(link.locale, 'cbNotAllowed')); return; }
    throw e;
  }

  if (done === 'handled') { await answer(t(link.locale, 'cbHandled')); } else {
    await answer(t(link.locale, done === 'approved' ? 'cbApproved' : done === 'rejected' ? 'cbRejected' : 'cbMuted', { minutes: MUTE_MINUTES }));
    const body = msg.body;
    const text = done === 'approved' ? t(link.locale, 'resultApproved', { body }) : done === 'rejected' ? t(link.locale, 'resultRejected', { body }) : t(link.locale, 'resultMuted', { paddle: msg.paddle ?? '-', minutes: MUTE_MINUTES, body });
    if (q.message) await deps.api.editMessageText(chat.id, q.message.message_id, text); // removes the buttons
  }
}
