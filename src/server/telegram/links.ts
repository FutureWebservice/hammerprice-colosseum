/**
 * Linking a wallet's profile to ONE private Telegram chat, and unlinking it again.
 *
 *   1. The signed-in user presses "Connect Telegram": `createLinkToken` makes a random token (24 bytes, base64url), stores ONLY its sha-256, binds it
 *      to the profile (so to the SIWS wallet), gives it 10 minutes and returns the deep link https://t.me/<bot>?start=<token>.
 *   2. The user opens the link and taps Start: Telegram sends `/start <token>` to the webhook, `consumeLinkToken` finds the hash, marks it used
 *      (one winner under concurrency: `UPDATE ... WHERE used_at IS NULL AND expires_at > now`) and binds the chat id to the profile.
 *   3. `/stop`, the account button, or Telegram's 403 (the user blocked the bot) unlink: the link row, the open tokens and the sent-markers go.
 *
 * Only the chat id, the language and the opt-in switches are stored. A chat belongs to one profile and a profile to one chat: linking a chat that
 * was linked to another wallet moves it, so one person can never be told about two wallets in one chat by accident.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { ApiError } from '@/contracts/errors';
import { DEFAULT_TELEGRAM_PREFS, TELEGRAM_TYPES, type TelegramLocale, type TelegramPrefs, type TelegramType } from '@/contracts/telegram';
import { telegramLinkTokens, telegramLinks, telegramSent, telegramWatches } from '@/db/schema';

async function getDb() {
  return (await import('@/db')).db;
}

export const TOKEN_TTL_MS = 10 * 60_000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,64}$/;

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Stored prefs to a complete object: a missing or odd key is "off" (opt-in), never "on". */
export function parsePrefs(raw: unknown): TelegramPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return Object.fromEntries(TELEGRAM_TYPES.map((k) => [k, o[k] === true])) as TelegramPrefs;
}

export interface Link { profileId: string; chatId: number; locale: TelegramLocale; prefs: TelegramPrefs; linkedAt: Date }
const toLocale = (v: string): TelegramLocale => (v === 'de' ? 'de' : 'en');
const toLink = (r: typeof telegramLinks.$inferSelect): Link => ({ profileId: r.profileId, chatId: r.chatId, locale: toLocale(r.locale), prefs: parsePrefs(r.prefs), linkedAt: r.linkedAt });

export async function getLink(profileId: string): Promise<Link | null> {
  const db = await getDb();
  const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.profileId, profileId)).limit(1);
  return row ? toLink(row) : null;
}

export async function getLinkByChat(chatId: number): Promise<Link | null> {
  const db = await getDb();
  const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.chatId, chatId)).limit(1);
  return row ? toLink(row) : null;
}

/** The links of these profiles that want this kind of message. */
export async function linksWanting(profileIds: string[], kind: TelegramType): Promise<Link[]> {
  if (profileIds.length === 0) return [];
  const db = await getDb();
  const rows = await db.select().from(telegramLinks).where(inArray(telegramLinks.profileId, [...new Set(profileIds)]));
  return rows.map(toLink).filter((l) => l.prefs[kind]);
}

/** Preferences for a new link: what the request named, on top of the defaults (messages about your own money). */
export function mergePrefs(base: TelegramPrefs, patch: Partial<TelegramPrefs> | undefined): TelegramPrefs {
  const out = { ...base };
  for (const k of TELEGRAM_TYPES) if (patch && typeof patch[k] === 'boolean') out[k] = patch[k]!;
  return out;
}

/** Starts a link. Earlier unused tokens of this profile are dropped, so at most one link is open at a time. */
export async function createLinkToken(profileId: string, opts: { locale?: TelegramLocale; prefs?: Partial<TelegramPrefs> }, now: Date = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const db = await getDb();
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);
  await db.delete(telegramLinkTokens).where(or(eq(telegramLinkTokens.profileId, profileId), lt(telegramLinkTokens.expiresAt, new Date(now.getTime() - 86_400_000))));
  await db.insert(telegramLinkTokens).values({
    tokenHash: hashToken(token), profileId, locale: opts.locale ?? 'en', prefs: mergePrefs(DEFAULT_TELEGRAM_PREFS, opts.prefs), expiresAt, createdAt: now,
  });
  return { token, expiresAt };
}

