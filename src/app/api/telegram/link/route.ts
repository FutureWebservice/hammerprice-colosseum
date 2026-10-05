import { TelegramLinkRequest, TelegramUpdateRequest } from '@/contracts';
import { json, noContent } from '@/lib/http/respond';
import { assertSameOrigin } from '@/lib/http/origin';
import { assertRate, rateLimitWallet } from '@/lib/http/ratelimit';
import { readBody, route } from '@/lib/auth/route';
import { requireSessionProfile } from '@/lib/auth/session';
import { assertTelegramOn, telegramConfig } from '@/server/telegram/config';
import { unlinkProfile, updateLink } from '@/server/telegram/links';
import { DISABLED_VIEW, startLink, statusView } from '@/server/telegram/service';

/**
 * The signed-in user's Telegram link. GET reads it, POST starts one (answers the one-time deep link), PATCH changes the language or the opt-in
 * switches, DELETE unlinks. While FEATURE_TELEGRAM is off or the bot is not configured GET answers `enabled: false` and the other methods `feature_off` (404).
 */
export const GET = route(async (req: Request) => {
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('tg-status', session.wallet, 60, 60, { failOpen: true }));
  const cfg = await telegramConfig();
  return json(cfg ? await statusView(profile.id, cfg) : DISABLED_VIEW); // off: a plain 200 "not enabled", so the account page shows nothing and the console stays clean
});

export const POST = route(async (req: Request) => {
  const cfg = await assertTelegramOn();
  const body = await readBody(req, TelegramLinkRequest);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('tg-link', session.wallet, 5, 600));
  return json(await startLink(profile.id, cfg, body));
});

export const PATCH = route(async (req: Request) => {
  const cfg = await assertTelegramOn();
  const body = await readBody(req, TelegramUpdateRequest);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('tg-update', session.wallet, 30, 60));
  await updateLink(profile.id, body);
  return json(await statusView(profile.id, cfg));
});

export const DELETE = route(async (req: Request) => {
  await assertTelegramOn();
  assertSameOrigin(req);
  const { session, profile } = await requireSessionProfile(req);
  assertRate(await rateLimitWallet('tg-unlink', session.wallet, 30, 60));
  await unlinkProfile(profile.id);
  return noContent();
});
