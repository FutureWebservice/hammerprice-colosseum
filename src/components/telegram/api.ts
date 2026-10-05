/** Typed wrappers for the Telegram link routes. Same conventions as components/account/api.ts; api.test.ts compares the path with ROUTES. */
import type { RouteRequest, RouteResponse } from '@/contracts/api';
import { call } from '@/components/sell/api';

export const TELEGRAM_LINK_PATH = '/api/telegram/link';

export const getTelegramStatus = (signal?: AbortSignal) => call<RouteResponse<'telegramStatus'>>('GET', TELEGRAM_LINK_PATH, { signal });
export const startTelegramLink = (body: RouteRequest<'telegramLink'>) => call<RouteResponse<'telegramLink'>>('POST', TELEGRAM_LINK_PATH, { body });
export const updateTelegramLink = (body: RouteRequest<'telegramUpdate'>) => call<RouteResponse<'telegramUpdate'>>('PATCH', TELEGRAM_LINK_PATH, { body });
export const unlinkTelegram = () => call<void>('DELETE', TELEGRAM_LINK_PATH);
