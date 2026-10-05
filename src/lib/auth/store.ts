/**
 * The database side of sign-in: nonces, profiles, the audit row. Every function opens the database lazily
 * (`@/db` throws at import when DATABASE_URL is unset), so the pure modules and their tests never need one.
 */
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { auditLogs, authNonces, paddles, profiles } from '@/db/schema';
import { MAX_STRIKES } from './strikes';

async function getDb() {
  return (await import('@/db')).db;
}

export interface ProfileRow { id: string; walletAddress: string; isSeller: boolean; isBanned: boolean; strikes: number }
const profileCols = { id: profiles.id, walletAddress: profiles.walletAddress, isSeller: profiles.isSeller, isBanned: profiles.isBanned, strikes: profiles.strikes };

export async function insertNonce(nonce: string, wallet: string, expiresAt: Date, purgeBefore: Date): Promise<void> {
  const db = await getDb();
  await db.insert(authNonces).values({ nonce, walletAddress: wallet, expiresAt });
  // Expired challenges are useless; sweeping them here keeps the table small without a cron.
  await db.delete(authNonces).where(lt(authNonces.expiresAt, purgeBefore));
}

/** Single use: the DELETE is the check, so two concurrent logins with one nonce cannot both win. */
export async function consumeNonce(nonce: string, wallet: string, now: Date): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .delete(authNonces)
    .where(and(eq(authNonces.nonce, nonce), eq(authNonces.walletAddress, wallet), gt(authNonces.expiresAt, now)))
    .returning({ nonce: authNonces.nonce });
  return rows.length === 1;
}

/** The automatic strike ban (reasons '<n> settlements not completed' and '<n> pack deliveries or settlements not completed') below the current limit. */
const STALE_STRIKE_BAN = sql`(${profiles.isBanned} and ${profiles.strikes} < ${MAX_STRIKES} and ${profiles.bannedReason} ~ '^[0-9]+ (pack deliveries or )?settlements not completed')`;

export async function upsertProfile(wallet: string): Promise<ProfileRow> {
  const db = await getDb();
  const [row] = await db
    .insert(profiles)
    .values({ walletAddress: wallet })
    // A suspension that the strike rule set under an older, lower limit (its reason is the automatic text) lifts itself at the next sign-in; any other ban stays.
    .onConflictDoUpdate({ target: profiles.walletAddress, set: {
      updatedAt: new Date(),
      isBanned: sql`case when ${STALE_STRIKE_BAN} then false else ${profiles.isBanned} end`,
      bannedReason: sql`case when ${STALE_STRIKE_BAN} then null else ${profiles.bannedReason} end`,
      bannedAt: sql`case when ${STALE_STRIKE_BAN} then null else ${profiles.bannedAt} end`,
    } })
    .returning(profileCols);
  return row;
}

export async function getProfile(profileId: string): Promise<ProfileRow | null> {
  const db = await getDb();
  const [row] = await db.select(profileCols).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  return row ?? null;
}

export async function audit(action: string, actorWallet: string | null, target?: string, detail?: unknown): Promise<void> {
  const db = await getDb();
  await db.insert(auditLogs).values({ action, actorWallet, target: target ?? null, detail: detail ?? null });
}

/** Revokes the profile's paddle in a show (idempotent). Returns whether a live paddle was revoked. */
export async function revokePaddle(showId: string, profileId: string, now: Date): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(paddles)
    .set({ revokedAt: now })
    .where(and(eq(paddles.showId, showId), eq(paddles.profileId, profileId), isNull(paddles.revokedAt)))
    .returning({ id: paddles.id });
  return rows.length > 0;
}
