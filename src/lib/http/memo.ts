/**
 * A tiny per-instance response memo with single flight, for public reads that every viewer asks for at once (the live snapshot).
 *
 * Why: the CDN absorbs identical polls, but a caller who adds a random query string, or a viewer behind no CDN, reaches the
 * function every time, and each call is several database queries. With this, however many requests arrive for one key, ONE load
 * runs at a time and its answer is shared for `ttlMs` after it was produced, so database work per key is bounded by 1/ttl per
 * second per instance. A failure is never remembered. At most `max` keys are held (the oldest goes first), so a flood of
 * distinct keys cannot grow memory. ttlMs <= 0 keeps only the sharing of requests that are in flight together.
 */
export interface Memo<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function createMemo<T>(ttlMs: number, max = 200, now: () => number = Date.now): Memo<T> {
  const held = new Map<string, { at: number; settled: boolean; value: Promise<T> }>();
  return {
    get(key, load) {
      const hit = held.get(key);
      if (hit && (!hit.settled || now() - hit.at < ttlMs)) return hit.value;
      const entry = { at: now(), settled: false, value: load() };
      held.delete(key);
      held.set(key, entry);
      if (held.size > max) held.delete(held.keys().next().value as string);
      entry.value.then(
        () => { entry.at = now(); entry.settled = true; },
        () => { if (held.get(key) === entry) held.delete(key); },
      );
      return entry.value;
    },
    clear: () => held.clear(),
  };
}

/** Milliseconds a live snapshot is shared inside one instance; LIVE_SNAPSHOT_MEMO_MS overrides (0 = off). Well inside the 1 s CDN budget the room is designed for. */
export const snapshotMemoMs = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.LIVE_SNAPSHOT_MEMO_MS);
  return env.LIVE_SNAPSHOT_MEMO_MS !== undefined && Number.isFinite(n) && n >= 0 ? Math.min(n, 2000) : 500;
};
