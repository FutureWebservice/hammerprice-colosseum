/**
 * The agent conversation, kept in this browser only (localStorage). One key per signed-in wallet, so another wallet on the same browser never sees it;
 * the /ai page and the assistant in the rooms read and write the same key (the conversation continues between them). Nothing here is sent anywhere.
 * Every access is wrapped: private mode, blocked storage or a full disk just means "no history". What is read is validated again (an old or edited
 * entry is dropped, never rendered). The size is capped: the newest 200 messages and about 300 KB, the oldest go first.
 */
import type { z } from 'zod';
import { AiAgentResponse } from '@/contracts';

export type Reply = z.infer<typeof AiAgentResponse>;
export type Msg = { role: 'user'; text: string } | ({ role: 'ai' } & Reply);

export const MAX_MESSAGES = 200;
export const MAX_CHARS = 300_000;

const valid = (m: unknown): m is Msg => {
  if (!m || typeof m !== 'object') return false;
  const o = m as Record<string, unknown>;
  if (o.role === 'user') return typeof o.text === 'string' && o.text.length > 0 && o.text.length <= 300;
  if (o.role !== 'ai') return false;
  return AiAgentResponse.safeParse({ text: o.text, label: o.label, cards: o.cards }).success;
};

/** The newest messages that fit both caps. */
export function capHistory(msgs: readonly Msg[]): Msg[] {
  const out = msgs.slice(-MAX_MESSAGES);
  while (out.length > 1 && JSON.stringify(out).length > MAX_CHARS) out.shift();
  return out;
}

export function loadHistory(wallet: string): Msg[] {
  try {
    const k = `hp:ai-agent:v1:${wallet}`; // a literal prefix: the storage audit (src/legal/__tests__/audit.test.ts) reads it
    const raw = window.localStorage.getItem(k);
    const j: unknown = raw ? JSON.parse(raw) : null;
    if (!j || typeof j !== 'object' || (j as { v?: unknown }).v !== 1 || !Array.isArray((j as { msgs?: unknown }).msgs)) return [];
    return capHistory((j as { msgs: unknown[] }).msgs.filter(valid));
  } catch { return []; }
}

export function saveHistory(wallet: string, msgs: readonly Msg[]): void {
  try {
    const k = `hp:ai-agent:v1:${wallet}`;
    if (msgs.length === 0) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, JSON.stringify({ v: 1, msgs: capHistory(msgs) }));
  } catch { /* private mode or full: the conversation just is not kept */ }
}
