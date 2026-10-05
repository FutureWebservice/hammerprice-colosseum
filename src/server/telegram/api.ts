/**
 * The Telegram Bot API, by plain `fetch` (no SDK). Three calls are enough: sendMessage, editMessageText and answerCallbackQuery. A call never throws: it answers a result the caller can branch on.
 *
 *   - 403 means the user blocked the bot or deleted the chat: `blocked: true`, and the caller unlinks the chat.
 *   - 429 carries `retry_after` seconds: `retryAfterS`, and the caller does not claim the notification so a later pass retries it.
 *   - The token sits in the request URL, so nothing here puts a URL, a header or an error object into a message or a log: a failure is
 *     described by the HTTP status and Telegram's own `description` only.
 *
 * Messages are sent as PLAIN TEXT (no parse_mode): chat messages and card names are user input and must never be read as markup.
 */
import type { BotConfig } from './config';

export const TELEGRAM_API = 'https://api.telegram.org';
const TIMEOUT_MS = 5000;
/** Telegram refuses more than 4096 characters; our messages are far shorter, this is a seatbelt. */
const MAX_TEXT = 4000;

/** A button either answers the bot (`callback_data`) or opens a link (`url`). A link button never tells the bot anything: opening it is the user's own tap in their own browser. */
export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type ReplyMarkup = { inline_keyboard: InlineButton[][] };

export type CallResult<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; status: number; blocked: boolean; retryAfterS?: number; description: string };

export interface BotApi {
  sendMessage(chatId: number, text: string, markup?: ReplyMarkup): Promise<CallResult<{ message_id: number }>>;
  editMessageText(chatId: number, messageId: number, text: string, markup?: ReplyMarkup): Promise<CallResult>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<CallResult>;
}

type FetchLike = typeof fetch;

async function call<T>(cfg: Pick<BotConfig, 'token'>, method: string, body: Record<string, unknown>, doFetch: FetchLike): Promise<CallResult<T>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(`${TELEGRAM_API}/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
      cache: 'no-store',
    });
    let data: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } = {};
    try { data = await res.json(); } catch { /* not JSON: described by the status below */ }
    if (res.ok && data.ok === true) return { ok: true, result: data.result as T };
    const status = data.error_code ?? res.status;
    const retry = data.parameters?.retry_after;
    return { ok: false, status, blocked: status === 403, retryAfterS: typeof retry === 'number' ? retry : undefined, description: String(data.description ?? `HTTP ${res.status}`).slice(0, 200) };
  } catch (e) {
    // Never `e.message`: a fetch error can carry the URL, and the URL carries the token.
    return { ok: false, status: 0, blocked: false, description: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

export function createBotApi(cfg: Pick<BotConfig, 'token'>, doFetch: FetchLike = (...a) => fetch(...a)): BotApi {
  return {
    sendMessage: (chatId, text, markup) =>
      call(cfg, 'sendMessage', { chat_id: chatId, text: text.slice(0, MAX_TEXT), link_preview_options: { is_disabled: true }, ...(markup ? { reply_markup: markup } : {}) }, doFetch),
    editMessageText: (chatId, messageId, text, markup) =>
      call(cfg, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text.slice(0, MAX_TEXT), link_preview_options: { is_disabled: true }, reply_markup: markup ?? { inline_keyboard: [] } }, doFetch),
    answerCallbackQuery: (id, text) => call(cfg, 'answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 200) } : {}) }, doFetch),
  };
}
