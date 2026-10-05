import { ApiError } from '@/contracts';
import { json } from '@/lib/http/respond';
import { route } from '@/lib/auth/route';
import { createBotApi } from '@/server/telegram/api';
import { handleUpdate } from '@/server/telegram/bot';
import { secretMatches } from '@/server/telegram/callback';
import { assertTelegramOn } from '@/server/telegram/config';

export const maxDuration = 30;
const MAX_UPDATE_BYTES = 64 * 1024;

/**
 * Telegram's webhook. Not a browser route: no session, no CORS. The caller proves itself with the secret it was registered with, sent in
 * `X-Telegram-Bot-Api-Secret-Token` and compared in constant time (a wrong or missing header is 401 and nothing is read). Once the secret matched
 * the answer is always 200 `{ ok: true }`, even if handling the update failed (that is logged without any value): an error status would only make
 * Telegram resend the same update.
 */
export const POST = route(async (req: Request) => {
  const cfg = await assertTelegramOn();
  if (!secretMatches(req.headers.get('x-telegram-bot-api-secret-token'), cfg.webhookSecret)) throw new ApiError('unauthenticated', 'Not authorised');
  const text = await req.text();
  if (text.length > MAX_UPDATE_BYTES) throw new ApiError('validation', 'Update too large');
  let update: unknown;
  try { update = JSON.parse(text); } catch { throw new ApiError('validation', 'Body is not valid JSON'); }
  try {
    await handleUpdate(update, { api: createBotApi(cfg), cfg });
  } catch (e) {
    console.error('telegram: update failed:', (e as Error)?.message ?? 'error');
  }
  return json({ ok: true });
});
