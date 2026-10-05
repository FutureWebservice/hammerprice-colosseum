/**
 * Retention for the room chat. Run by the housekeeping pass (src/server/housekeeping.ts), and it
 * runs whether or not FEATURE_CHAT is on: what was stored is deleted on schedule regardless of the switch.
 *
 *   - messages: 30 days after the show ended (or was cancelled); and, as a net for a show that never ended, 90 days after the message
 *   - reports: go with their message (foreign key, on delete cascade); a report on a message that is kept is deleted after 6 months
 *   - mutes and blocks: deleted with the same rule as the messages (show ended or cancelled 30 days ago); the show row itself is never
 *     deleted by the app, so the cascade does not do it. An expired mute is also deleted (it no longer has any effect).
 *
 * Returns the number of rows removed (messages, reports and mutes).
 */
import { and, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';
import { chatMessages, chatMutes, chatReports, shows } from '@/db/schema';

export const MESSAGE_DAYS_AFTER_SHOW = 30;
export const MESSAGE_DAYS_MAX = 90;
export const REPORT_DAYS = 183;

const DAY = 86_400_000;

export async function purgeChat(now: Date = new Date()): Promise<number> {
  const db = (await import('@/db')).db;
  const showCutoff = new Date(now.getTime() - MESSAGE_DAYS_AFTER_SHOW * DAY);
  const hardCutoff = new Date(now.getTime() - MESSAGE_DAYS_MAX * DAY);
  const reportCutoff = new Date(now.getTime() - REPORT_DAYS * DAY);

  const oldShows = db
    .select({ id: shows.id })
    .from(shows)
    .where(or(and(eq(shows.status, 'ended'), isNotNull(shows.endedAt), lt(shows.endedAt, showCutoff)), and(isNotNull(shows.cancelledAt), lt(shows.cancelledAt, showCutoff))));
  const messages = await db
    .delete(chatMessages)
    .where(or(inArray(chatMessages.showId, oldShows), lt(chatMessages.createdAt, hardCutoff)))
    .returning({ id: chatMessages.id });
  const reports = await db.delete(chatReports).where(lt(chatReports.createdAt, reportCutoff)).returning({ id: chatReports.id });
  const mutes = await db
    .delete(chatMutes)
    .where(or(inArray(chatMutes.showId, oldShows), and(eq(chatMutes.kind, 'mute'), lt(chatMutes.until, now))))
    .returning({ p: chatMutes.profileId });
  return messages.length + reports.length + mutes.length;
}
