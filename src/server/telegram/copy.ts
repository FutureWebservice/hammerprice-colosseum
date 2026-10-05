/**
 * The words of the bot, German and English, read from src/locales/{en,de}/telegram.json (the `bot` block) so the copy lives in one place
 * and the locale tests cover it. `{name}` placeholders only (no plurals, no markup): the text is sent as plain text.
 */
import en from '@/locales/en/telegram.json';
import de from '@/locales/de/telegram.json';
import type { Cluster } from '@/contracts/common';
import type { TelegramLocale } from '@/contracts/telegram';
import { SITE_URL } from '@/components/landing/site';
import { TELEGRAM_ACCOUNT_PATH } from '@/components/telegram/intent';

const BOT = { en: en.bot, de: de.bot } as const;
export type BotKey = keyof typeof en.bot;

/** The language of a Telegram user's `language_code` ("de", "de-AT" ...): German, otherwise English. */
export const localeFromTelegram = (code: string | undefined): TelegramLocale => (code ?? '').toLowerCase().startsWith('de') ? 'de' : 'en';

export function t(locale: TelegramLocale, key: BotKey, vars: Record<string, string | number> = {}): string {
  const raw = BOT[locale]?.[key] ?? BOT.en[key];
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** USDC base units (6 dp) as "120.00": cents only, like every other place that shows a price. */
export function usdc(base: bigint | string | number): string {
  const c = BigInt(base) / 10_000n;
  return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
}

/** USDC base units rounded UP to the cent as "120.00": a bid button must never name an amount below the minimum. */
export function usdcCeil(base: bigint): string {
  const c = (base + 9_999n) / 10_000n;
  return `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
}

/** Time left as "3 min" (rounded up, at least 1). */
export const minutesLeft = (ms: number): number => Math.max(1, Math.ceil(ms / 60_000));

/** A deadline in UTC, in the reader's date style: "03.10.2026, 12:30 UTC" (de) or "10/03/2026, 12:30 UTC" (en). */
export function when(at: Date, locale: TelegramLocale): string {
  const s = new Intl.DateTimeFormat(locale === 'de' ? 'de-DE' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' }).format(at);
  return `${s} UTC`;
}

/** Absolute links into the site. The path is locale-prefixed so the page opens in the reader's language. */
export const siteLink = (locale: TelegramLocale, path: string): string => `${SITE_URL}/${locale}${path}`;
export const roomLink = (locale: TelegramLocale, showId: string): string => siteLink(locale, `/room/${showId}`);
export const payLink = (locale: TelegramLocale, showId: string | null, settlementId: string, lotId: string): string =>
  showId ? siteLink(locale, `/room/${showId}?settle=${settlementId}`) : siteLink(locale, `/verify/${lotId}`);
/** The room with a bid filled in: `?lot=<number>&bid=<amount in USDC, at most two decimals>`. The room only pre-fills the confirmation; the person confirms and signs. */
export const bidLink = (locale: TelegramLocale, showId: string, lotNumber: number, amount: string): string => siteLink(locale, `/room/${showId}?lot=${lotNumber}&bid=${amount}`);
export const accountLink = (locale: TelegramLocale): string => siteLink(locale, TELEGRAM_ACCOUNT_PATH);

/** The explorer receipt of a settlement. Same rule as lib/chain/explorer.ts, which is the one place the explorer host is spelled. */
export async function receiptLink(signature: string, cluster: Cluster): Promise<string> {
  const { explorerTxUrl } = await import('@/lib/chain/explorer');
  return explorerTxUrl(signature, cluster);
}
