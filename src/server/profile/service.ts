/**
 * Read and change the signed-in user's profile (username, display name, bio, avatar). Server-only. The caller (the route) has already
 * established who is asking: only their own row is ever read or written, by the profile id of the session, never by an id from the request.
 * The only read of someone else's data is `readAvatar`, which answers a picture the owner uploaded to be shown.
 */
import { eq, sql } from 'drizzle-orm';
import { auditLogs, db, profiles } from '@/db';
import { ApiError } from '@/contracts/errors';
import type { ProfileUpdateRequest, ProfileView } from '@/contracts/profile';
import { checkAvatarBytes } from './avatar';
import { REJECT_TEXT, checkProfile } from './rules';

type Row = { id: string; username: string | null; displayName: string | null; bio: string | null; avatarUrl: string | null; hasAvatar: boolean; createdAt: Date; updatedAt: Date; strikes: number };
const COLS = {
  id: profiles.id, username: profiles.username, displayName: profiles.displayName, bio: profiles.bio, avatarUrl: profiles.avatarUrl,
  hasAvatar: sql<boolean>`${profiles.avatar} is not null`, createdAt: profiles.createdAt, updatedAt: profiles.updatedAt, strikes: profiles.strikes,
};
/** The picture's cache key is the row's last change: a new upload always changes it. */
const view = (r: Row): ProfileView => ({
  id: r.id, username: r.username, displayName: r.displayName, bio: r.bio, avatarUrl: r.avatarUrl,
  avatar: r.hasAvatar ? { version: r.updatedAt.getTime() } : null, createdAt: r.createdAt.toISOString(), strikes: r.strikes,
});

export async function readProfile(profileId: string): Promise<ProfileView> {
  const [row] = await db.select(COLS).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  if (!row) throw new ApiError('not_found', 'Profile not found.');
  return view(row);
}

const isUniqueViolation = (e: unknown): boolean => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.code === '23505' || x?.cause?.code === '23505';
};

/**
 * Checks and stores the fields that are present. Invalid input is a `validation` error that names the field and the reason, and changes nothing
 * (the whole request is checked before the first write). A username someone else holds (in any letter case) is `validation` with rule `taken`.
 * The audit log records which fields changed, never their content.
 */
export async function updateProfile(profileId: string, wallet: string, body: ProfileUpdateRequest): Promise<ProfileView> {
  const checked = checkProfile(body);
  if (!checked.ok) throw new ApiError('validation', REJECT_TEXT[checked.reason], { field: checked.field, rule: checked.reason });
  const patch = checked.patch;
  try {
    const [row] = await db.transaction(async (tx) => {
      const updated = await tx.update(profiles).set({ ...patch, updatedAt: new Date() }).where(eq(profiles.id, profileId)).returning(COLS);
      if (updated.length === 0) throw new ApiError('not_found', 'Profile not found.');
      await tx.insert(auditLogs).values({ action: 'profile.update', actorWallet: wallet, target: profileId, detail: { fields: Object.keys(patch) } });
      return updated;
    });
    return view(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError('validation', REJECT_TEXT.taken, { field: 'username', rule: 'taken' });
    throw e;
  }
}

/** Stores the picture after the magic-byte check (see avatar.ts). Replaces an earlier one. */
export async function setAvatar(profileId: string, wallet: string, bytes: Uint8Array): Promise<ProfileView> {
  const v = checkAvatarBytes(bytes);
  if (!v.ok) throw new ApiError('validation', REJECT_TEXT[v.rule], { field: 'avatar', rule: v.rule });
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx.update(profiles).set({ avatar: Buffer.from(bytes), avatarType: v.type, updatedAt: new Date() }).where(eq(profiles.id, profileId)).returning(COLS);
    if (updated.length === 0) throw new ApiError('not_found', 'Profile not found.');
    await tx.insert(auditLogs).values({ action: 'profile.avatar', actorWallet: wallet, target: profileId, detail: { type: v.type, bytes: bytes.length } });
    return updated;
  });
  return view(row);
}

export async function clearAvatar(profileId: string, wallet: string): Promise<ProfileView> {
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx.update(profiles).set({ avatar: null, avatarType: null, updatedAt: new Date() }).where(eq(profiles.id, profileId)).returning(COLS);
    if (updated.length === 0) throw new ApiError('not_found', 'Profile not found.');
    await tx.insert(auditLogs).values({ action: 'profile.avatar_clear', actorWallet: wallet, target: profileId, detail: {} });
    return updated;
  });
  return view(row);
}

/** The picture bytes for GET /api/avatar/:profileId, or null (none, or a banned account's). */
export async function readAvatar(profileId: string): Promise<{ bytes: Buffer; type: string } | null> {
  const [row] = await db.select({ avatar: profiles.avatar, type: profiles.avatarType, banned: profiles.isBanned }).from(profiles).where(eq(profiles.id, profileId)).limit(1);
  if (!row?.avatar || !row.type || row.banned) return null;
  return { bytes: row.avatar, type: row.type };
}