/**
 * Binds `chatId` to the profile the token belongs to. `null` for a token that is unknown, expired or already used (the caller says the same thing
 * for all three). The token is marked used first, in the same transaction as the link, so two taps of the same link make one link.
 */
export async function consumeLinkToken(token: string, chatId: number, now: Date = new Date()): Promise<Link | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [used] = await tx
      .update(telegramLinkTokens)
      .set({ usedAt: now })
      .where(and(eq(telegramLinkTokens.tokenHash, hashToken(token)), sql`${telegramLinkTokens.usedAt} is null`, sql`${telegramLinkTokens.expiresAt} > ${now}`))
      .returning();
    if (!used) return null;
    // A chat belongs to one profile: if it was linked to another wallet, that link ends here.
    const [other] = await tx.select({ profileId: telegramLinks.profileId }).from(telegramLinks).where(and(eq(telegramLinks.chatId, chatId), sql`${telegramLinks.profileId} <> ${used.profileId}`));
    if (other) {
      await tx.delete(telegramSent).where(eq(telegramSent.profileId, other.profileId));
      await tx.delete(telegramWatches).where(eq(telegramWatches.profileId, other.profileId));
      await tx.delete(telegramLinks).where(eq(telegramLinks.profileId, other.profileId));
    }
    const values = { profileId: used.profileId, chatId, locale: toLocale(used.locale), prefs: parsePrefs(used.prefs), linkedAt: now };
    const [row] = await tx
      .insert(telegramLinks)
      .values(values)
      .onConflictDoUpdate({ target: telegramLinks.profileId, set: { chatId: values.chatId, locale: values.locale, prefs: values.prefs, linkedAt: now } })
      .returning();
    await tx.delete(telegramSent).where(eq(telegramSent.profileId, used.profileId)); // a fresh link starts with a clean slate
    await tx.delete(telegramWatches).where(eq(telegramWatches.profileId, used.profileId));
    await tx.delete(telegramLinkTokens).where(eq(telegramLinkTokens.profileId, used.profileId));
    return toLink(row);
  });
}

async function unlinkWhere(cond: SQL): Promise<boolean> {
  const db = await getDb();
  const gone = await db.delete(telegramLinks).where(cond).returning({ profileId: telegramLinks.profileId });
  for (const g of gone) {
    await db.delete(telegramSent).where(eq(telegramSent.profileId, g.profileId));
    await db.delete(telegramWatches).where(eq(telegramWatches.profileId, g.profileId));
    await db.delete(telegramLinkTokens).where(eq(telegramLinkTokens.profileId, g.profileId));
  }
  return gone.length > 0;
}

/** Unlink by wallet profile (the account button). True when there was a link. */
export const unlinkProfile = (profileId: string): Promise<boolean> => unlinkWhere(eq(telegramLinks.profileId, profileId));
/** Unlink by chat (/stop, Telegram 403, the user blocked the bot). True when there was a link. */
export const unlinkChat = (chatId: number): Promise<boolean> => unlinkWhere(eq(telegramLinks.chatId, chatId));

/** Changes the language and/or switches of a linked chat. `not_found` when the profile has no link. */
export async function updateLink(profileId: string, patch: { locale?: TelegramLocale; prefs?: Partial<TelegramPrefs> }): Promise<Link> {
  const current = await getLink(profileId);
  if (!current) throw new ApiError('not_found', 'Telegram is not connected');
  const db = await getDb();
  const [row] = await db
    .update(telegramLinks)
    .set({ locale: patch.locale ?? current.locale, prefs: mergePrefs(current.prefs, patch.prefs) })
    .where(eq(telegramLinks.profileId, profileId))
    .returning();
  if (patch.prefs?.lot_watch === false) await db.delete(telegramWatches).where(eq(telegramWatches.profileId, profileId)); // switching lot alerts off ends every watch
  return toLink(row);
}
