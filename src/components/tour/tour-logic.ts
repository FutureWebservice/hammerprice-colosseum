/**
 * The tour's rules without any DOM: when it starts by itself, how steps are skipped when their anchor is not on
 * the page, and the replay signal. The storage is a parameter; a missing or throwing one only means "no memory".
 */
import { readFlag, writeFlag, type Store } from '@/lib/client/safe-storage';

export const TOUR_KEY = 'hp.tour.v1';
export const TOUR_EVENT = 'hp-tour-start';

/** In-page memory for when storage is blocked: the tour then runs at most once per page session. */
let startedThisSession = false;
export const resetTourSession = () => { startedThisSession = false; };

/** `?tour=0` switches the automatic start off (e2e runs, bots, links for demos). A replay ignores it. */
export function wantsAutoTour(search: string, store: Store | null): boolean {
  if (startedThisSession) return false;
  if (new URLSearchParams(search).get('tour') === '0') return false;
  return readFlag(store, TOUR_KEY) === null;
}

/** The tour counts as seen the moment it starts: leaving the page ends it, and it never comes back by itself. */
export function markTourSeen(store: Store | null): void {
  startedThisSession = true;
  writeFlag(store, TOUR_KEY, '1');
}

/** Next step index from `from` in direction `dir` whose anchor exists, or -1. */
export function stepIndex(ids: readonly string[], from: number, dir: 1 | -1, exists: (id: string) => boolean): number {
  for (let i = from + dir; i >= 0 && i < ids.length; i += dir) if (exists(ids[i]!)) return i;
  return -1;
}

/** A mounted <Tour /> marks the page, so the Help menu offers "Replay the tour" only where it does something. */
export const TOUR_MOUNT_ATTR = 'data-tour-mounted';
export function setTourMounted(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (on) document.body.setAttribute(TOUR_MOUNT_ATTR, 'true'); else document.body.removeAttribute(TOUR_MOUNT_ATTR);
}
export function tourMounted(): boolean {
  return typeof document !== 'undefined' && document.body.hasAttribute(TOUR_MOUNT_ATTR);
}

export function replayTour(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(TOUR_EVENT));
}
