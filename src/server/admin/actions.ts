/**
 * The admin panel's three writes. Two of them reuse the existing service functions unchanged by acting as the room's own operator (the show's
 * seller, who those functions already accept), so no rule of the engine or the chat is bypassed or duplicated; the admin's wallet is recorded in
 * audit_logs (`admin.*`) next to the service's own row. The third deletes a waiting-list entry (privacy: deletion on request).
 */
import { eq } from 'drizzle-orm';
import { ApiError } from '@/contracts/errors';
import { isValidUuid } from '@/lib/uuid';
import type { Admin } from './access';
import { auditAdmin } from './access';

async function getDb() {
  return (await import('@/db')).db;
}

const uuid = (id: string, what: string): string => {
  if (!isValidUuid(id)) throw new ApiError('not_found', `${what} not found`);
  return id.toLowerCase();
};

/** The seller of a show: the identity the engine and the chat accept as the room's operator. */
async function sellerOfShow(showId: string): Promise<{ id: string; wallet: string }> {
  const { schema } = await import('@/db');
  const db = await getDb();
  const [row] = await db.select({ id: schema.profiles.id, wallet: schema.profiles.walletAddress }).from(schema.shows)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.shows.sellerId)).where(eq(schema.shows.id, showId)).limit(1);
  if (!row) throw new ApiError('not_found', 'Show not found');
  return row;
}

/** Cancel a show that has not started (the engine refuses any other state with wrong_state). */
export async function cancelShow(admin: Admin, showIdRaw: string): Promise<void> {
  const showId = uuid(showIdRaw, 'Show');
  const seller = await sellerOfShow(showId);
  const { auctionService } = await import('@/app/api/auctions/_shared/deps');
  await auctionService().cancelShow(showId, { profileId: seller.id, wallet: seller.wallet });
  await auditAdmin(admin, 'show.cancel', showId);
}

/** Reject (hide) one chat message through the chat service's own moderation, which also settles the open reports on it. */
export async function rejectChatMessage(admin: Admin, messageIdRaw: string): Promise<void> {
  const messageId = uuid(messageIdRaw, 'Message');
  const { schema } = await import('@/db');
  const db = await getDb();
  const [msg] = await db.select({ showId: schema.chatMessages.showId }).from(schema.chatMessages).where(eq(schema.chatMessages.id, messageId)).limit(1);
  if (!msg) throw new ApiError('not_found', 'Message not found');
  const seller = await sellerOfShow(msg.showId);
  const { moderate } = await import('@/server/chat/service');
  await moderate(msg.showId, { profileId: seller.id, wallet: seller.wallet }, { action: 'reject', messageIds: [messageId], reason: 'Removed by the platform' });
  await auditAdmin(admin, 'chat.reject', messageId, { showId: msg.showId });
}

/** Delete one waiting-list entry. The audit row carries the entry's id only, never the address. */
export async function deleteWaitlistEntry(admin: Admin, idRaw: string): Promise<void> {
  const id = uuid(idRaw, 'Entry');
  const { schema } = await import('@/db');
  const db = await getDb();
  const gone = await db.delete(schema.waitlist).where(eq(schema.waitlist.id, id)).returning({ id: schema.waitlist.id });
  if (gone.length === 0) throw new ApiError('not_found', 'Entry not found');
  await auditAdmin(admin, 'waitlist.delete', id);
}
