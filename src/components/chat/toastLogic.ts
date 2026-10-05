/**
 * The operator's "message waiting" popup, without React: what to show (newest waiting message, count), the plain-text preview, the decision
 * calls (the existing moderate endpoint) and the deep link into the Moderation tab. Tested without a DOM.
 */
import { ChatError, errorKey, moderate, type Queue, type QueueFilter } from './chatClient';

export type QMessage = Queue['messages'][number];

export const PREVIEW_MAX = 80;
/** The fixed reasons offered on Reject; the texts are `chat.mod.reasons.*` (the author sees the sentence). */
export const REJECT_PRESETS = ['offtopic', 'advert', 'rude', 'personal', 'other'] as const;
export type RejectPreset = (typeof REJECT_PRESETS)[number];

/** Plain text, white space collapsed, at most 80 code points. Rendered as a React text node, never as HTML. */
export function previewText(body: string): string {
  const cps = Array.from(body.replace(/\s+/g, ' ').trim());
  return cps.length > PREVIEW_MAX ? `${cps.slice(0, PREVIEW_MAX).join('').trimEnd()}...` : cps.join('');
}

/**
 * The popup's content: the newest waiting message above `dismissedSeq` and how many wait above it. The server lists waiting messages oldest first,
 * at most 50 (`counts.pending` is the true total); beyond 50 the preview is the newest of that page. Known limit: no afterSeq paging, an operator with
 * more than 50 waiting messages has a bigger problem than a stale preview.
 */
export function pickToast(queue: Queue | null, dismissedSeq: number): { newest: QMessage | null; count: number } {
  if (!queue) return { newest: null, count: 0 };
  const fresh = queue.messages.filter((m) => m.status === 'pending' && m.seq > dismissedSeq);
  if (fresh.length === 0) return { newest: null, count: 0 };
  const newest = fresh.reduce((a, b) => (b.seq > a.seq ? b : a));
  return { newest, count: fresh.length + Math.max(0, queue.counts.pending - queue.messages.length) };
}

export type Decision = { kind: 'approve'; id: string } | { kind: 'reject'; id: string; preset: RejectPreset };

/** Approve or reject exactly one message through `POST .../chat/moderate`. `reasonOf` turns a preset into the sentence the author sees. */
export async function decide(showId: string, d: Decision, reasonOf: (p: RejectPreset) => string): Promise<{ ok: true } | { ok: false; errorKey: string }> {
  try {
    await moderate(showId, d.kind === 'approve' ? { action: 'approve', messageIds: [d.id] } : { action: 'reject', messageIds: [d.id], reason: reasonOf(d.preset) });
    return { ok: true };
  } catch (e) {
    return { ok: false, errorKey: e instanceof ChatError ? errorKey(e) : 'generic' };
  }
}

/** "Open chat": the panel opens on the Moderation tab, on the waiting list, with this message scrolled to and highlighted. */
export const deepLink = (id: string): { open: true; tab: 'mod'; filter: QueueFilter; focusId: string } => ({ open: true, tab: 'mod', filter: 'pending', focusId: id });
