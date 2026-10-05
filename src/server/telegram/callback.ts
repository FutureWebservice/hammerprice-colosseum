/**
 * Signed callback data for the moderation buttons. Telegram allows 64 bytes of `callback_data`, so the layout is compact:
 *
 *   <action: a | r | m> <message id: 16 bytes, base64url, 22 chars> <signature: 12 bytes of HMAC-SHA-256, base64url, 16 chars>   = 39 characters
 *
 * The HMAC key is derived from TELEGRAM_WEBHOOK_SECRET (a server secret that never leaves the server) and the signed text names the action, the
 * message AND the chat the button was sent to, so a button cannot be replayed for another message, another action or from another chat.
 * The signature only proves "we made this button for this chat". WHO may press it is checked separately against the operator list (bot.ts).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CALLBACK_ACTIONS = { a: 'approve', r: 'reject', m: 'mute' } as const;
export type CallbackAction = (typeof CALLBACK_ACTIONS)[keyof typeof CALLBACK_ACTIONS];
const CODE: Record<CallbackAction, string> = { approve: 'a', reject: 'r', mute: 'm' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHAPE = /^[arm][A-Za-z0-9_-]{22}[A-Za-z0-9_-]{16}$/;

const key = (secret: string): Buffer => createHmac('sha256', 'hammerprice:telegram:callback:v1').update(secret).digest();
const mac = (secret: string, action: CallbackAction, messageId: string, chatId: number): string =>
  createHmac('sha256', key(secret)).update(`${CODE[action]}|${messageId}|${chatId}`).digest().subarray(0, 12).toString('base64url');

export function signCallback(secret: string, action: CallbackAction, messageId: string, chatId: number): string {
  const id = messageId.toLowerCase();
  if (!UUID.test(id)) throw new Error('callback needs a uuid');
  return `${CODE[action]}${Buffer.from(id.replaceAll('-', ''), 'hex').toString('base64url')}${mac(secret, action, id, chatId)}`;
}

/** The action and message id of a genuine button for this chat, or null for anything else (wrong shape, other chat, tampered). */
export function verifyCallback(secret: string, data: string | undefined, chatId: number): { action: CallbackAction; messageId: string } | null {
  if (!data || data.length !== 39 || !SHAPE.test(data)) return null;
  const action = CALLBACK_ACTIONS[data[0] as keyof typeof CALLBACK_ACTIONS];
  const hex = Buffer.from(data.slice(1, 23), 'base64url').toString('hex');
  if (hex.length !== 32) return null;
  const messageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const given = Buffer.from(data.slice(23));
  const want = Buffer.from(mac(secret, action, messageId, chatId));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return { action, messageId };
}

/** The webhook header check: constant time (both sides hashed so the lengths match), and no secret configured means nobody gets in. */
export function secretMatches(given: string | null, secret: string): boolean {
  if (!secret) return false;
  const h = (s: string) => createHmac('sha256', 'hammerprice:telegram:header').update(s).digest();
  return timingSafeEqual(h(given ?? ''), h(secret));
}
