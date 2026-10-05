/**
 * The browser half of the room chat that has no React in it: calls to the chat routes with their answers checked against the contract, the
 * polling delays, the error keys and the local block list. Tested without a DOM.
 */
import { ChatListResponse, ChatMineResponse, ChatModerateResponse, ChatPostResponse, ChatQueueResponse, ChatReportResponse, ErrorResponseSchema, type ChatOwnMessage } from '@/contracts';
import type { z } from 'zod';

export type PublicList = z.infer<typeof ChatListResponse>;
export type Mine = z.infer<typeof ChatMineResponse>;
export type Queue = z.infer<typeof ChatQueueResponse>;
export type QueueFilter = 'pending' | 'approved' | 'rejected' | 'reported' | 'all';
export type ReportReason = 'illegal' | 'spam' | 'harassment' | 'scam' | 'other';

export class ChatError extends Error {
  constructor(readonly code: string, readonly status: number, readonly detail: string, readonly reasonKey: string | null = null) {
    super(detail);
    this.name = 'ChatError';
  }
}

async function call<S extends z.ZodTypeAny>(url: string, schema: S, init: RequestInit = {}): Promise<z.output<S>> {
  let res: Response;
  try {
    res = await fetch(url, { cache: 'no-store', ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers } });
  } catch {
    throw new ChatError('network', 0, 'network');
  }
  const raw: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = ErrorResponseSchema.safeParse(raw);
    if (!e.success) throw new ChatError('http', res.status, `HTTP ${res.status}`);
    // A refused message names its rule in `reason` (link, contact_data, ...); every other error carries a sentence there.
    throw new ChatError(e.data.code, res.status, e.data.reason, e.data.code === 'validation' ? e.data.reason : null);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ChatError('shape', res.status, 'shape');
  return parsed.data;
}

const base = (showId: string): string => `/api/shows/${encodeURIComponent(showId)}/chat`;

export const fetchPublic = (showId: string): Promise<PublicList> => call(base(showId), ChatListResponse);
export const fetchMine = (showId: string): Promise<Mine> => call(`${base(showId)}/mine`, ChatMineResponse);
export const fetchQueue = (showId: string, filter: QueueFilter): Promise<Queue> => call(`${base(showId)}/queue?filter=${filter}&limit=50`, ChatQueueResponse);

export async function sendMessage(showId: string, input: { body: string; clientNonce: string; lotNumber?: number }): Promise<ChatOwnMessage> {
  const r = await call(base(showId), ChatPostResponse, { method: 'POST', body: JSON.stringify(input) });
  return r.message;
}

export type ModerateBody =
  | { action: 'approve'; messageIds: string[] }
  | { action: 'reject'; messageIds: string[]; reason: string }
  | { action: 'mute'; paddle: number; minutes: number; reason: string }
  | { action: 'block'; paddle: number; reason: string }
  | { action: 'unsilence'; paddle: number }
  | { action: 'publish'; body: string; source?: 'user' | 'assistant'; lotNumber?: number; clientNonce: string };

export const moderate = (showId: string, body: ModerateBody): Promise<z.infer<typeof ChatModerateResponse>> =>
  call(`${base(showId)}/moderate`, ChatModerateResponse, { method: 'POST', body: JSON.stringify(body) });

export async function reportMessage(messageId: string, reason: ReportReason, detail?: string): Promise<void> {
  await call(`/api/chat/${encodeURIComponent(messageId)}/report`, ChatReportResponse, { method: 'POST', body: JSON.stringify({ reason, ...(detail ? { detail } : {}) }) });
}

/** Is there a session at all? 204 (or 401 from an older deploy) is "signed out": no error in the console, unlike the chat routes. */
export async function hasSession(showId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/me?show=${encodeURIComponent(showId)}`, { cache: 'no-store' });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---- polling -------------------------------------------------------------------------------

export const POLL_OPEN_MS = 3_000;
export const POLL_CLOSED_MS = 10_000;
export const POLL_OFF_MS = 60_000;
export const POLL_MAX_BACKOFF_MS = 30_000;

/** How long to wait before the next poll: open panel fast, closed slow, a disabled chat rarely; doubles per consecutive error; +-10 % jitter. */
export function pollDelayMs(o: { open: boolean; enabled: boolean; errorStreak: number; random?: number }): number {
  const base = !o.enabled ? POLL_OFF_MS : o.open ? POLL_OPEN_MS : POLL_CLOSED_MS;
  const backed = Math.min(Math.max(POLL_MAX_BACKOFF_MS, base), base * 2 ** Math.min(o.errorStreak, 5));
  return Math.round(backed * (0.9 + (o.random ?? 0.5) * 0.2));
}

// ---- errors --------------------------------------------------------------------------------

/** The translation key (under `error.`) for a failed call. */
export function errorKey(e: unknown): string {
  if (!(e instanceof ChatError)) return 'generic';
  if (e.reasonKey && ['empty', 'too_long', 'link', 'contact_data', 'shouting', 'duplicate', 'lot', 'operator'].includes(e.reasonKey)) return `reason.${e.reasonKey}`;
  switch (e.code) {
    case 'network': return 'network';
    case 'unauthenticated': return 'signin';
    case 'no_paddle': return 'no_paddle';
    case 'muted': return 'muted';
    case 'banned': return 'banned';
    case 'rate_limited': return 'rate_limited';
    case 'show_ended': return 'show_ended';
    case 'feature_off': return 'feature_off';
    case 'not_seller': return 'not_operator';
    default: return 'generic';
  }
}

// ---- the viewer's own block list (per show, this page only) ---------------------------------------
// Held in memory, not in browser storage: a stored list would be one more entry in the cookies and storage table of the privacy text
// (src/legal/tables.ts). It lasts until the page is reloaded; if the table lists a storage key later, only these two functions change.

const blockedByShow = new Map<string, number[]>();

export const readBlocked = (showId: string): number[] => blockedByShow.get(showId) ?? [];

export function writeBlocked(showId: string, list: number[]): void {
  blockedByShow.set(showId, list.filter((n) => Number.isInteger(n) && n > 0).slice(0, 200));
}

/** A random v4 UUID for the idempotency key of one message (crypto.randomUUID needs a secure context; the fallback is only for a plain-http dev server). */
export const newNonce = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
};
