/**
 * "Watch this room" (Telegram /watch): which room, how many upcoming lots, and the rows that say so (`telegram_watches`, migration 0008).
 * A watch only decides who gets a message when a lot opens (notify.ts `notifyLotsOpened`). Nothing here, and nothing in the bot, ever places,
 * signs or prepares a bid for anybody: the alert links to the room with the amount filled in and the person confirms and signs in their own wallet.
 */
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { DEMO_SHOW_ID } from '@/lib/demo-show';
import { paddles, shows, telegramWatches } from '@/db/schema';
import { updateLink, type Link } from './links';

async function getDb() {
  return (await import('@/db')).db;
}

/** The counts the buttons offer; `/watch <n>` accepts 1 to MAX_WATCH_COUNT. `null` means every lot until the show ends. */
export const WATCH_BUTTON_COUNTS = [3, 5, 10] as const;
export const MAX_WATCH_COUNT = 50;
export type WatchCount = number | null;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const CALLBACK = new RegExp(`^w\\|(p|3|5|10|a)\\|(${UUID})$`);

/** `/watch 5`, `/watch all` (also German "alle"). `undefined` for no argument, `false` for anything else. */
export function parseWatchArg(arg: string): WatchCount | undefined | false {
  const a = arg.trim().toLowerCase();
  if (a === '') return undefined;
  if (a === 'all' || a === 'alle') return null;
  if (!/^\d{1,3}$/.test(a)) return false;
  const n = Number(a);
  return n >= 1 && n <= MAX_WATCH_COUNT ? n : false;
}

/**
 * The button data: `w|p|<show>` opens the how-many question, `w|3|<show>`, `w|5|`, `w|10|`, `w|a|` (all) set the watch. Not signed: pressing
 * one can only start a watch for the pressing chat's own linked profile on an existing room, which that person could also do with /watch.
 * 40 to 42 characters (Telegram allows 64).
 */
export const watchCallback = (step: 'p' | WatchCount, showId: string): string => `w|${step === 'p' ? 'p' : step === null ? 'a' : step}|${showId.toLowerCase()}`;

export type WatchCallback = { step: 'pick'; showId: string } | { step: 'set'; count: WatchCount; showId: string };
export function parseWatchCallback(data: string | undefined): WatchCallback | null {
  const m = data ? CALLBACK.exec(data) : null;
  if (!m) return null;
  if (m[1] === 'p') return { step: 'pick', showId: m[2] };
  return { step: 'set', count: m[1] === 'a' ? null : Number(m[1]), showId: m[2] };
}

export interface WatchableShow { id: string; title: string }

/**
 * The room /watch means: a live room (the one the person holds a bidder number in first, then a real show before the house demo, then the
 * most recently started), else the next scheduled live room. Null when there is none. Timed shows have one lot and are not offered.
 */
export async function pickWatchShow(profileId: string, now: Date = new Date()): Promise<WatchableShow | null> {
  const db = await getDb();
  const live = await db.select({ id: shows.id, title: shows.title, isHouse: shows.isHouse, startedAt: shows.startedAt })
    .from(shows).where(and(eq(shows.status, 'live'), eq(shows.kind, 'live'), ne(shows.id, DEMO_SHOW_ID))).orderBy(desc(shows.startedAt)).limit(20);
  if (live.length > 0) {
    const mine = new Set((await db.select({ id: paddles.showId }).from(paddles).where(and(eq(paddles.profileId, profileId), inArray(paddles.showId, live.map((s) => s.id)), sql`${paddles.revokedAt} is null`))).map((r) => r.id));
    const rank = (s: (typeof live)[number]) => (mine.has(s.id) ? 0 : s.isHouse ? 2 : 1);
    return [...live].sort((a, b) => rank(a) - rank(b))[0]; // stable: equal rank keeps "most recently started" first
  }
  const [next] = await db.select({ id: shows.id, title: shows.title }).from(shows)
    .where(and(eq(shows.status, 'scheduled'), eq(shows.kind, 'live'), ne(shows.id, DEMO_SHOW_ID), gte(shows.scheduledAt, new Date(now.getTime() - 3_600_000)))).orderBy(asc(shows.scheduledAt)).limit(1);
  return next ?? null;
}

/** Starts (or restarts) the watch of one room for a linked profile. Null when the room does not exist or is over. Switches the `lot_watch` choice on (the person just asked for it). */
export async function setWatch(link: Link, showId: string, count: WatchCount, now: Date = new Date()): Promise<WatchableShow | null> {
  const db = await getDb();
  const [show] = await db.select({ id: shows.id, title: shows.title, status: shows.status, kind: shows.kind }).from(shows).where(eq(shows.id, showId)).limit(1);
  if (!show || show.status === 'ended' || show.kind !== 'live' || show.id === DEMO_SHOW_ID) return null; // the legacy practice room is simulated: nothing real opens there
  await db.insert(telegramWatches).values({ profileId: link.profileId, showId, remaining: count, createdAt: now })
    .onConflictDoUpdate({ target: [telegramWatches.profileId, telegramWatches.showId], set: { remaining: count, createdAt: now } });
  if (!link.prefs.lot_watch) await updateLink(link.profileId, { prefs: { lot_watch: true } });
  return { id: show.id, title: show.title };
}

/** Stops every watch of the profile (/unwatch, or the switch turned off). The number stopped. */
export async function clearWatches(profileId: string): Promise<number> {
  const db = await getDb();
  return (await db.delete(telegramWatches).where(eq(telegramWatches.profileId, profileId)).returning({ s: telegramWatches.showId })).length;
}

/** The profile's watches that are still counting, for /status. */
export async function listWatches(profileId: string): Promise<{ showId: string; title: string; remaining: number | null }[]> {
  const db = await getDb();
  return db.select({ showId: telegramWatches.showId, title: shows.title, remaining: telegramWatches.remaining })
    .from(telegramWatches).innerJoin(shows, eq(shows.id, telegramWatches.showId))
    .where(and(eq(telegramWatches.profileId, profileId), sql`${shows.status} <> 'ended'`)).limit(10);
}
