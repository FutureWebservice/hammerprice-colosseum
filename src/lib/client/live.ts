/**
 * The client half of the live room: poll GET /api/auctions/:id/live, merge
 * monotonically, dedupe events by id, keep a server-clock offset. No React in here, so the loop is tested
 * with fake timers and a fetch stub; `src/hooks/useLiveRoom.ts` is a thin wrapper.
 *
 * Replaces the SSE hook whose 200-event slice made the feed freeze once the log reached 200 entries (C5):
 * events are accumulated by `id`, never by array length.
 */
import { LiveSnapshot, ShowDetail, type SnapshotEvent } from '@/contracts';
import { addOffsetSample, medianOffset, serverTime } from './clock';

export const POLL_OPEN_MS = 1_000;
export const POLL_IDLE_MS = 5_000;
export const POLL_MAX_BACKOFF_MS = 10_000;
/** A timed lot runs for hours or days, so a viewer polls slowly until it is close: 5 s over 10 minutes out, 2 s from 10 minutes, 1 s from 2 minutes. */
export const POLL_TIMED_FAR_MS = 5_000;
export const POLL_TIMED_NEAR_MS = 2_000;
export const TIMED_NEAR_LEFT_MS = 10 * 60_000;
export const TIMED_CLOSE_LEFT_MS = 2 * 60_000;
/** Accumulated events kept in memory (the server sends the last 40 every time). */
export const EVENT_CAP = 200;

const OPEN_PHASES = new Set(['open', 'going_once', 'going_twice']);

export const isLotOpen = (s: LiveSnapshot | null): boolean => !!s?.current && OPEN_PHASES.has(s.current.phase);

/** The seller paused the room: bids are refused and the open lot's clock stands still. */
export const isPaused = (s: LiveSnapshot | null): boolean => s?.show.pause?.paused === true;

/**
 * Milliseconds the open lot has left, drawn the same for everyone: while the room is paused the clock is frozen at the moment of the pause
 * (`closesAt - pausedAt`, the time the lot gets back on resume); otherwise the countdown against the server clock. Null when no deadline.
 */
export function lotMsLeft(s: LiveSnapshot | null, serverNowMs: number): number | null {
  const closes = s?.current?.closesAt;
  if (!closes) return null;
  const at = isPaused(s) && s?.show.pause.pausedAt ? Date.parse(s.show.pause.pausedAt) : serverNowMs;
  return Date.parse(closes) - at;
}

/** Accept `next` only when it is not older than `prev` (a slow cached response must never roll the screen back). */
export function mergeSnapshot(prev: LiveSnapshot | null, next: LiveSnapshot): LiveSnapshot {
  if (!prev || prev.show.id !== next.show.id) return next;
  return next.lastEventId >= prev.lastEventId && next.serverNow >= prev.serverNow ? next : prev;
}

/** Fold `incoming` into `known` by event id, ascending, capped. Returns the same array when nothing is new. */
export function mergeEvents(known: readonly SnapshotEvent[], incoming: readonly SnapshotEvent[], cap = EVENT_CAP): SnapshotEvent[] {
  const seen = new Set(known.map((e) => e.id));
  const fresh = incoming.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return known as SnapshotEvent[];
  return [...known, ...fresh].sort((a, b) => a.id - b.id).slice(-cap);
}

export interface DelayInput {
  lotOpen: boolean;
  errorStreak: number;
  random?: number;
  /** Milliseconds to the close of the open lot of a TIMED show (server clock). Absent on a live show, which keeps the 1 s beat. */
  timedLeftMs?: number | null;
}

/** The poll interval of an open timed lot by the time left. */
export const timedPollMs = (leftMs: number): number => (leftMs > TIMED_NEAR_LEFT_MS ? POLL_TIMED_FAR_MS : leftMs > TIMED_CLOSE_LEFT_MS ? POLL_TIMED_NEAR_MS : POLL_OPEN_MS);

/** 1 s while a lot is open (a timed lot: by the time left, see timedPollMs), 5 s otherwise, doubling per consecutive error up to 10 s; +-10 % jitter. */
export function pollDelayMs({ lotOpen, errorStreak, random = 0.5, timedLeftMs }: DelayInput): number {
  const base = lotOpen ? (timedLeftMs == null ? POLL_OPEN_MS : timedPollMs(timedLeftMs)) : POLL_IDLE_MS;
  const backed = Math.min(POLL_MAX_BACKOFF_MS, base * 2 ** Math.min(errorStreak, 6));
  return Math.round(backed * (0.9 + random * 0.2));
}

/** The lot is past `closesAt` on the server clock but the snapshot still calls it open: one immediate re-poll closes it server side. */
export function isOverdue(s: LiveSnapshot | null, offset: number, clientNow: number): boolean {
  if (!s?.current?.closesAt || !isLotOpen(s) || isPaused(s)) return false; // a frozen clock is not overdue
  return Date.parse(s.current.closesAt) <= serverTime(offset, clientNow);
}

/** Seconds added to the current lot's deadline between two snapshots of the same lot (anti-snipe extension); 0 otherwise. */
export function extensionSeconds(prev: LiveSnapshot | null, next: LiveSnapshot | null): number {
  if (isPaused(prev)) return 0; // the deadline moved because the pause ended (the room says "resumed"), not because of a late bid
  const a = prev?.current;
  const b = next?.current;
  if (!a?.closesAt || !b?.closesAt || a.lotId !== b.lotId) return 0;
  const d = Date.parse(b.closesAt) - Date.parse(a.closesAt);
  return d > 0 ? Math.round(d / 1000) : 0;
}

