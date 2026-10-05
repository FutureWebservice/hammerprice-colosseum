import type { z } from 'zod';
import type { ChatListResponse } from '@/contracts/chat';
import { createMemo } from '@/lib/http/memo';

export type ChatList = z.infer<typeof ChatListResponse>;

/** CHAT_LIST_MEMO_MS overrides the 1 s (0 = no remembering, only the sharing of requests in flight together; tests). */
const ttl = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.CHAT_LIST_MEMO_MS);
  return env.CHAT_LIST_MEMO_MS !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(n, 5000) : 1000;
};

/** One load per show per instance per second, however many viewers poll (a random query string does not get around it). */
let memo = createMemo<ChatList>(ttl());
export const chatListMemo = {
  get: (showId: string, load: () => Promise<ChatList>): Promise<ChatList> => memo.get(showId, load),
  clear: (): void => memo.clear(),
  /** Tests only: change how long an answer is remembered. */
  setTtlMs: (ms: number): void => { memo = createMemo<ChatList>(ms); },
};
