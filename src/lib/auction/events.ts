/**
 * Event kinds and snapshot merging. `show_events` rows written before the real-auction build use underscore kinds
 * (`lot_opened`, `demo_reset`); everything written now is dot style. Readers normalise so both stay readable.
 */
import type { LiveSnapshot } from '@/contracts/api';
import type { SnapshotEvent } from '@/contracts/events';

const PREFIXES = ['show', 'lot', 'bid', 'settlement', 'demo', 'paddle'];

/** `lot_opened` -> `lot.opened`, `demo_reset` -> `demo.reset`. Dot kinds and unknown kinds pass through unchanged. */
export function normalizeKind(kind: string): string {
  if (kind.includes('.')) return kind;
  const i = kind.indexOf('_');
  return i > 0 && PREFIXES.includes(kind.slice(0, i)) ? `${kind.slice(0, i)}.${kind.slice(i + 1)}` : kind;
}

/** Wallet-ish keys the legacy bid route wrote into payloads. Public payloads carry paddle numbers only. */
const PRIVATE_KEY = /wallet|bidder/i;
export function publicPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !PRIVATE_KEY.test(k)));
}

/**
 * Keeps the screen from going back in time: a slower, cached poll must never replace a newer snapshot.
 * Accepts `next` when both its `lastEventId` and `serverNow` are at least the previous ones (equal is fine).
 */
export function mergeSnapshot(prev: LiveSnapshot | null, next: LiveSnapshot): LiveSnapshot {
  if (!prev) return next;
  return next.lastEventId >= prev.lastEventId && next.serverNow >= prev.serverNow ? next : prev;
}

/** Union by event id (not by array length), ascending, keeping the newest `cap`. Regression for the old feed dedupe. */
export function mergeEvents(prev: readonly SnapshotEvent[], incoming: readonly SnapshotEvent[], cap = 200): SnapshotEvent[] {
  const byId = new Map<number, SnapshotEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => a.id - b.id);
  return all.length > cap ? all.slice(all.length - cap) : all;
}