export class LiveError extends Error {
  constructor(readonly kind: 'not_found' | 'http' | 'shape' | 'network', detail?: string) {
    super(detail ?? kind);
    this.name = 'LiveError';
  }
}

export interface Fetched { snapshot: LiveSnapshot; sentAt: number; receivedAt: number }

export async function fetchSnapshot(showId: string, fetchImpl: typeof fetch, now: () => number = Date.now, signal?: AbortSignal): Promise<Fetched> {
  const sentAt = now();
  let res: Response;
  try {
    res = await fetchImpl(`/api/auctions/${encodeURIComponent(showId)}/live`, { cache: 'no-store', signal });
  } catch (e) {
    throw new LiveError('network', e instanceof Error ? e.message : undefined);
  }
  const receivedAt = now();
  if (res.status === 404) throw new LiveError('not_found');
  if (!res.ok) throw new LiveError('http', String(res.status));
  const parsed = LiveSnapshot.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new LiveError('shape');
  return { snapshot: parsed.data, sentAt, receivedAt };
}

/** GET /api/shows/:id: the catalogue (names, images, terms), which does not change during the auction. */
export async function fetchCatalogue(showId: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<ShowDetail> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/shows/${encodeURIComponent(showId)}`, { signal });
  } catch (e) {
    throw new LiveError('network', e instanceof Error ? e.message : undefined);
  }
  if (res.status === 404) throw new LiveError('not_found');
  if (!res.ok) throw new LiveError('http', String(res.status));
  const parsed = ShowDetail.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new LiveError('shape');
  return parsed.data;
}

export interface PollerState {
  status: 'loading' | 'ready' | 'notfound' | 'error';
  snapshot: LiveSnapshot | null;
  events: SnapshotEvent[];
  /** serverNow minus client time, ms. */
  offset: number;
  errorStreak: number;
}

export interface PollerDeps {
  showId: string;
  fetchImpl: typeof fetch;
  onState: (s: PollerState) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  isHidden?: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisible?: (cb: () => void) => () => void;
  random?: () => number;
}

export function createLivePoller(deps: PollerDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const isHidden = deps.isHidden ?? (() => false);
  const random = deps.random ?? Math.random;

  let state: PollerState = { status: 'loading', snapshot: null, events: [], offset: 0, errorStreak: 0 };
  let samples: number[] = [];
  let timer: unknown = null;
  let stopped = true;
  let inflight = false;
  let overdueFiredFor = '';
  let unsubscribe: (() => void) | null = null;

  const emit = (patch: Partial<PollerState>) => {
    state = { ...state, ...patch };
    deps.onState(state);
  };

  function accept(f: Fetched) {
    samples = addOffsetSample(samples, f.snapshot.serverNow, f.sentAt, f.receivedAt);
    const snapshot = mergeSnapshot(state.snapshot, f.snapshot);
    emit({
      status: 'ready',
      snapshot,
      events: mergeEvents(state.events, f.snapshot.events),
      offset: medianOffset(samples),
      errorStreak: 0,
    });
  }

  function schedule() {
    if (stopped) return;
    if (timer != null) clearTimer(timer);
    timer = null;
    if (isHidden()) return; // paused: the visibility callback polls as soon as the tab is back
    const s = state.snapshot;
    const timedLeftMs = s?.show.kind === 'timed' && s.current?.closesAt ? Date.parse(s.current.closesAt) - serverTime(state.offset, now()) : null;
    let delay = pollDelayMs({ lotOpen: isLotOpen(s), errorStreak: state.errorStreak, random: random(), timedLeftMs });
    const key = s?.current ? `${s.current.lotId}|${s.current.closesAt}` : '';
    if (state.errorStreak === 0 && key && key !== overdueFiredFor && isOverdue(s, state.offset, now())) {
      overdueFiredFor = key;
      delay = 250;
    }
    timer = setTimer(() => void poll(), delay);
  }

  async function poll() {
    if (stopped || inflight) return;
    inflight = true;
    try {
      accept(await fetchSnapshot(deps.showId, deps.fetchImpl, now));
    } catch (e) {
      if (e instanceof LiveError && e.kind === 'not_found') {
        stopped = true;
        emit({ status: 'notfound' });
        return;
      }
      emit({ status: state.snapshot ? 'ready' : 'error', errorStreak: state.errorStreak + 1 });
    } finally {
      inflight = false;
    }
    schedule();
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      unsubscribe = deps.onVisible?.(() => { if (!isHidden()) void poll(); }) ?? null;
      void poll();
    },
    stop() {
      stopped = true;
      if (timer != null) clearTimer(timer);
      timer = null;
      unsubscribe?.();
      unsubscribe = null;
    },
    /** Poll now (after the viewer's own action). */
    poll,
    /** Merge a snapshot that arrived some other way (the response to the viewer's own bid). */
    applySnapshot(snapshot: LiveSnapshot) {
      emit({ snapshot: mergeSnapshot(state.snapshot, snapshot), events: mergeEvents(state.events, snapshot.events), status: 'ready' });
    },
    get state() { return state; },
  };
}
