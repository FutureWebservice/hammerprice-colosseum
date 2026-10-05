/**
 * Telegram notifications (FEATURE_TELEGRAM, default off), contract only. A signed-in user links ONE private Telegram chat to their wallet with a
 * one-time deep link (https://t.me/<bot>?start=<token>), picks which kinds of message they want (opt-in per type), and can unlink at any time
 * (here, or with /stop in the chat). Only the chat id, the language and these switches are stored.
 *
 * The webhook (`POST /api/telegram/webhook`) is called by Telegram only and is not part of the browser contract: its body is Telegram's own
 * Update object, checked with the `X-Telegram-Bot-Api-Secret-Token` header, and it always answers `{ ok: true }` once the secret matched.
 */
import { z } from 'zod';
import { IsoTime } from './common';

/**
 * The notification types, each opt-in:
 *   outbid       someone bid more than you on a lot
 *   ending_soon  a lot you bid on is about to close (best effort: only when a bid or the daily sweep processes the lot)
 *   won          you won a lot and payment is due (with the pay link)
 *   settled      a settlement finished (the card and the explorer link)
 *   show_start   a show you registered a bidder number for has started
 *   deadline     your payment deadline is close (sent by the daily sweep)
 *   moderation   a chat message waits for you (only for a room operator), with Approve, Reject and Mute buttons
 *   pack_delivery  a pack you operate was paid and drawn: you must deliver the card in time (A14), and a reminder when the deadline is close
 *   lot_watch    one short message when each of the next lots of a room you chose with /watch opens, with buttons that open the room with a bid filled in
 *                (the bot never bids: you confirm and sign in your own wallet)
 */
export const TELEGRAM_TYPES = ['outbid', 'ending_soon', 'won', 'settled', 'show_start', 'deadline', 'moderation', 'pack_delivery', 'lot_watch'] as const;
export const TelegramType = z.enum(TELEGRAM_TYPES);
export type TelegramType = z.infer<typeof TelegramType>;

export const TelegramLocale = z.enum(['en', 'de']);
export type TelegramLocale = z.infer<typeof TelegramLocale>;

export const TelegramPrefs = z
  .object({ outbid: z.boolean(), ending_soon: z.boolean(), won: z.boolean(), settled: z.boolean(), show_start: z.boolean(), deadline: z.boolean(), moderation: z.boolean(), pack_delivery: z.boolean(), lot_watch: z.boolean() })
  .strict();
export type TelegramPrefs = z.infer<typeof TelegramPrefs>;
export const TelegramPrefsInput = TelegramPrefs.partial().strict();

/** What a link starts with when the request names no preference: the messages about money that is yours, nothing else. */
export const DEFAULT_TELEGRAM_PREFS: TelegramPrefs = { outbid: true, ending_soon: false, won: true, settled: true, show_start: false, deadline: true, moderation: false, pack_delivery: true, lot_watch: false };

/**
 * `GET /api/telegram/link`. `enabled` is false (with the rest empty, `botUsername` an empty string) while the feature is off or the bot is not configured:
 * a plain 200, so the account page shows nothing and the browser console stays clean. The other three methods answer `feature_off` (404) then.
 * `botUsername` is public.
 */
export const TelegramStatusResponse = z
  .object({
    enabled: z.boolean(),
    linked: z.boolean(),
    linkedAt: IsoTime.nullable(),
    locale: TelegramLocale.nullable(),
    prefs: TelegramPrefs,
    botUsername: z.string(),
  })
  .strict();

/** `POST /api/telegram/link`: starts a link. The token is in the returned deep link only; the server keeps its hash. */
export const TelegramLinkRequest = z.object({ locale: TelegramLocale.optional(), prefs: TelegramPrefsInput.optional() }).strict();
export const TelegramLinkResponse = z.object({ url: z.string().url().max(200), expiresAt: IsoTime }).strict();

/** `PATCH /api/telegram/link`: change the switches or the language of a linked chat. */
export const TelegramUpdateRequest = z
  .object({ locale: TelegramLocale.optional(), prefs: TelegramPrefsInput.optional() })
  .strict()
  .refine((b) => b.locale !== undefined || (b.prefs !== undefined && Object.keys(b.prefs).length > 0), 'at least one field');

export const TelegramWebhookResponse = z.object({ ok: z.literal(true) }).strict();
