/**
 * What the schedule page shows, decided by pure functions over GET /api/shows rows.
 * Nothing on the page is invented: a row appears only if the server sent it, totals only when a lot sold,
 * and a "scheduled" row whose start passed long ago (old seed data, a show nobody started) is dropped.
 */
import type { ShowSummary } from '@/contracts/api';

/** A scheduled show may sit this long past its start before we stop listing it (the lazy engine opens it on the next visit or sweep). */
export const START_GRACE_MS = 15 * 60_000;

const at = (iso: string | null) => (iso ? new Date(iso).getTime() : Number.POSITIVE_INFINITY);

export function upcoming(shows: ShowSummary[], nowMs: number): ShowSummary[] {
  return shows
    .filter((s) => s.scheduledAt === null || at(s.scheduledAt) + START_GRACE_MS >= nowMs)
    .sort((a, b) => at(a.scheduledAt) - at(b.scheduledAt));
}

/** Most recently started first. */
export const archive = (shows: ShowSummary[]): ShowSummary[] =>
  [...shows].sort((a, b) => (b.startedAt ? new Date(b.startedAt).getTime() : 0) - (a.startedAt ? new Date(a.startedAt).getTime() : 0));

/** The scheduled time has come but the room has not opened yet. */
export const isStartingNow = (s: ShowSummary, nowMs: number) => s.scheduledAt !== null && at(s.scheduledAt) <= nowMs;

/** A total is only real when at least one lot sold. */
export const showTotal = (s: ShowSummary): string | null => (s.soldCount > 0 ? s.hammerTotal : null);

/** How many recent finished demo shows the demo block lists: the house runs a new show every few minutes, so the archive there stays short. */
export const DEMO_ARCHIVE_MAX = 3;

export interface RoomGroup { live: ShowSummary[]; scheduled: ShowSummary[]; ended: ShowSummary[] }
export interface RoomGroups {
  /** The one DEMO room (the house live room), then the house's timed auctions and the next house shows. Never a seller's room. */
  demo: RoomGroup;
  /** "Real rooms": everything that is not a house show, live first, then upcoming, then ended. */
  sellers: RoomGroup;
}

/** Live-kind before timed, otherwise the order the server sent (it pins the live house room first). */
const liveKindFirst = (shows: ShowSummary[]): ShowSummary[] => [...shows].sort((a, b) => Number(a.kind === 'timed') - Number(b.kind === 'timed'));

/**
 * Splits rows from GET /api/shows by who made the room. A house show (isHouse) is the demo and is never listed as a seller's room,
 * whichever list it arrived in; everything else is a seller's. Rows are de-duplicated by id because the demo block is fetched on its own.
 */
export function splitRooms(lists: RoomGroup, nowMs: number): RoomGroups {
  const seen = new Set<string>();
  const uniq = (rows: ShowSummary[]) => rows.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
  const live = uniq(lists.live);
  const scheduled = uniq(lists.scheduled);
  const ended = uniq(lists.ended);
  const pick = (house: boolean): RoomGroup => ({
    live: live.filter((s) => s.isHouse === house),
    scheduled: upcoming(scheduled.filter((s) => s.isHouse === house), nowMs),
    ended: archive(ended.filter((s) => s.isHouse === house)),
  });
  const demo = pick(true);
  return {
    demo: { live: liveKindFirst(demo.live), scheduled: liveKindFirst(demo.scheduled), ended: demo.ended.slice(0, DEMO_ARCHIVE_MAX) },
    sellers: pick(false),
  };
}
