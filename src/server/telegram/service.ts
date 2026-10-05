/**
 * What the link routes answer: the status view of one profile's Telegram link, and the deep link of a new one.
 */
import type { z } from 'zod';
import type { TelegramStatusResponse } from '@/contracts/telegram';
import { DEFAULT_TELEGRAM_PREFS } from '@/contracts/telegram';
import { deepLink, type BotConfig } from './config';
import { createLinkToken, getLink } from './links';
import type { TelegramLocale, TelegramPrefs } from '@/contracts/telegram';

export type StatusView = z.infer<typeof TelegramStatusResponse>;

/** The answer while the feature is off: nothing to show. */
export const DISABLED_VIEW: StatusView = { enabled: false, linked: false, linkedAt: null, locale: null, prefs: DEFAULT_TELEGRAM_PREFS, botUsername: '' };

export async function statusView(profileId: string, cfg: Pick<BotConfig, 'username'>): Promise<StatusView> {
  const link = await getLink(profileId);
  return {
    enabled: true,
    linked: link !== null,
    linkedAt: link ? link.linkedAt.toISOString() : null,
    locale: link ? link.locale : null,
    prefs: link ? link.prefs : DEFAULT_TELEGRAM_PREFS,
    botUsername: cfg.username,
  };
}

export async function startLink(profileId: string, cfg: Pick<BotConfig, 'username'>, opts: { locale?: TelegramLocale; prefs?: Partial<TelegramPrefs> }, now?: Date): Promise<{ url: string; expiresAt: string }> {
  const { token, expiresAt } = await createLinkToken(profileId, opts, now);
  return { url: deepLink(cfg.username, token), expiresAt: expiresAt.toISOString() };
}
