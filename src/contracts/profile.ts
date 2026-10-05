/**
 * The signed-in user's public profile: a display name, a short bio and an avatar address, all optional. Those three
 * columns already exist on `profiles`; this is the contract to read and change them. The limits live here so the form and the server agree.
 *
 * Where it shows: the display name appears next to a chat message ("Anna, bidder 7") and as "Sold by" on a seller's room; the bio and the avatar
 * on the account page. Bids, the bid log and the feed keep showing the bidding number only: what a bidder did stays under the number they bid with.
 */
import { z } from 'zod';

export const DISPLAY_NAME_MIN = 2;
export const DISPLAY_NAME_MAX = 32;
export const BIO_MAX = 160;
export const AVATAR_URL_MAX = 300;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
/** An uploaded picture: png, jpeg or webp (no SVG), at most 200 KB. The server checks the magic bytes, not the name or the declared type. */
export const AVATAR_MAX_BYTES = 200 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AvatarType = (typeof AVATAR_TYPES)[number];

export const ProfileView = z
  .object({
    /** Unique without regard to case, 3 to 24 letters, digits or underscores. Shown on the account page; the chat shows the display name (if set) and the bidding number. */
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    bio: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    /** An uploaded picture exists: `GET /api/avatar/<profile id>?v=<version>` serves it (the version changes with every upload, so it can be cached for long). */
    avatar: z.object({ version: z.number().int().nonnegative() }).strict().nullable(),
    /** The profile id (the address of the picture; the wallet stays out of every public answer). */
    id: z.string().uuid(),
    createdAt: z.string(),
    strikes: z.number().int().nonnegative(),
  })
  .strict();
export type ProfileView = z.infer<typeof ProfileView>;

/**
 * A partial update. A field that is absent stays as it is; `null` or an empty string clears it. The raw text is checked and cleaned by the server
 * (`src/server/profile/rules.ts`); the length caps here only stop an oversized body early.
 */
export const ProfileUpdateRequest = z
  .object({
    username: z.string().max(100).nullable().optional(),
    displayName: z.string().max(200).nullable().optional(),
    bio: z.string().max(1000).nullable().optional(),
    avatarUrl: z.string().max(1000).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'at least one field');
export type ProfileUpdateRequest = z.infer<typeof ProfileUpdateRequest>;

export const ProfileResponse = z.object({ profile: ProfileView }).strict();
export type ProfileResponse = z.infer<typeof ProfileResponse>;

/** Why a field was refused: a `validation` error whose body names the `field` and the `rule` (one of these), next to the English `reason` sentence; the form shows its own translated sentence per rule. */
export const PROFILE_FIELDS = ['username', 'displayName', 'bio', 'avatarUrl', 'avatar'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export const PROFILE_REJECT_REASONS = [
  'too_short', 'too_long', 'characters', 'link', 'contact_data', 'reserved', 'avatar_https', 'avatar_host', 'avatar_invalid',
  'taken', 'profane', 'avatar_type', 'avatar_size', 'avatar_empty',
] as const;
export type ProfileRejectReason = (typeof PROFILE_REJECT_REASONS)[number];

/** `GET /api/me/wallet`: the signed-in wallet's own balances. A balance that cannot be read right now is null (never a guess). */
export const WalletResponse = z
  .object({ wallet: z.string(), cluster: z.enum(['devnet', 'mainnet-beta']), sol: z.string().nullable(), usdc: z.string().nullable() })
  .strict();
export type WalletResponse = z.infer<typeof WalletResponse>;

/**
 * `GET /api/me/summary`: what this account has bought and sold, computed from its own settled settlements only (money in USDC base units, 6 dp).
 * Nothing about other people: a settlement shows the lot's name, never the other side.
 */
export const SummaryResponse = z
  .object({
    bought: z.object({ count: z.number().int().nonnegative(), totalGross: z.string(), averageGross: z.string().nullable() }).strict(),
    sold: z
      .object({
        count: z.number().int().nonnegative(),
        totalGross: z.string(),
        totalFees: z.string(),
        totalPayout: z.string(),
        averageGross: z.string().nullable(),
        best: z.object({ lotName: z.string(), gross: z.string() }).strict().nullable(),
      })
      .strict(),
    /** The latest sales, newest first (at most 20). */
    recentSales: z.array(
      z.object({ settlementId: z.string().uuid(), lotName: z.string(), gross: z.string(), fee: z.string(), payout: z.string(), settledAt: z.string().nullable(), explorerUrl: z.string().nullable() }).strict(),
    ),
  })
  .strict();
export type SummaryResponse = z.infer<typeof SummaryResponse>;
