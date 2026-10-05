/**
 * The Telegram configuration and its gate. The feature is on only when FEATURE_TELEGRAM is on (lib/features.ts: environment AND the
 * app_flags kill switch `telegram`) AND all three names are present and well formed. A missing or malformed name means "off", never a
 * half-working bot: the routes then answer `feature_off` (404) as if they did not exist. Nothing here ever prints or returns a secret.
 *
 *   TELEGRAM_BOT_TOKEN       from @BotFather, `<digits>:<35 or so url-safe characters>`; secret; one bot per environment
 *   TELEGRAM_BOT_USERNAME    the bot's @name (the @ is optional here); builds the t.me deep link
 *   TELEGRAM_WEBHOOK_SECRET  16 to 256 characters of A-Z a-z 0-9 _ - ; the header Telegram sends, and the key of the moderation buttons
 */
import { ApiError } from '@/contracts/errors';
import { featureOn } from '@/lib/features';

type Env = Record<string, string | undefined>;

export interface BotConfig { token: string; username: string; webhookSecret: string }

const TOKEN = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const SECRET = /^[A-Za-z0-9_-]{16,256}$/;

/** The bot configuration, or null when any of the three names is missing or malformed. Never throws, never includes a value in an error. */
export function botConfig(env: Env = process.env): BotConfig | null {
  const token = env.TELEGRAM_BOT_TOKEN ?? '';
  const username = (env.TELEGRAM_BOT_USERNAME ?? '').replace(/^@/, '');
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!TOKEN.test(token) || !USERNAME.test(username) || !SECRET.test(webhookSecret)) return null;
  return { token, username, webhookSecret };
}

/** The configuration when the feature is on and complete, else null. The database is read only when the environment already says yes. */
export async function telegramConfig(env: Env = process.env): Promise<BotConfig | null> {
  const cfg = botConfig(env);
  if (!cfg) return null;
  return (await featureOn('TELEGRAM', env)) ? cfg : null;
}

/** For the routes: the configuration, or `feature_off` (404). */
export async function assertTelegramOn(env: Env = process.env): Promise<BotConfig> {
  const cfg = await telegramConfig(env);
  if (!cfg) throw new ApiError('feature_off', 'Telegram is not available here.');
  return cfg;
}

/** https://t.me/<bot>?start=<token>. The token is base64url, so it needs no escaping. */
export const deepLink = (username: string, token: string): string => `https://t.me/${username}?start=${token}`;
